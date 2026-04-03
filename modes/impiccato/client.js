const socket = io('/impiccato');

// [keep-alive Render.com] Pinga il server ogni 4 minuti per evitare il sleep su Render free tier
setInterval(() => {
    fetch(window.location.origin + '/ping')
        .then(() => console.log('[keep-alive] server sveglio'))
        .catch(() => console.warn('[keep-alive] server non raggiungibile'));
}, 4 * 60 * 1000); // ogni 4 minuti

// [keep-alive Render.com] Gestione reconnect automatico dopo disconnessione
socket.on('disconnect', (reason) => {
    console.warn('[socket] disconnesso:', reason);
    if (reason === 'io server disconnect') {
        socket.connect();
    }
});


// Translation helper — falls back gracefully if TranslationManager isn't loaded
function t(key, params = {}) {
    if (typeof TranslationManager !== 'undefined') return TranslationManager.t(key, params);
    return key;
}

let roomCode = null;
let myId = null;
let isHost = false;
let currentWordLength = 5;
let currentLanguage = 'it';
let currentGameMode = 'classic'; // 'classic' or 'playerWord'
let myNickname = null;
let revealedLetters = {};
let guessedLetters = [];
let isWordCreator = false;
let wordCreatorId = null;
let wordCreatorNickname = null;

// Audio elements
const audioWin = document.getElementById('audio-win');
const audioMyTurn = document.getElementById('audio-myturn');
const audioTick = document.getElementById('audio-tick');

// Screen elements
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');
const endModal = document.getElementById('end-modal');
const wordChooserScreen = document.getElementById('word-chooser-screen');
const waitingChooserScreen = document.getElementById('waiting-chooser-screen');

// ======================
// LOBBY FUNCTIONS
// ======================

// Toggle word-length options visibility based on game mode
function updateLobbyModeUI() {
    const mode = document.querySelector('input[name="gameMode"]:checked');
    const wordLengthGroup = document.getElementById('word-length-group');
    if (mode && mode.value === 'playerWord') {
        wordLengthGroup.style.display = 'none';
    } else {
        wordLengthGroup.style.display = 'block';
    }
}

// Attach listeners on load
document.querySelectorAll('input[name="gameMode"]').forEach(radio => {
    radio.addEventListener('change', updateLobbyModeUI);
});

function createRoom() {
    const nickname = document.getElementById('nickname').value.trim();
    myNickname = nickname;
    if (!nickname) {
        document.getElementById('create-error').textContent = t('imp_error_nickname');
        return;
    }

    const wordLength = parseInt(document.querySelector('input[name="wordLength"]:checked').value);
    const language = document.querySelector('input[name="language"]:checked').value;
    const gameMode = document.querySelector('input[name="gameMode"]:checked').value;
    currentWordLength = wordLength;
    currentLanguage = language;
    currentGameMode = gameMode;

    socket.emit('createRoom', { nickname, wordLength, language, gameMode });
}

function joinRoom() {
    const nickname = document.getElementById('nickname').value.trim();
    myNickname = nickname;
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();

    if (!nickname) {
        document.getElementById('join-error').textContent = t('imp_error_nickname');
        return;
    }

    if (!code) {
        document.getElementById('join-error').textContent = t('imp_error_code');
        return;
    }

    socket.emit('joinRoom', { roomCode: code, nickname });
}

function startGame() {
    socket.emit('startGame');
}

// ======================
// SOCKET EVENTS
// ======================

socket.on('connect', () => {
    myId = socket.id;
    console.log('[IMPICCATO] Connected:', myId);

    if (roomCode && myNickname) {
        console.log(`[IMPICCATO] Attempting to auto-reconnect to ${roomCode} as ${myNickname}`);
        socket.emit('joinRoom', { roomCode: roomCode, nickname: myNickname });
    }
});

socket.on('roomCreated', ({ roomCode: code, wordLength, gameMode }) => {
    roomCode = code;
    myId = socket.id;
    isHost = true;
    currentWordLength = wordLength;
    currentGameMode = gameMode || 'classic';

    document.getElementById('display-room-code').textContent = code;
    document.getElementById('start-btn').style.display = 'block';
    document.getElementById('start-btn').textContent = t('imp_btn_start');

    switchScreen(waitingScreen);
});

socket.on('roomJoined', () => { });

