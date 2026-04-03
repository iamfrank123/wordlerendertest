const socket = io('/parole_xl');

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


// Translation helper
function t(key, params = {}) {
    if (typeof TranslationManager !== 'undefined') return TranslationManager.t(key, params);
    return key;
}

// State
let myId = null;
let currentRoom = null;
let isHost = false;
let currentLength = 5;
let currentLanguage = 'it';
let myTurn = false;
let currentRow = 0;
let currentGuess = '';
let grid = []; // Array of {letter, status}
let maxRows = 6;
let timerInterval = null;
let currentMode = 'turns';

// DOM Elements
const screens = document.querySelectorAll('.screen');
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');
const endScreen = document.getElementById('end-screen');

// Audio Elements
let audioWin, audioMyTurn, audioTick;

// Emoji Reactions
let myNickname = '';
let playerNicknames = {}; // Map of playerId -> nickname

// Initialize audio after DOM loads
window.addEventListener('DOMContentLoaded', () => {
    audioWin = document.getElementById('audio-win');
    audioMyTurn = document.getElementById('audio-myturn');
    audioTick = document.getElementById('audio-tick');

    // Initialize emoji reaction buttons
    initEmojiReactions();
});

// --- NAVIGATION ---
function showScreen(id) {
    screens.forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// --- LOBBY ---
document.querySelectorAll('.checkbox-label').forEach(label => {
    label.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') {
            e.target.parentElement.classList.toggle('checked', e.target.checked);
        }
    });
});

function createRoom() {
    const nickname = document.getElementById('nickname').value || 'Host';
    const lengths = [];
    document.querySelectorAll('#length-options input:checked').forEach(cb => lengths.push(parseInt(cb.value)));

    if (lengths.length === 0) {
        document.getElementById('create-error').innerText = t('xl_error_length');
        return;
    }

    const gameMode = document.querySelector('input[name="gameMode"]:checked').value;
    const language = document.querySelector('input[name="language"]:checked').value;
    currentLanguage = language;

    const config = {
        nickname,
        selectedLengths: lengths,
        gameMode,
        language,
        shuffle: document.getElementById('shuffle-mode').checked,
        // timerEnabled implies turns, handled by server
    };

    socket.emit('createRoom', config);
}

function joinRoom() {
    const nickname = document.getElementById('nickname').value || 'Player';
    const code = document.getElementById('room-code-input').value.toUpperCase();

    if (!code) {
        document.getElementById('join-error').innerText = t('xl_error_code');
        return;
    }

    socket.emit('joinRoom', { roomCode: code, nickname });
}

// --- SOCKET EVENTS ---
socket.on('connect', () => {
    myId = socket.id;
    console.log("Connected", myId);

    // Auto-reconnect if we drop and reconnect while window is open
    const nicknameInput = document.getElementById('nickname');
    const nickname = nicknameInput ? nicknameInput.value.trim() : null;

    if (currentRoom && nickname) {
        console.log(`[PAROLE-XL] Attempting to auto-reconnect to ${currentRoom} as ${nickname}`);
        socket.emit('joinRoom', { roomCode: currentRoom, nickname: nickname });
    }
});

socket.on('roomCreated', (data) => {
    currentRoom = data.roomCode;
    isHost = true;
    enterWaitingRoom();
});

socket.on('playerJoined', (data) => {
    // data.players is array
    updatePlayerList(data.players);

    // Update nickname map for emoji reactions
    data.players.forEach(p => {
        playerNicknames[p.id] = p.nickname;
        if (p.id === myId) {
            myNickname = p.nickname;
        }
    });

    if (!isHost && !currentRoom) {
        // I just joined
        currentRoom = document.getElementById('room-code-input').value.toUpperCase(); // Simplification
        enterWaitingRoom();
    }
});

socket.on('playerLeft', (data) => {
    // data.players is the updated list
    updatePlayerList(data.players);

    if (gameActive) {
        if (data.players.length === 1) {
            // Only me left
            const modal = document.getElementById('end-modal');
            const modalTitle = document.getElementById('modal-title');
            const modalSubtitle = document.getElementById('modal-subtitle');

            modal.classList.add('active');
            if (modalTitle) modalTitle.textContent = t('xl_walkover_title');
            if (modalSubtitle) {
                modalSubtitle.innerHTML = t('xl_walkover_subtitle') + "<strong>" + (data.secretWord || "???") + "</strong>";
            }

            const btnNewGame = document.getElementById('btn-new-game');
            if (btnNewGame) btnNewGame.style.display = 'none';
        } else {
            showToast(t('xl_player_left_toast'), "#ff4444");
        }
    }
});