socket.on('playerJoined', ({ players, roomCode: code }) => {
    if (code) roomCode = code;
    myId = socket.id;

    updatePlayersList(players);

    if (!isHost) {
        switchScreen(waitingScreen);
    }
});

// === PLAYER-WORD MODE: Word Chooser Selected ===
socket.on('wordChooserSelected', ({ chooserId, chooserNickname, players }) => {
    wordCreatorId = chooserId;
    wordCreatorNickname = chooserNickname;
    isWordCreator = (chooserId === socket.id);

    if (endModal) endModal.classList.remove('active');

    if (isWordCreator) {
        document.getElementById('chooser-error').textContent = '';
        document.getElementById('secret-word-input').value = '';
        document.getElementById('hint-input').value = '';
        switchScreen(wordChooserScreen);
    } else {
        const nameHtml = `<span id="chooser-name-display" class="chooser-highlight">${chooserNickname}</span>`;
        document.getElementById('chooser-name-display-container').innerHTML = t('imp_wait_chooser_subtitle_prefix', { name: nameHtml });
        switchScreen(waitingChooserScreen);
    }
});

function submitSecretWord() {
    const word = document.getElementById('secret-word-input').value.trim();
    const hint = document.getElementById('hint-input').value.trim();

    if (word.length < 4 || word.length > 10) {
        document.getElementById('chooser-error').textContent = t('imp_error_word_length');
        return;
    }

    if (!/^[A-Za-zÀÈÉÌÍÒÓÙÚàèéìíòóùú]+$/.test(word)) {
        document.getElementById('chooser-error').textContent = t('imp_error_word_invalid');
        return;
    }

    socket.emit('submitSecretWord', { word, hint });
}

socket.on('gameStarted', ({ wordLength, language, gameMode, hint, wordCreatorId: creatorId, wordCreatorNickname: creatorNick, players }) => {
    currentWordLength = wordLength;
    currentLanguage = language || 'it';
    currentGameMode = gameMode || 'classic';
    revealedLetters = {};
    guessedLetters = [];
    wordCreatorId = creatorId || null;
    wordCreatorNickname = creatorNick || null;
    isWordCreator = (creatorId === socket.id);

    if (endModal) endModal.classList.remove('active');

    initializeGame(wordLength, players);

    // --- playerWord-specific UI ---
    const hintArea = document.getElementById('hint-area');
    const creatorBadge = document.getElementById('creator-badge');
    const creatorPanel = document.getElementById('creator-panel');
    const keyboardContainer = document.getElementById('keyboard-container');

    if (currentGameMode === 'playerWord') {
        // Hint display
        const hintDisplay = document.getElementById('hint-display');
        if (hintDisplay) hintDisplay.textContent = hint || t('imp_no_hint');

        // Creator name
        const creatorNameEl = document.getElementById('game-creator-name');
        if (creatorNameEl) creatorNameEl.textContent = creatorNick || '';

        if (hintArea) hintArea.style.display = 'block';
        if (creatorBadge) creatorBadge.style.display = 'block';

        if (isWordCreator) {
            if (creatorPanel) creatorPanel.style.display = 'block';
            if (keyboardContainer) keyboardContainer.style.display = 'none';
            const creatorHintInput = document.getElementById('creator-hint-input');
            if (creatorHintInput) creatorHintInput.value = hint || '';
            buildHelperLetterButtons(wordLength);
        } else {
            if (creatorPanel) creatorPanel.style.display = 'none';
            if (keyboardContainer) keyboardContainer.style.display = 'flex';
        }
    } else {
        // Classic mode: hide playerWord elements
        if (hintArea) hintArea.style.display = 'none';
        if (creatorBadge) creatorBadge.style.display = 'none';
        if (creatorPanel) creatorPanel.style.display = 'none';
        if (keyboardContainer) keyboardContainer.style.display = 'flex';
    }

    switchScreen(gameScreen);
});

socket.on('turnUpdate', ({ playerId, playerNickname, timeLeft }) => {
    updateTurnIndicator(playerId, playerNickname);
    updateTimer(timeLeft);

    if (playerId === socket.id) {
        playSound(audioMyTurn);
    }
});

socket.on('timerTick', ({ timeLeft }) => {
    updateTimer(timeLeft);
    if (timeLeft <= 5 && timeLeft > 0) {
        playSound(audioTick);
    }
});