socket.on('playerReconnected', ({ oldId, newId, nickname, players }) => {
    console.log(`[PAROLE-XL] ${nickname} reconnected.`);
    showToast(t('xl_player_reconnected', { name: nickname }), "#00ff88");
    updatePlayerList(players);
});

socket.on('playerDisconnected', ({ playerId, nickname }) => {
    showToast(t('xl_player_disconnected', { name: nickname }), "#ffaa00");
});

socket.on('reconnectSuccess', ({ roomCode: code, config, isHost: wasHost, gameState, players, myGrid }) => {
    currentRoom = code;
    isHost = wasHost;

    if (gameState.status === 'lobby') {
        updatePlayerList(players);
        enterWaitingRoom();
    } else if (gameState.status === 'playing') {
        // We are resuming a game
        currentLength = gameState.wordLength;
        currentMode = config.gameMode || 'turns';
        currentLanguage = config.language || 'it';

        myTurn = (gameState.currentTurnPlayerId === myId);

        document.getElementById('current-length').innerText = currentLength;

        // Hide modal
        const endModal = document.getElementById('end-modal');
        if (endModal) endModal.classList.remove('active');

        // Fully restore Grid state
        const container = document.getElementById('grid-container');
        container.innerHTML = '';
        container.style.setProperty('--word-len', currentLength);
        currentRow = 0;
        currentGuess = '';

        myGrid.forEach((attempt, index) => {
            currentRow = index;
            createNewRow(currentRow);

            // Fill row with letters and colors
            for (let i = 0; i < currentLength; i++) {
                const box = document.getElementById(`box-${currentRow}-${i}`);
                if (box) {
                    box.innerText = attempt.word[i];
                    box.classList.add(attempt.feedback[i]);
                }
            }
        });

        // Advance to next empty row for typing
        currentRow = myGrid.length;
        createNewRow(currentRow);

        initKeyboard(); // Restores letters

        // Re-color keyboard based on past grid inputs
        myGrid.forEach(attempt => {
            attempt.word.split('').forEach((letter, i) => {
                const key = document.getElementById(`key-${letter}`);
                if (key && !key.classList.contains('correct')) {
                    if (attempt.feedback[i] === 'correct') {
                        key.classList.remove('present', 'absent');
                        key.classList.add('correct');
                    } else if (attempt.feedback[i] === 'present') {
                        key.classList.remove('absent');
                        key.classList.add('present');
                    } else if (attempt.feedback[i] === 'absent' && !key.classList.contains('present')) {
                        key.classList.add('absent');
                    }
                }
            });
        });

        updatePlayerList(players);
        showScreen('game-screen');

        // UI modes specific state
        if (currentMode === 'realtime') {
            document.getElementById('turn-indicator').innerText = t('xl_turn_realtime');
            document.getElementById('turn-indicator').style.color = "var(--primary-color)";
            document.getElementById('timer').innerText = "∞";
            myTurn = true;
            document.getElementById('leaderboard-sidebar').style.display = 'flex';
            document.getElementById('opponent-status').style.display = 'none';
        } else {
            document.getElementById('leaderboard-sidebar').style.display = 'none';
            document.getElementById('opponent-status').style.display = 'block';

            const indicator = document.getElementById('turn-indicator');
            if (myTurn) {
                indicator.innerText = t('xl_turn_your');
                indicator.style.color = "var(--primary-color)";
            } else {
                indicator.innerText = t('xl_turn_opponents');
                indicator.style.color = "gray";
            }
        }
    } else if (gameState.status === 'ended') {
        updatePlayerList(players);
        enterWaitingRoom();
    }
});

function showToast(msg, color) {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.background = color || '#ff4444';
    toast.style.color = (color === '#00ff88') ? '#1a1a2e' : 'white';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '5px';
    toast.style.zIndex = '3000';
    toast.style.fontWeight = 'bold';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

socket.on('error', (msg) => {
    alert(msg);
});

function enterWaitingRoom() {
    showScreen('waiting-screen');
    document.getElementById('display-room-code').innerText = currentRoom;
    if (isHost) {
        document.getElementById('start-btn').style.display = 'block';
    }
}

function updatePlayerList(players) {
    const list = document.getElementById('players-list');
    list.innerHTML = '';

    // Also update opponent list for game
    const oppList = document.getElementById('opponent-list');
    oppList.innerHTML = '';

    players.forEach(p => {
        const div = document.createElement('div');
        div.innerText = `${p.nickname} ${p.id === myId ? t('xl_you_label') : ''}`;
        div.style.padding = "10px";
        div.style.background = "rgba(255,255,255,0.1)";
        div.style.marginBottom = "5px";
        list.appendChild(div);

        // Opponent list
        if (p.id !== myId) {
            const oppCard = document.createElement('div');
            oppCard.className = 'player-card';
            oppCard.id = `opp-${p.id}`;
            oppCard.innerHTML = `<div class="player-name">${p.nickname}</div><div class="opp-info">Score: ${p.score || 0}</div><div class="opp-status">${t('xl_opp_status_waiting')}</div>`;
            oppList.appendChild(oppCard);
        }
    });

    // UPDATE LEADERBOARD (Race Mode)
    updateLeaderboard(players);
}

function updateLeaderboard(players) {
    const lbSidebar = document.getElementById('leaderboard-sidebar');
    const lbList = document.getElementById('leaderboard-list');

    // Only show in Realtime Mode
    if (currentMode === 'realtime') {
        lbSidebar.style.display = 'flex';
        // Hide legacy opponent status if desired, or keep it as secondary
        document.getElementById('opponent-status').style.display = 'none';

        // Sort players by score (descending)
        // Note: players array might not have latest scores if not synced via 'playerJoined', 
        // but 'scoreUpdate' will handle live updates. 
        // We need a local state of scores if we want to sort accurately here.
        // Let's rely on 'scoreUpdate' to do the heavy lifting of sorting, 
        // or ensure 'players' has scores.

        // Use a local map or the passed players array?
        // The passed 'players' array from 'playerJoined' usually has scores.

        const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0)); // 'score' here is usually "rounds won", NOT green letters. 
        // WAIT. The user wants "Green Letters" leaderboard. 
        // The 'score' in `playerJoined` is total wins.
        // We need a separate structure for "Current Round Green Count".

        // On 'playerJoined' or 'gameStarted', we reset Green Counts to 0.
        // We need a global `liveScores` map: playerId -> greenCount.
    } else {
        lbSidebar.style.display = 'none';
        document.getElementById('opponent-status').style.display = 'block';
    }
}

// Global live scores map
let liveScores = {};

// In gameStarted, reset liveScores
// ... inside socket.on('gameStarted') ...
// liveScores = {}; players.forEach(p => liveScores[p.id] = 0);
// updateLeaderboardRender();

function renderLeaderboard() {
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = '';

    // Convert liveScores to array and sort
    // We need nicknames. 'playerNicknames' map was populated earlier.
    const sorted = Object.keys(playerNicknames).map(id => ({
        id: id,
        nickname: playerNicknames[id],
        score: liveScores[id] || 0
    })).sort((a, b) => b.score - a.score);

    sorted.forEach((p, index) => {
        const item = document.createElement('div');
        item.className = `leaderboard-item ${p.id === myId ? 'is-me' : ''}`;
        item.innerHTML = `
            <div class="lb-rank">${index + 1}.</div>
            <div class="lb-name">${p.nickname} ${p.id === myId ? t('xl_you_label') : ''}</div>
            <div class="lb-score">${p.score}/${currentLength}</div>
        `;
        list.appendChild(item);
    });
}


function startGame() {
    socket.emit('startGame');
}