socket.on('letterResult', ({ success, letter, positions, revealedLetters: revealed, message, private: isPrivate, players }) => {
    if (success) {
        revealedLetters = revealed;
        updateWordGrid(positions, letter);
        markKeyAsUsed(letter, 'correct');
        guessedLetters.push(letter);

        if (letter) {
            const count = positions.length;
            const earned = count * 10;
            const msg = count > 1
                ? t('imp_points_multiple', { pts: earned, letter, count })
                : t('imp_points_single', { letter });
            showTemporaryMessage(msg, 'success');
        }

        if (players) updatePlayersStatus(players);

        if (isWordCreator) updateHelperLetterButtons();
    } else {
        if (isPrivate) {
            showTemporaryMessage(message || t('imp_letter_absent'), 'error');
            markKeyAsUsed(letter, 'incorrect');
            guessedLetters.push(letter);
        }
    }
});

socket.on('opponentGuessed', ({ playerId, wasCorrect }) => {
    console.log(`Player ${playerId} guessed. Correct: ${wasCorrect}`);
});

// Hint updated (playerWord mode)
socket.on('hintUpdated', ({ hint }) => {
    const hintDisplay = document.getElementById('hint-display');
    if (hintDisplay) hintDisplay.textContent = hint || t('imp_no_hint');
    showTemporaryMessage(t('imp_hint_updated_msg'), 'info');
});

// Helper letter revealed (playerWord mode)
socket.on('helperLetterRevealed', ({ letter, positions, revealedLetters: revealed }) => {
    revealedLetters = revealed;
    updateWordGrid(positions, letter);
    markKeyAsUsed(letter, 'correct');
    if (!guessedLetters.includes(letter)) guessedLetters.push(letter);
    showTemporaryMessage(t('imp_creator_revealed_msg', { letter }), 'info');
    if (isWordCreator) updateHelperLetterButtons();
});

socket.on('roundEnded', ({ winnerId, winnerNickname, secretWord, winnerScore, players }) => {
    showWinModal(winnerNickname, secretWord, winnerId === socket.id, winnerScore);
    updatePlayersStatus(players);
    renderLeaderboard(players);

    if (winnerId === socket.id) {
        playSound(audioWin);
    }
});

socket.on('newHost', ({ hostId }) => {
    isHost = (hostId === socket.id);
    if (isHost) {
        document.getElementById('host-options').style.display = 'block';
        document.getElementById('modal-waiting-msg').style.display = 'none';
    }
});

socket.on('playerLeft', ({ playerId, players, secretWord }) => {
    updatePlayersList(players);
    updatePlayersStatus(players);

    if (document.getElementById('game-screen').classList.contains('active') && players.length === 1) {
        showWinModal(secretWord || "???", "VITTORIA A TAVOLINO");
        const modalTitle = document.getElementById('modal-title');
        const modalSubtitle = document.getElementById('modal-subtitle');
        const modalWord = document.getElementById('modal-word');

        if (modalTitle) modalTitle.textContent = t('imp_walkover_title');
        if (modalSubtitle) modalSubtitle.innerHTML = t('imp_walkover_subtitle');
        if (modalWord && secretWord) modalWord.textContent = secretWord;
    } else if (document.getElementById('game-screen').classList.contains('active')) {
        showTemporaryMessage(t('imp_player_left'), 'error');
    }
});

socket.on('playerReconnected', ({ oldId, newId, nickname, players }) => {
    console.log(`[IMPICCATO] ${nickname} reconnected.`);
    showTemporaryMessage(t('imp_player_reconnected', { name: nickname }), 'success');

    if (document.getElementById('game-screen').classList.contains('active')) {
        updatePlayersStatus(players);
    } else {
        updatePlayersList(players);
    }
});

socket.on('playerDisconnected', ({ playerId, nickname }) => {
    showTemporaryMessage(t('imp_player_disconnected', { name: nickname }), 'error');
});