socket.on('gameStarted', (data) => {
    // Hide modal immediately if visible
    const endModal = document.getElementById('end-modal');
    if (endModal) endModal.classList.remove('active');

    currentLength = data.wordLength;
    currentLanguage = data.language || 'it';
    currentMode = data.gameMode || 'turns';
    maxRows = 6;
    currentRow = 0;
    currentGuess = '';
    grid = [];

    document.getElementById('current-length').innerText = currentLength;
    initGrid();
    initKeyboard();
    showScreen('game-screen');

    // Reset opponent status
    data.players.forEach(p => {
        if (p.id !== myId) {
            const card = document.getElementById(`opp-${p.id}`);
            if (card) {
                if (currentMode === 'realtime') {
                    // Change structure for realtime score
                    card.innerHTML = `<div class="player-name">${p.nickname}</div><div class="big-score" id="score-${p.id}">0/${currentLength}</div>`;
                } else {
                    // Turn based
                    card.querySelector('.opp-info').innerText = "Score: " + (p.score || 0); // Or status
                    card.querySelector('.opp-status').innerText = "In gioco";
                }
            }
        }
    });

    // Reset liveScores
    liveScores = {};
    data.players.forEach(p => liveScores[p.id] = 0);
    renderLeaderboard();

    if (currentMode === 'realtime') {
        myTurn = true;
        document.getElementById('turn-indicator').innerText = t('xl_turn_realtime');
        document.getElementById('turn-indicator').style.color = "var(--primary-color)";
        document.getElementById('timer').innerText = "∞";

        // Show Leaderboard
        document.getElementById('leaderboard-sidebar').style.display = 'flex';
        document.getElementById('opponent-status').style.display = 'none';
    } else {
        document.getElementById('leaderboard-sidebar').style.display = 'none';
        document.getElementById('opponent-status').style.display = 'block';
    }
});

socket.on('turnUpdate', (data) => {
    if (currentMode === 'realtime') return;
    const isMe = data.playerId === myId;
    myTurn = isMe;
    const indicator = document.getElementById('turn-indicator');

    if (isMe) {
        indicator.innerText = t('xl_turn_your');
        indicator.style.color = "var(--primary-color)";
        // Play turn sound
        if (audioMyTurn) {
            audioMyTurn.currentTime = 0;
            audioMyTurn.play().catch(e => console.log('Audio play failed:', e));
        }
    } else {
        indicator.innerText = t('xl_turn_opponents');
        indicator.style.color = "gray";
    }

    // Timer
    if (data.timeLeft !== null) {
        startTimer(data.timeLeft);
    } else {
        document.getElementById('timer').innerText = "--:--";
    }
});

function startTimer(seconds) {
    if (timerInterval) clearInterval(timerInterval);
    let t = seconds;
    const el = document.getElementById('timer');
    el.innerText = t;
    let tickPlayed = false; // Flag to ensure tick plays only once
    timerInterval = setInterval(() => {
        t--;
        el.innerText = t;

        // Play tick sound at exactly 7 seconds before timeout (38 seconds for 45s timer)
        if (t === 7 && !tickPlayed && audioTick) {
            tickPlayed = true;
            audioTick.currentTime = 0;
            audioTick.play().catch(e => console.log('Audio play failed:', e));
        }

        if (t <= 0) clearInterval(timerInterval);
    }, 1000);
}

socket.on('scoreUpdate', (data) => {
    // Update global state
    liveScores[data.playerId] = data.greenCount;
    renderLeaderboard();

    // Legacy support (optional, or remove)
    const scoreEl = document.getElementById(`score-${data.playerId}`);
    if (scoreEl) {
        scoreEl.innerText = `${data.greenCount}/${data.totalLength}`;
        if (data.won) {
            scoreEl.innerText = "VITTORIA!";
            scoreEl.style.color = "gold";
        }
    }
});

socket.on('guessResult', (data) => {
    if (data.playerId === myId) {
        // My result
        updateMyGrid(data.word, data.feedback);
    } else {
        if (currentMode === 'turns') {
            // Shared Grid: Show opponent guess on MY grid 
            updateMyGrid(data.word, data.feedback);
        }

        // Update generic status text if card exists (fallback)
        const card = document.getElementById(`opp-${data.playerId}`);
        if (card && currentMode === 'turns') {
            card.querySelector('.opp-status').innerText = t('xl_opp_tried', { word: data.word });
        }
    }
});