socket.on('reconnectSuccess', ({ roomCode: code, config, isHost: wasHost, gameState, players }) => {
    roomCode = code;
    isHost = wasHost;
    currentWordLength = config.wordLength;
    currentLanguage = config.language || 'it';
    currentGameMode = config.gameMode || 'classic';

    if (gameState.status === 'lobby') {
        updatePlayersList(players);
        document.getElementById('display-room-code').textContent = code;
        document.getElementById('start-btn').style.display = isHost ? 'block' : 'none';
        document.getElementById('start-btn').textContent = t('imp_btn_start');
        switchScreen(waitingScreen);

    } else if (gameState.status === 'choosingWord') {
        wordCreatorId = gameState.wordCreatorId;
        wordCreatorNickname = gameState.wordCreatorNickname;
        isWordCreator = (gameState.wordCreatorId === socket.id);

        if (isWordCreator) {
            document.getElementById('chooser-error').textContent = '';
            document.getElementById('secret-word-input').value = '';
            document.getElementById('hint-input').value = '';
            switchScreen(wordChooserScreen);
        } else {
            const nameHtml = `<span id="chooser-name-display" class="chooser-highlight">${wordCreatorNickname}</span>`;
            document.getElementById('chooser-name-display-container').innerHTML = t('imp_wait_chooser_subtitle_prefix', { name: nameHtml });
            switchScreen(waitingChooserScreen);
        }

    } else if (gameState.status === 'playing') {
        wordCreatorId = gameState.wordCreatorId;
        wordCreatorNickname = gameState.wordCreatorNickname;
        isWordCreator = (currentGameMode === 'playerWord' && gameState.wordCreatorId === socket.id);

        revealedLetters = gameState.revealedLetters || {};
        guessedLetters = gameState.guessedLetters || [];

        if (endModal) endModal.classList.remove('active');

        // Derive word length
        if (currentGameMode === 'classic') {
            // Classic: use config wordLength
        } else {
            // playerWord: derive from secretWord length or revealed keys
            if (gameState.secretWord) {
                currentWordLength = gameState.secretWord.length;
            } else if (Object.keys(revealedLetters).length > 0) {
                const maxPos = Math.max(...Object.keys(revealedLetters).map(Number));
                if (maxPos + 1 > currentWordLength) currentWordLength = maxPos + 1;
            }
        }

        initializeGame(currentWordLength, players);

        // Restore grid
        Object.keys(revealedLetters).forEach(pos => {
            updateWordGrid([parseInt(pos)], revealedLetters[pos]);
        });

        // Restore keyboard
        guessedLetters.forEach(letter => {
            const isCorrect = Object.values(revealedLetters).includes(letter);
            markKeyAsUsed(letter, isCorrect ? 'correct' : 'incorrect');
        });

        // playerWord-specific UI restore
        const hintArea = document.getElementById('hint-area');
        const creatorBadge = document.getElementById('creator-badge');
        const creatorPanel = document.getElementById('creator-panel');
        const keyboardContainer = document.getElementById('keyboard-container');

        if (currentGameMode === 'playerWord') {
            const hintDisplay = document.getElementById('hint-display');
            if (hintDisplay) hintDisplay.textContent = gameState.hint || t('imp_no_hint');

            const creatorNameEl = document.getElementById('game-creator-name');
            if (creatorNameEl) creatorNameEl.textContent = wordCreatorNickname;

            if (hintArea) hintArea.style.display = 'block';
            if (creatorBadge) creatorBadge.style.display = 'block';

            if (isWordCreator) {
                if (creatorPanel) creatorPanel.style.display = 'block';
                if (keyboardContainer) keyboardContainer.style.display = 'none';
                const creatorHintInput = document.getElementById('creator-hint-input');
                if (creatorHintInput) creatorHintInput.value = gameState.hint || '';
                buildHelperLetterButtons(currentWordLength);
                updateHelperLetterButtons();
            } else {
                if (creatorPanel) creatorPanel.style.display = 'none';
                if (keyboardContainer) keyboardContainer.style.display = 'flex';
            }
        } else {
            if (hintArea) hintArea.style.display = 'none';
            if (creatorBadge) creatorBadge.style.display = 'none';
            if (creatorPanel) creatorPanel.style.display = 'none';
            if (keyboardContainer) keyboardContainer.style.display = 'flex';
        }

        switchScreen(gameScreen);

        if (gameState.currentPlayerId) {
            const currentPlayer = players.find(p => p.id === gameState.currentPlayerId);
            updateTurnIndicator(gameState.currentPlayerId, currentPlayer ? currentPlayer.nickname : 'Avversario');
            updateTimer(gameState.timeLeft || 30);
        }

    } else if (gameState.status === 'ended') {
        renderLeaderboard(players);
        switchScreen(waitingScreen);
        updatePlayersList(players);
    }
});