socket.on('roundEnded', (data) => {
    // Clear timer interval
    if (timerInterval) clearInterval(timerInterval);

    // Show modal overlay
    const modal = document.getElementById('end-modal');
    modal.classList.add('active');

    // Set word
    document.getElementById('modal-word').innerText = data.secretWord;

    // Set title based on winner
    const isWinner = data.winnerId === myId;
    const winner = data.players ? data.players.find(p => p.id === data.winnerId) : null;
    const winnerName = winner ? winner.nickname : t('msg_opponent');

    if (isWinner) {
        document.getElementById('modal-title').innerText = t('xl_modal_title_win');
        // Play win sound
        if (audioWin) {
            audioWin.currentTime = 0;
            audioWin.play().catch(e => console.log('Audio play failed:', e));
        }
    } else {
        document.getElementById('modal-title').innerText = t('xl_modal_title_other_win', { name: winnerName });
    }

    // Button visibility
    if (isHost) {
        document.getElementById('btn-new-game').style.display = 'block';
        document.getElementById('host-options').style.display = 'block';
        document.getElementById('modal-waiting-msg').style.display = 'none';
    } else {
        document.getElementById('btn-new-game').style.display = 'none';
        document.getElementById('host-options').style.display = 'none';
        document.getElementById('modal-waiting-msg').style.display = 'block';
    }
});

// --- GAME LOGIC ---

function initGrid() {
    const container = document.getElementById('grid-container');
    container.innerHTML = '';
    // Set CSS variable so mobile scaling calc() knows how many letters to fit per row
    container.style.setProperty('--word-len', currentLength);
    // Create just the first row initially
    createNewRow(0);
}

function createNewRow(rowIndex) {
    const container = document.getElementById('grid-container');
    const row = document.createElement('div');
    row.className = 'grid-row';
    for (let c = 0; c < currentLength; c++) {
        const box = document.createElement('div');
        box.className = 'box';
        box.id = `box-${rowIndex}-${c}`;
        row.appendChild(box);
    }
    container.appendChild(row);
    // Scroll the game-area (overflow container) to bottom
    setTimeout(() => {
        const gameArea = document.getElementById('game-area');
        if (gameArea) gameArea.scrollTop = gameArea.scrollHeight;
    }, 50);
}



function initKeyboard() {
    const container = document.getElementById('keyboard');
    container.innerHTML = '';

    const rows = [
        ['Q','W','E','R','T','Y','U','I','O','P'],
        ['A','S','D','F','G','H','J','K','L'],
        ['ENTER','Z','X','C','V','B','N','M','⌫']
    ];

    rows.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'keyboard-row';
        row.forEach(char => {
            const isSpecial = (char === 'ENTER' || char === '⌫');
            const k = createKey(char, isSpecial);
            if (char === 'ENTER') {
                k.onclick = submitGuess;
            } else if (char === '⌫') {
                k.onclick = backspace;
            } else {
                k.onclick = () => handleInput(char);
            }
            rowDiv.appendChild(k);
        });
        container.appendChild(rowDiv);
    });
}

function createKey(char, big) {
    const div = document.createElement('div');
    div.className = `key ${big ? 'big' : ''}`;
    div.innerText = char;
    div.id = `key-${char}`;
    return div;
}

function handleInput(char) {
    if (!myTurn) return;
    if (currentGuess.length < currentLength) {
        currentGuess += char;
        updateCurrentRow();
    }
}

function backspace() {
    if (!myTurn) return;
    if (currentGuess.length > 0) {
        currentGuess = currentGuess.slice(0, -1);
        updateCurrentRow();
    }
}

function updateCurrentRow() {
    for (let i = 0; i < currentLength; i++) {
        const box = document.getElementById(`box-${currentRow}-${i}`);
        box.innerText = currentGuess[i] || '';
        box.classList.add('current-row-box'); // Optional styling
    }
}

function submitGuess() {
    if (!myTurn) return;
    if (currentGuess.length !== currentLength) {
        // Animation?
        return;
    }

    socket.emit('submitGuess', currentGuess);
    // Don't advance row yet, wait for result
}

function updateMyGrid(word, feedback) {
    // word: string, feedback: ['correct', 'absent'...]
    for (let i = 0; i < currentLength; i++) {
        const box = document.getElementById(`box-${currentRow}-${i}`);
        box.innerText = word[i];
        box.classList.add(feedback[i]);

        // Key update
        const key = document.getElementById(`key-${word[i]}`);
        if (key) {
            // Logic for priority: correct > present > absent
            // If already correct, don't change.
            if (!key.classList.contains('correct')) {
                if (feedback[i] === 'correct') {
                    key.classList.remove('present', 'absent');
                    key.classList.add('correct');
                } else if (feedback[i] === 'present' && !key.classList.contains('correct')) {
                    key.classList.remove('absent');
                    key.classList.add('present');
                } else if (feedback[i] === 'absent' && !key.classList.contains('present') && !key.classList.contains('correct')) {
                    key.classList.add('absent');
                }
            }
        }
    }
    currentRow++;
    createNewRow(currentRow);
    currentGuess = '';
}