socket.on('error', (message) => {
    const chooserError = document.getElementById('chooser-error');
    if (wordChooserScreen && wordChooserScreen.classList.contains('active') && chooserError) {
        chooserError.textContent = message;
    } else {
        alert(message);
    }
});

// ======================
// GAME FUNCTIONS
// ======================

function initializeGame(wordLength, players) {
    const wordGrid = document.getElementById('word-grid');
    wordGrid.innerHTML = '';
    wordGrid.style.setProperty('--word-len', wordLength);

    for (let i = 0; i < wordLength; i++) {
        const box = document.createElement('div');
        box.className = 'letter-box empty';
        box.dataset.index = i;
        wordGrid.appendChild(box);
    }

    const keyboard = document.getElementById('keyboard');
    keyboard.innerHTML = '';

    const rows = [
        ['Q','W','E','R','T','Y','U','I','O','P'],
        ['A','S','D','F','G','H','J','K','L'],
        ['Z','X','C','V','B','N','M']
    ];

    rows.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'keyboard-row';
        row.forEach(letter => {
            const key = document.createElement('div');
            key.className = 'key';
            key.textContent = letter;
            key.dataset.letter = letter;
            key.addEventListener('click', () => submitLetter(letter));
            rowDiv.appendChild(key);
        });
        keyboard.appendChild(rowDiv);
    });

    updatePlayersStatus(players);
}

function buildHelperLetterButtons(wordLength) {
    const container = document.getElementById('helper-letters-container');
    if (!container) return;
    container.innerHTML = '';

    for (let i = 0; i < wordLength; i++) {
        const btn = document.createElement('button');
        btn.className = 'helper-letter-btn';
        btn.textContent = `${i + 1}`;
        btn.dataset.position = i;
        btn.addEventListener('click', () => {
            socket.emit('revealHelperLetter', i);
        });
        container.appendChild(btn);
    }
}

function updateHelperLetterButtons() {
    const container = document.getElementById('helper-letters-container');
    if (!container) return;

    const buttons = container.querySelectorAll('.helper-letter-btn');
    buttons.forEach(btn => {
        const pos = parseInt(btn.dataset.position);
        if (revealedLetters[pos]) {
            btn.textContent = revealedLetters[pos];
            btn.classList.add('revealed');
            btn.disabled = true;
        }
    });
}

function sendHintUpdate() {
    const creatorHintInput = document.getElementById('creator-hint-input');
    if (creatorHintInput) {
        socket.emit('updateHint', creatorHintInput.value.trim());
    }
}

function submitLetter(letter) {
    if (currentGameMode === 'playerWord' && isWordCreator) return;

    const key = document.querySelector(`.key[data-letter="${letter}"]`);
    if (guessedLetters.includes(letter) || key.classList.contains('disabled')) {
        return;
    }

    socket.emit('submitLetter', letter);
}

function updateWordGrid(positions, letter) {
    positions.forEach(pos => {
        const box = document.querySelector(`.letter-box[data-index="${pos}"]`);
        if (box) {
            box.textContent = letter;
            box.classList.remove('empty');
            box.classList.add('revealed');
        }
    });
}

function markKeyAsUsed(letter, status) {
    const key = document.querySelector(`.key[data-letter="${letter}"]`);
    if (key) {
        key.classList.add('disabled', status);
    }
}

function updateTurnIndicator(playerId, playerNickname) {
    const indicator = document.getElementById('turn-indicator');

    if (currentGameMode === 'playerWord' && isWordCreator) {
        indicator.textContent = `🎯 Turno di: ${playerNickname || 'Avversario'}`;
        indicator.classList.remove('your-turn');
    } else if (playerId === socket.id) {
        indicator.textContent = t('imp_your_turn');
        indicator.classList.add('your-turn');
    } else {
        indicator.textContent = t('imp_opponent_turn', { name: playerNickname || 'Avversario' });
        indicator.classList.remove('your-turn');
    }
}

function updateTimer(seconds) {
    const timer = document.getElementById('timer');
    timer.textContent = seconds;

    if (seconds <= 5) {
        timer.classList.add('warning');
    } else {
        timer.classList.remove('warning');
    }
}

function updatePlayersStatus(players) {
    const playersStatus = document.getElementById('players-status');
    playersStatus.innerHTML = '';

    const sortedPlayers = [...players].sort((a, b) => b.score - a.score);

    sortedPlayers.forEach((player, index) => {
        const item = document.createElement('div');
        item.className = 'player-status-item';

        let badge = '';
        if (currentGameMode === 'playerWord' && player.id === wordCreatorId) badge = ' ✍️';
        if (player.id === socket.id) badge += ' ' + t('imp_you_label');

        item.innerHTML = `
            <span class="player-name">${index + 1}. ${player.nickname}${badge}</span>
            <span class="player-score">🏆 ${player.score || 0}</span>
        `;
        playersStatus.appendChild(item);
    });
}

function updatePlayersList(players) {
    const playersList = document.getElementById('players-list');
    playersList.innerHTML = `<h3>${t('imp_players_label')}</h3>`;

    players.forEach(player => {
        const item = document.createElement('div');
        item.className = 'player-item';
        if (player.id === myId && isHost) {
            item.classList.add('host');
        }
        item.textContent = player.nickname;
        playersList.appendChild(item);
    });
}

function showWinModal(winnerNickname, secretWord, isWinner, winnerScore) {
    document.getElementById('modal-winner').textContent = winnerNickname;
    document.getElementById('modal-word').textContent = secretWord;

    const scoreEl = document.getElementById('modal-score');
    if (scoreEl) {
        if (winnerScore !== undefined && winnerScore > 0) {
            scoreEl.textContent = isWinner
                ? t('imp_score_winner', { score: winnerScore })
                : t('imp_score_loser', { name: winnerNickname, score: winnerScore });
            scoreEl.style.display = 'block';
        } else {
            scoreEl.style.display = 'none';
        }
    }

    // Show host options (word length selector only relevant for classic mode)
    if (isHost) {
        document.getElementById('host-options').style.display = 'block';
        document.getElementById('modal-waiting-msg').style.display = 'none';

        // Show/hide word length and language selectors based on mode
        const nextLengthEl = document.getElementById('next-length-container');
        if (nextLengthEl) {
            nextLengthEl.style.display = (currentGameMode === 'classic') ? 'block' : 'none';
        }

        const nextLanguageEl = document.getElementById('next-language-container');
        if (nextLanguageEl) {
            nextLanguageEl.style.display = (currentGameMode === 'classic') ? 'block' : 'none';
        }
    } else {
        document.getElementById('host-options').style.display = 'none';
        document.getElementById('modal-waiting-msg').style.display = 'block';
    }

    endModal.classList.add('active');
}

function renderLeaderboard(players) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const body = sorted.map((p, i) =>
        `<tr>
            <td>#${i + 1}</td>
            <td>${p.id === socket.id ? '⭐ ' : ''}${p.nickname}</td>
            <td>${p.score} pt</td>
        </tr>`
    ).join('');

    let lb = document.getElementById('leaderboard');
    if (!lb) {
        lb = document.createElement('div');
        lb.id = 'leaderboard';
        const controls = document.getElementById('modal-controls');
        if (controls) controls.parentNode.insertBefore(lb, controls);
    }
    lb.innerHTML =
        `<table>
            <thead><tr><th>${t('imp_table_rank')}</th><th>${t('imp_table_player')}</th><th>${t('imp_table_points')}</th></tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

function nextRound() {
    endModal.classList.remove('active');

    let configUpdate = {};
    if (isHost) {
        if (currentGameMode === 'classic') {
            const selectedLength = parseInt(document.getElementById('next-length-modal').value);
            configUpdate.wordLength = selectedLength;
            currentWordLength = selectedLength;
        }
        const selectedLanguage = document.getElementById('next-language-modal').value;
        configUpdate.language = selectedLanguage;
        currentLanguage = selectedLanguage;
    }

    socket.emit('nextRound', configUpdate);
}

// ======================
// UTILITY FUNCTIONS
// ======================

function switchScreen(targetScreen) {
    document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
    targetScreen.classList.add('active');
}

function showTemporaryMessage(message, type = 'info') {
    const existingMsg = document.querySelector('.temp-message');
    if (existingMsg) existingMsg.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `temp-message ${type}`;
    msgDiv.textContent = message;
    msgDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${type === 'error' ? '#ff4444' : type === 'success' ? '#00ff88' : '#00d4ff'};
        color: #1a1a2e;
        padding: 15px 30px;
        border-radius: 10px;
        font-weight: bold;
        z-index: 2000;
        animation: slideDown 0.3s ease-out;
    `;

    document.body.appendChild(msgDiv);

    setTimeout(() => {
        msgDiv.style.animation = 'slideUp 0.3s ease-out';
        setTimeout(() => msgDiv.remove(), 300);
    }, 2000);
}