// Host controls
function nextRound() {
    const lenSelect = document.getElementById('next-length-modal');
    const langSelect = document.getElementById('next-language-modal');
    const len = lenSelect ? lenSelect.value : currentLength;
    const lang = langSelect ? langSelect.value : currentLanguage;
    socket.emit('nextRound', { length: parseInt(len), language: lang });
}

// Keyboard events
document.addEventListener('keydown', (e) => {
    if (document.getElementById('game-screen').classList.contains('active')) {
        const key = e.key.toUpperCase();
        if (key === 'ENTER') submitGuess();
        else if (key === 'BACKSPACE') backspace();
        else if (/^[A-Z]$/.test(key)) handleInput(key);
    }
});

// --- EMOJI REACTIONS ---

function initEmojiReactions() {
    const emojiButtons = document.querySelectorAll('.emoji-button');
    emojiButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const emoji = btn.getAttribute('data-emoji');
            sendEmojiReaction(emoji);
        });
    });
}

function sendEmojiReaction(emoji) {
    // Create floating animation locally
    createFloatingEmoji(emoji);

    // Send to server to broadcast to other players
    socket.emit('emojiReaction', { emoji, roomCode: currentRoom });
}

function createFloatingEmoji(emoji) {
    const floatingEmoji = document.createElement('div');
    floatingEmoji.className = 'floating-emoji';
    floatingEmoji.textContent = emoji;

    // Random horizontal position near the emoji panel
    const randomX = window.innerWidth - 100 - Math.random() * 50;
    const randomY = window.innerHeight - 100 - Math.random() * 100;

    floatingEmoji.style.left = randomX + 'px';
    floatingEmoji.style.top = randomY + 'px';

    document.body.appendChild(floatingEmoji);

    // Remove after animation completes
    setTimeout(() => {
        floatingEmoji.remove();
    }, 3000);
}

function displayReaction(emoji, playerName) {
    const reactionsDisplay = document.getElementById('emoji-reactions-display');

    const reactionItem = document.createElement('div');
    reactionItem.className = 'reaction-item';
    reactionItem.innerHTML = `
        <span class="emoji">${emoji}</span>
        <span class="player-name">${playerName}</span>
    `;

    reactionsDisplay.appendChild(reactionItem);

    // Remove after 3 seconds
    setTimeout(() => {
        reactionItem.remove();
    }, 3000);
}

// Socket event for receiving emoji reactions from other players
socket.on('emojiReaction', (data) => {
    // data: { emoji, playerId, playerName }
    if (data.playerId !== myId) {
        // Display reaction from other player
        displayReaction(data.emoji, data.playerName);
        createFloatingEmoji(data.emoji);
    }
});

// Home button in game screen with translated confirm
const btnHomeGameXL = document.getElementById('btn-home-game');
if (btnHomeGameXL) {
    btnHomeGameXL.addEventListener('click', () => {
        if (confirm(t('xl_confirm_home'))) location.href = '../../index.html';
    });
}

// --- INVITE LINK SHARING ---

function shareInviteLink() {
    if (!currentRoom) return;
    const url = `${window.location.origin}${window.location.pathname}?join=${currentRoom}`;
    const text = `Join my Parole XL game! Room: ${currentRoom}`;

    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: 'Parole XL', text, url }).catch(() => {});
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
                    showToast('📋 Link copiato!', '#00ff88');
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
            showToast('📋 Link copiato!', '#00ff88');
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
        window.history.replaceState({}, '', window.location.pathname);
    }
})();

// --- ROOM PERSISTENCE (keepalive when backgrounded) ---

let keepAliveInterval = null;

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (!keepAliveInterval && currentRoom) {
            keepAliveInterval = setInterval(() => {
                if (socket.connected) {
                    socket.emit('ping');
                }
            }, 25000);
        }
    } else {
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        if (!socket.connected && currentRoom) {
            socket.connect();
        }
    }
});