function playSound(audio) {
    if (audio) {
        audio.currentTime = 0;
        audio.play().catch(e => console.log('Audio play failed:', e));
    }
}

// Add CSS for message animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideDown {
        from {
            transform: translateX(-50%) translateY(-100%);
            opacity: 0;
        }
        to {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
    }
    @keyframes slideUp {
        from {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
        to {
            transform: translateX(-50%) translateY(-100%);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Physical keyboard support
document.addEventListener('keydown', (e) => {
    if (gameScreen.classList.contains('active')) {
        if (currentGameMode === 'playerWord' && isWordCreator) return;
        const letter = e.key.toUpperCase();
        if (/^[A-Z]$/.test(letter)) {
            submitLetter(letter);
        }
    }
});

// Home button in game screen
const btnHomeGame = document.getElementById('btn-home-game');
if (btnHomeGame) {
    btnHomeGame.addEventListener('click', () => {
        if (confirm(t('imp_confirm_home'))) location.href = '../../index.html';
    });
}

// ======================
// INVITE LINK SHARING
// ======================

function shareInviteLink() {
    if (!roomCode) return;
    const url = `${window.location.origin}${window.location.pathname}?join=${roomCode}`;
    const text = `Join my Impiccato game! Room: ${roomCode}`;

    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: 'Impiccato', text, url }).catch(() => {});
    } else {
        let container = document.getElementById('invite-link-display');
        if (!container) {
            container = document.createElement('div');
            container.id = 'invite-link-display';
            container.style.marginTop = '15px';
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'center';
            container.style.gap = '10px';
            container.style.background = 'rgba(0,0,0,0.3)';
            container.style.padding = '10px';
            container.style.borderRadius = '8px';
            container.style.border = '1px solid rgba(255,255,255,0.2)';
            container.style.width = '100%';
            container.style.maxWidth = '400px';

            const input = document.createElement('input');
            input.type = 'text';
            input.readOnly = true;
            input.value = url;
            input.style.flex = '1';
            input.style.background = 'transparent';
            input.style.border = 'none';
            input.style.color = '#ffd200';
            input.style.fontSize = '0.9rem';
            input.style.outline = 'none';
            input.style.textAlign = 'center';
            input.onclick = () => input.select();

            const copyBtn = document.createElement('button');
            copyBtn.textContent = '📋 Copia';
            copyBtn.style.margin = '0';
            copyBtn.style.padding = '6px 12px';
            copyBtn.style.fontSize = '0.9rem';
            copyBtn.style.background = '#444';
            copyBtn.style.border = 'none';
            copyBtn.style.borderRadius = '6px';
            copyBtn.style.color = '#fff';
            copyBtn.style.cursor = 'pointer';

            copyBtn.onclick = () => {
                navigator.clipboard.writeText(url).then(() => {
                    showTemporaryMessage('📋 Link copiato!', 'success');
                });
            };

            container.appendChild(input);
            container.appendChild(copyBtn);

            const shareBtn = document.getElementById('share-invite-btn');
            if (shareBtn && shareBtn.parentNode) {
                shareBtn.parentNode.insertBefore(container, shareBtn.nextSibling);
            }
        } else {
            const inp = container.querySelector('input');
            if (inp) {
                inp.value = url;
                inp.select();
            }
        }

        navigator.clipboard.writeText(url).then(() => {
            showTemporaryMessage('📋 Link copiato!', 'success');
        }).catch(() => {});
    }
}

// Auto-fill room code from URL param
(function autoJoinFromURL() {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) {
        const codeInput = document.getElementById('room-code-input');
        if (codeInput) codeInput.value = joinCode.toUpperCase();
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname);
    }
})();

// ======================
// ROOM PERSISTENCE (keepalive when backgrounded)
// ======================

let keepAliveInterval = null;

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page went to background — send keepalive pings
        if (!keepAliveInterval && roomCode) {
            keepAliveInterval = setInterval(() => {
                if (socket.connected) {
                    socket.emit('ping');
                }
            }, 25000);
        }
    } else {
        // Page came back to foreground
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        // Force reconnect if disconnected
        if (!socket.connected && roomCode && myNickname) {
            socket.connect();
        }
    }
});
