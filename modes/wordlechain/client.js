// ────────────────────────────────────────────────────────────
//  Word Chain Battle – Client Logic
// ────────────────────────────────────────────────────────────

const socket = io('/wordlechain');

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


// ─── State ───────────────────────────────────────────────────
let myId = null;
let myRoomCode = null;
let isHost = false;
let players = [];
let gameStatus = 'lobby'; // lobby | pickLetter | playing | pickingAfterTimeout | ended
let currentPrefix = '';
let currentPlayerId = null;
let timerInterval = null;
let timerSeconds = 13;
let maxTimerSeconds = 13;
let roomLanguage = 'it';
let pointsMode = false;
let targetScore = 300;
let roundTimer = 13;

const avatars = ['🐶', '🐱', '🦊', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🦄', '🐝', '🐙', '🦖', '👽', '👾', '🤖', '👻', '💩'];
let currentAvatarIndex = Math.floor(Math.random() * avatars.length);

function cycleAvatar() {
    currentAvatarIndex = (currentAvatarIndex + 1) % avatars.length;
    const btn = $('avatar-btn');
    if (btn) btn.textContent = avatars[currentAvatarIndex];
}

window.addEventListener('DOMContentLoaded', () => {
    const btn = $('avatar-btn');
    if (btn) btn.textContent = avatars[currentAvatarIndex];
});

// ─── DOM Helpers ─────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

function $(id) { return document.getElementById(id); }

function showToast(msg, type = 'info') {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// ─── Sounds ──────────────────────────────────────────────────
function playSound(id) {
    const snd = document.getElementById(id);
    if (snd) { snd.currentTime = 0; snd.play().catch(() => { }); }
}

// ─── Room Code Input auto-uppercase ──────────────────────────
$('room-code-input').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
});

// ─── Lobby Actions ───────────────────────────────────────────
function createRoom() {
    const nickname = $('nickname').value.trim();
    if (!nickname) return showToast(t('wc_toast_nick_error', 'Enter a nickname!'), 'error');
    const langInput = document.querySelector('input[name="language"]:checked');
    const language = langInput ? langInput.value : 'it';
    const avatar = avatars[currentAvatarIndex];
    const timerRestriction = $('timer-restriction') ? $('timer-restriction').checked : true;
    const isPoints = $('points-mode') ? $('points-mode').checked : false;
    const ts = isPoints ? (parseInt($('target-score-input')?.value, 10) || 300) : null;
    roundTimer = 13; // default
    socket.emit('createRoom', { nickname, language, avatar, timerRestriction, pointsMode: isPoints, targetScore: ts, roundTimer: 13 });
}

function joinRoom() {
    const nickname = $('nickname').value.trim();
    const roomCode = $('room-code-input').value.trim().toUpperCase();
    if (!nickname) return showToast(t('wc_toast_nick_error', 'Enter a nickname!'), 'error');
    if (!roomCode) return showToast(t('wc_toast_code_error', 'Enter a room code!'), 'error');
    const avatar = avatars[currentAvatarIndex];
    socket.emit('joinRoom', { roomCode, nickname, avatar });
}

function startGame() {
    socket.emit('startGame');
}

function skipTurn() {
    socket.emit('skipTurn');
}

function leaveRoom() {
    socket.emit('leaveRoom');
    location.reload();
}

let isSubmitting = false;

// ─── Game Actions ────────────────────────────────────────────
function submitWord() {
    if (isSubmitting) return;
    const input = $('word-input');
    const word = input.value.trim().toUpperCase();
    if (word.length === 0) return;
    isSubmitting = true;
    socket.emit('submitWord', word);
}

function pickLetter(letter) {
    if (gameStatus === 'pickLetter') {
        socket.emit('pickLetter', letter);
    } else if (gameStatus === 'pickingAfterTimeout') {
        socket.emit('pickLetterAfterTimeout', letter);
    }
}

function sendReaction(emoji) {
    socket.emit('reaction', emoji);
}

function restartGame() {
    socket.emit('restartGame');
}

function setTargetPreset(val) {
    const input = $('target-score-input');
    if (input) input.value = val;
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
}

function updateTargetScore() {
    const val = parseInt($('target-score-input')?.value, 10);
    if (isNaN(val) || val < 50) return showToast('Target must be at least 50!', 'error');
    socket.emit('setTargetScore', val);
}

function adjustTargetInGame() {
    const val = parseInt($('ingame-target-input')?.value, 10);
    if (isNaN(val) || val < 50) return showToast('Target must be at least 50!', 'error');
    socket.emit('setTargetScore', val);
}

function adjustTimerInGame() {
    const val = parseInt($('ingame-timer-input')?.value, 10);
    if (isNaN(val) || val < 5) return showToast('Timer must be at least 5s!', 'error');
    socket.emit('setRoundTimer', val);
}

function updateTargetDisplay() {
    const el = $('target-display');
    if (el) {
        el.textContent = `🎯 Target: ${targetScore} pts`;
        el.style.display = pointsMode ? 'block' : 'none';
    }
    const gameEl = $('target-display-game');
    if (gameEl) {
        gameEl.textContent = `🎯 Target: ${targetScore} pts`;
    }
    const bar = $('target-bar-container');
    if (bar) bar.style.display = pointsMode ? 'flex' : 'none';
    const ingameInput = $('ingame-target-input');
    if (ingameInput) ingameInput.value = targetScore;

    const timerDisp = $('round-timer-display');
    if (timerDisp) timerDisp.textContent = `⏳ Timer: ${roundTimer}s`;
    
    const timerDispGame = $('timer-display-game');
    if (timerDispGame) timerDispGame.textContent = `⏳ Round: ${roundTimer}s`;
    
    const timerBar = $('timer-bar-container');
    if (timerBar) timerBar.style.display = 'flex';
    
    const wTimerInput = $('waiting-timer-input');
    if (wTimerInput) wTimerInput.value = roundTimer;

    const ignameTimerInput = $('ingame-timer-input');
    if (ignameTimerInput) ignameTimerInput.value = roundTimer;
}

// ─── Typing broadcast ───────────────────────────────────────
$('word-input').addEventListener('input', function () {
    const text = this.value.toUpperCase();
    socket.emit('typing', text);
    updateLivePreview(text);
    playSound('audio-typing');
});

$('word-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitWord();
    }
});

// ─── Mobile Keyboard logic removed ───

// Keep focus on input if clicking anywhere while it's our turn
document.addEventListener('click', (e) => {
    const input = $('word-input');
    if (gameStatus === 'playing' && input && !input.disabled) {
        // Only ignore clicks on actual buttons or inputs to allow interactions
        if (e.target.tagName !== 'BUTTON' && !e.target.closest('button') && e.target.tagName !== 'INPUT') {
            setTimeout(() => { if (!input.disabled) input.focus(); }, 10);
        }
    }
});

// Auto-focus and capture keydowns if typing outside the input
document.addEventListener('keydown', (e) => {
    const input = $('word-input');
    if (gameStatus === 'playing' && input && !input.disabled) {
        if (document.activeElement !== input) {
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                input.focus();
                input.value += e.key;
                input.dispatchEvent(new Event('input'));
                e.preventDefault();
            } else if (e.key === 'Backspace') {
                input.focus();
                input.value = input.value.slice(0, -1);
                input.dispatchEvent(new Event('input'));
                e.preventDefault();
            } else if (e.key === 'Enter') {
                input.focus();
                submitWord();
                e.preventDefault();
            }
        }
    }
});

// ─── Rendering Functions ─────────────────────────────────────

function renderPlayersWaiting(playerList) {
    const container = $('players-list');
    if (!container) return;
    container.innerHTML = playerList.map(p => `
        <div class="player-item ${p.id === (players.find(pl => pl.id === myId) || {}).id ? 'me' : ''} ${p.disconnected ? 'disconnected' : ''}">
            ${isHost && p.id === myId ? '👑 ' : ''}${p.nickname}
        </div>
    `).join('');
}

function renderPlayersGame(playerList) {
    const container = $('players-game-list');
    if (!container) return;
    container.innerHTML = playerList.map((p, i) => {
        if (pointsMode) {
            // Points mode: show rank, score, progress bar
            const rank = i + 1;
            const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}°`;
            const isCurrentTurn = currentPlayerId === p.id;
            const classes = [
                'player-card',
                isCurrentTurn ? 'active-turn' : '',
                p.id === myId ? 'is-me' : '',
                p.disconnected ? 'disconnected' : ''
            ].filter(Boolean).join(' ');
            const progress = targetScore > 0 ? Math.min(100, ((p.score || 0) / targetScore) * 100) : 0;

            return `
                <div class="${classes}" data-player-id="${p.id}">
                    <div class="player-info">
                        <span class="player-rank">${medal}</span>
                        <span class="player-name">${p.nickname}</span>
                    </div>
                    <div class="player-score-section">
                        <span class="player-score">⭐ ${p.score || 0}</span>
                        <div class="score-bar-wrap">
                            <div class="score-bar" style="width:${progress}%"></div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            // Classic mode: hearts
            const hearts = p.alive
                ? '❤️'.repeat(p.lives) + '🖤'.repeat(Math.max(0, 5 - p.lives))
                : '💀';
            const isCurrentTurn = currentPlayerId === p.id;
            const classes = [
                'player-card',
                p.alive ? '' : 'eliminated',
                isCurrentTurn ? 'active-turn' : '',
                p.id === myId ? 'is-me' : '',
                p.disconnected ? 'disconnected' : ''
            ].filter(Boolean).join(' ');

            return `
                <div class="${classes}" data-player-id="${p.id}">
                    <div class="player-info">
                        <span class="player-name">${p.nickname}</span>
                        ${isHost && p.id === players[0]?.id ? ' 👑' : ''}
                    </div>
                    <div class="player-hearts">${hearts}</div>
                </div>
            `;
        }
    }).join('');
}

function updateLivePreview(text) {
    const preview = $('live-preview');
    if (!preview) return;
    if (!text) {
        preview.innerHTML = `<span class="typed-part" style="opacity: 0.5;">...</span>`;
    } else {
        preview.innerHTML = `<span class="typed-part">${text}</span>`;
    }
}

function setPrefix(prefix) {
    currentPrefix = prefix;
    const el = $('current-prefix');
    if (el) el.textContent = prefix;
    const input = $('word-input');
    if (input) {
        input.value = '';
    }
    updateLivePreview('');
}

function startTimer(seconds) {
    stopTimer();
    timerSeconds = seconds;
    updateTimerDisplay();

    timerInterval = setInterval(() => {
        timerSeconds--;
        if (timerSeconds < 0) timerSeconds = 0;
        updateTimerDisplay();
        // Play warning sound at 3 seconds, only for the active player
        if (timerSeconds === 3 && currentPlayerId === myId) {
            playSound('audio-timer');
        }
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimerDisplay() {
    const timerEl = $('turn-timer');
    const timerBar = $('timer-bar');
    if (timerEl) {
        timerEl.textContent = `${timerSeconds}s`;
        timerEl.className = timerSeconds <= 3 ? 'timer-panic' : '';
    }
    if (timerBar) {
        const pct = (timerSeconds / maxTimerSeconds) * 100;
        timerBar.style.width = pct + '%';
        if (timerSeconds <= 3) {
            timerBar.classList.add('panic');
        } else {
            timerBar.classList.remove('panic');
        }
    }
}

function setInputEnabled(enabled) {
    const input = $('word-input');
    const btn = $('submit-btn');
    if (input) input.disabled = !enabled;
    if (btn) btn.disabled = !enabled;
}

function showLetterPicker(show) {
    const picker = $('letter-picker-overlay');
    if (!picker) return;
    if (show) {
        // Generate 4 random unique letters
        let alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        if (roomLanguage === 'it') {
            alphabet = alphabet.filter(l => !['J', 'W', 'X', 'K', 'Y'].includes(l));
        }
        const shuffled = alphabet.sort(() => Math.random() - 0.5);
        const chosen = shuffled.slice(0, 4);
        const grid = $('letter-grid');
        if (grid) {
            grid.innerHTML = chosen.map(l =>
                `<button class="letter-btn" onclick="pickLetter('${l}')">${l}</button>`
            ).join('');
        }
    }
    picker.style.display = show ? 'flex' : 'none';
}

function showEndModal(show, data = {}) {
    const modal = $('end-modal');
    if (!modal) return;
    if (show) {
        modal.classList.add('active');
        const title = $('modal-title');
        const subtitle = $('modal-subtitle');
        if (data.pointsMode) {
            // Points mode end
            if (data.winnerId === myId) {
                if (title) title.textContent = '🏆 YOU WIN!';
                if (subtitle) subtitle.textContent = `You reached ${data.winnerScore || data.targetScore} points!`;
                playSound('audio-win');
            } else if (data.winnerNickname) {
                if (title) title.textContent = '🏆 Game Over';
                if (subtitle) subtitle.textContent = `${data.winnerNickname} reached ${data.winnerScore || data.targetScore} points!`;
            } else {
                if (title) title.textContent = '💀 Game Over';
                if (subtitle) subtitle.textContent = 'No winner!';
            }
        } else {
            // Classic mode end
            if (data.winnerId === myId) {
                if (title) title.textContent = '🏆 YOU WIN!';
                if (subtitle) subtitle.textContent = 'You are the last one standing!';
                playSound('audio-win');
            } else if (data.winnerNickname) {
                if (title) title.textContent = '🏆 Game Over';
                if (subtitle) subtitle.textContent = `${data.winnerNickname} wins!`;
            } else {
                if (title) title.textContent = '💀 Game Over';
                if (subtitle) subtitle.textContent = 'No survivors!';
            }
        }
        renderEndLeaderboard(data.players || [], data.pointsMode);
        const hostControls = $('host-end-controls');
        if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';
    } else {
        modal.classList.remove('active');
    }
}

function renderEndLeaderboard(playerList, isPointsMode) {
    const lb = $('end-leaderboard');
    if (!lb) return;
    let sorted;
    if (isPointsMode) {
        // Already sorted by server in points mode
        sorted = playerList;
    } else {
        sorted = [...playerList].sort((a, b) => b.lives - a.lives);
    }
    lb.innerHTML = sorted.map((p, i) => {
        const rank = i + 1;
        let posLabel;
        if (rank === 1) posLabel = '🥇 1°';
        else if (rank === 2) posLabel = '🥈 2°';
        else if (rank === 3) posLabel = '🥉 3°';
        else posLabel = `${rank}th`;

        const scoreOrLives = isPointsMode
            ? `<span class="lb-score">⭐ ${p.score || 0} pts</span>`
            : `<span class="lb-lives">${p.alive ? '❤️'.repeat(p.lives) : '💀'}</span>`;

        return `
            <div class="lb-row ${rank === 1 ? 'winner' : ''} ${!isPointsMode && p.alive ? 'alive' : ''} ${!isPointsMode && !p.alive ? 'dead' : ''}">
                <span class="lb-rank">${posLabel}</span>
                <span class="lb-name">${p.nickname}</span>
                ${scoreOrLives}
            </div>
        `;
    }).join('');
}

function addWordToHistory(word, nickname, valid) {
    const list = $('word-history');
    if (!list) return;
    const item = document.createElement('div');
    item.className = `history-item ${valid ? 'valid' : 'invalid'}`;
    item.innerHTML = `<span class="history-word">${valid ? '✅' : '❌'} ${word}</span><span class="history-player">${nickname}</span>`;
    list.prepend(item);
    // Keep only last 20 items
    while (list.children.length > 20) list.removeChild(list.lastChild);
}

function showFloatingEmoji(emoji, nickname) {
    const container = $('emoji-reactions');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.textContent = emoji;
    el.style.left = Math.random() * 80 + 10 + '%';
    container.appendChild(el);
    setTimeout(() => el.remove(), 2000);
}

// ─── Socket Events ───────────────────────────────────────────

socket.on('connect', () => {
    myId = socket.id;
    console.log('[WORDLECHAIN] Connected:', myId);
});

socket.on('roomCreated', ({ roomCode, pointsMode: pm, targetScore: ts, roundTimer: rt }) => {
    myRoomCode = roomCode;
    isHost = true;
    if (pm !== undefined) pointsMode = pm;
    if (ts !== undefined) targetScore = ts;
    if (rt !== undefined) roundTimer = rt;
    $('display-room-code').textContent = roomCode;
    $('start-btn').style.display = 'inline-block';
    
    const waitingMsg = $('waiting-host-msg');
    if (waitingMsg) waitingMsg.style.display = 'none';

    renderPlayersWaiting(players.length ? players : [{ id: myId, nickname: $('nickname').value.trim() }]);
    showScreen('waiting-screen');
    updateTargetDisplay();
    // Show host controls
    const hostTarget = $('host-target-controls');
    if (hostTarget) hostTarget.style.display = (isHost && pointsMode) ? 'block' : 'none';
    const hostTimer = $('host-timer-controls');
    if (hostTimer) hostTimer.style.display = isHost ? 'block' : 'none';
});

socket.on('playerJoined', ({ players: pList, pointsMode: pm, targetScore: ts, roundTimer: rt }) => {
    players = pList;
    if (pm !== undefined) pointsMode = pm;
    if (ts !== undefined) targetScore = ts;
    if (rt !== undefined) roundTimer = rt;
    renderPlayersWaiting(players);
    if (!myRoomCode && players.find(p => p.id === myId)) {
        myRoomCode = true;
        showScreen('waiting-screen');
    }
    $('display-room-code').textContent = $('display-room-code').textContent || '';
    updateTargetDisplay();
});

socket.on('playerReconnected', ({ oldId, newId, nickname, players: pList }) => {
    players = pList;
    if (oldId === myId) myId = newId;
    renderPlayersWaiting(players);
    showToast(`${nickname} reconnected`, 'info');
});

socket.on('reconnectState', (state) => {
    isHost = state.isHost;
    players = state.players;
    roomLanguage = state.language || 'it';
    pointsMode = state.pointsMode || false;
    targetScore = state.targetScore || 300;
    if (state.roundTimer !== undefined) roundTimer = state.roundTimer;
    gameStatus = state.gameState.status;
    currentPrefix = state.gameState.currentPrefix;
    currentPlayerId = state.gameState.currentPlayer?.id;
    if (gameStatus === 'playing') {
        showScreen('game-screen');
        setPrefix(currentPrefix);
        renderPlayersGame(players);
        setInputEnabled(currentPlayerId === myId);
        updateTargetDisplay();
    }
});

socket.on('gameStarted', ({ players: pList, pickerNickname, pickerId, language, pointsMode: pm, targetScore: ts, roundTimer: rt }) => {
    players = pList;
    roomLanguage = language || 'it';
    if (pm !== undefined) pointsMode = pm;
    if (ts !== undefined) targetScore = ts;
    if (rt !== undefined) roundTimer = rt;
    gameStatus = 'pickLetter';
    showScreen('game-screen');
    renderPlayersGame(players);
    setInputEnabled(false);
    updateTargetDisplay();
    // Show host in-game adjust controls
    const hostAdjust = $('host-adjust-target');
    if (hostAdjust) hostAdjust.style.display = (isHost && pointsMode) ? 'flex' : 'none';
    const hostTimerAdjust = $('host-adjust-timer');
    if (hostTimerAdjust) hostTimerAdjust.style.display = isHost ? 'flex' : 'none';

    if (pickerId === myId) {
        showLetterPicker(true);
        showToast('Pick the starting letter!', 'info');
    } else {
        showToast(`${pickerNickname} is picking the starting letter...`, 'info');
    }
});

socket.on('prefixSet', ({ prefix, currentPlayer, players: pList, autoGenerated }) => {
    players = pList;
    gameStatus = 'playing';
    currentPlayerId = currentPlayer?.id;
    setPrefix(prefix);
    renderPlayersGame(players);
    showLetterPicker(false);
    
    const skipBtn = $('skip-turn-btn');
    if (skipBtn) skipBtn.style.display = 'none';

    const isMyTurn = currentPlayerId === myId;
    setInputEnabled(isMyTurn);
    if (isMyTurn) {
        $('word-input')?.focus();
        showToast('Your turn! Type a word starting with ' + prefix, 'info');
        playSound('audio-myturn');
    } else {
        showToast(`${currentPlayer?.nickname}'s turn`, 'info');
        playSound('audio-error'); // This maps to audio_turn.mp3
    }
    if (autoGenerated) {
        showToast(`Letter "${prefix}" was auto-picked`, 'info');
    }
});

socket.on('turnStarted', ({ currentPlayer, prefix, seconds }) => {
    isSubmitting = false;
    currentPlayerId = currentPlayer?.id;
    currentPrefix = prefix;
    setPrefix(prefix);
    maxTimerSeconds = seconds || 13;
    startTimer(seconds);
    renderPlayersGame(players);

    const isMyTurn = currentPlayerId === myId;
    setInputEnabled(isMyTurn);
    $('word-input').value = '';
    updateLivePreview('');

    const turnLabel = $('turn-label');
    if (turnLabel) {
        // Reset animation
        turnLabel.classList.remove('active-anim');
        void turnLabel.offsetWidth; // trigger reflow
        turnLabel.classList.add('active-anim');

        const p = players.find(pl => pl.id === currentPlayerId);
        const playerAvatar = p && p.avatar ? p.avatar : '👤';
        const displayNick = currentPlayer?.nickname || 'Player';

        if (isMyTurn) {
            turnLabel.innerHTML = `<span class="tr-avatar">${playerAvatar}</span> 🎯 YOUR TURN!`;
            turnLabel.className = 'turn-label my-turn active-anim';
            playSound('audio-myturn');
            if ($('skip-turn-btn')) $('skip-turn-btn').style.display = 'inline-block';
        } else {
            turnLabel.innerHTML = `<span class="tr-avatar">${playerAvatar}</span> ⏳ ${displayNick}'s turn`;
            turnLabel.className = 'turn-label active-anim';
            playSound('audio-error'); // This maps to audio_turn.mp3
            if ($('skip-turn-btn')) $('skip-turn-btn').style.display = 'none';
        }
    }

    if (isMyTurn) $('word-input')?.focus();
});

socket.on('wordResult', ({ valid, message, playerId, playerNickname, lives, score, eliminated, players: pList }) => {
    isSubmitting = false;
    if (pList) {
        players = pList;
        renderPlayersGame(players);
    }
    if (!valid) {
        showToast(message, 'error');
        playSound('audio-wrongword');
        if (playerId && playerNickname) {
            addWordToHistory(message, playerNickname, false);
        }
        if (eliminated && playerId === myId) {
            setInputEnabled(false);
            showToast('💀 You have been eliminated! You are now a spectator.', 'error');
        }
    }
});

socket.on('wordAccepted', ({ word, playerId, playerNickname, pointsEarned, score, newPrefix, currentPlayer, players: pList }) => {
    isSubmitting = false;
    players = pList;
    if ($('skip-turn-btn')) $('skip-turn-btn').style.display = 'none';
    currentPlayerId = currentPlayer?.id;
    setPrefix(newPrefix);
    renderPlayersGame(players);
    const pointsText = pointsMode && pointsEarned ? ` (+${pointsEarned}⭐)` : '';
    showToast(`✅ ${playerNickname}: ${word}${pointsText}`, 'success');
    addWordToHistory(word, playerNickname, true);

    if (word && word.length >= 11) {
        playSound('audio-clapping');
        for (let i = 0; i < 25; i++) {
            setTimeout(() => {
                const emojis = ['🎉', '🥳', '🎊', '✨', '👏'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                showFloatingEmoji(randomEmoji, playerNickname);
            }, i * 80);
        }
    }
});

socket.on('turnTimeout', ({ playerId, playerNickname, lives, score, eliminated, players: pList }) => {
    players = pList;
    stopTimer();
    renderPlayersGame(players);
    if (pointsMode) {
        showToast(`⏰ ${playerNickname} ran out of time! -10 ⭐`, 'error');
    } else {
        showToast(`⏰ ${playerNickname} ran out of time! -1 ❤️`, 'error');
    }
    playSound('audio-error');

    if (eliminated && playerId === myId) {
        setInputEnabled(false);
        showToast('💀 You have been eliminated!', 'error');
    }
});

socket.on('awaitingLetterPick', ({ pickerId, pickerNickname, language }) => {
    gameStatus = 'pickingAfterTimeout';
    setInputEnabled(false);
    roomLanguage = language || 'it';
    stopTimer();
    if (pickerId === myId) {
        showLetterPicker(true);
        showToast('Pick the starting letter for your opponent!', 'info');
    } else {
        showToast(`${pickerNickname} is picking the next letter...`, 'info');
    }
});

socket.on('playerTyping', ({ playerId, text }) => {
    if (playerId !== myId) {
        updateLivePreview(text);
        playSound('audio-typing');
    }
});

socket.on('playerReaction', ({ nickname, emoji }) => {
    showFloatingEmoji(emoji, nickname);
});

socket.on('gameOver', ({ winnerId, winnerNickname, winnerScore, targetScore: ts, pointsMode: pm, players: pList }) => {
    players = pList;
    gameStatus = 'ended';
    stopTimer();
    setInputEnabled(false);
    renderPlayersGame(players);
    showEndModal(true, { winnerId, winnerNickname, winnerScore, targetScore: ts, pointsMode: pm, players: pList });
});

socket.on('targetScoreUpdated', ({ targetScore: ts }) => {
    targetScore = ts;
    updateTargetDisplay();
    showToast(`🎯 Target updated: ${ts} pts`, 'info');
});

socket.on('roundTimerUpdated', ({ roundTimer: rt }) => {
    roundTimer = rt;
    updateTargetDisplay();
    showToast(`⏳ Round timer updated to ${rt}s`, 'info');
});

socket.on('gameRestarted', ({ players: pList, pointsMode: pm, targetScore: ts, roundTimer: rt }) => {
    players = pList;
    if ($('skip-turn-btn')) $('skip-turn-btn').style.display = 'none';
    if (pm !== undefined) pointsMode = pm;
    if (ts !== undefined) targetScore = ts;
    if (rt !== undefined) roundTimer = rt;
    gameStatus = 'lobby';
    showEndModal(false);
    stopTimer();
    $('word-history').innerHTML = '';
    showScreen('waiting-screen');
    renderPlayersWaiting(players);
    updateTargetDisplay();
    showToast('Game restarted! Waiting for host to start...', 'info');
});

socket.on('newHost', ({ hostId, hostNickname }) => {
    isHost = (hostId === myId);
    showToast(`🔹 New host: ${hostNickname}`, 'info');
    if (isHost && $('start-btn')) {
        $('start-btn').style.display = 'inline-block';
        const waitingMsg = $('waiting-host-msg');
        if (waitingMsg) waitingMsg.style.display = 'none';
        
        const hostTarget = $('host-target-controls');
        if (hostTarget) hostTarget.style.display = pointsMode ? 'block' : 'none';
        
        const hostTimer = $('host-timer-controls');
        if (hostTimer) hostTimer.style.display = 'block';
    }
});

socket.on('playerLeft', ({ playerId, players: pList }) => {
    players = pList;
    renderPlayersGame(players);
    renderPlayersWaiting(players);
});

socket.on('playerDisconnected', ({ nickname, players: pList }) => {
    players = pList;
    renderPlayersGame(players);
    showToast(`${nickname} disconnected`, 'error');
});

socket.on('error', (msg) => {
    showToast(msg, 'error');
});

socket.on('disconnect', () => {
    showToast('Connection lost. Reconnecting...', 'error');
});

socket.on('connect_error', () => {
    showToast('Cannot connect to server.', 'error');
});

// ─── INVITE LINK SHARING ─────────────────────────────────────
function shareInviteLink() {
    if (!myRoomCode) return;
    const url = `${window.location.origin}${window.location.pathname}?join=${myRoomCode}`;
    const text = `Join my WordleChain battle! Room: ${myRoomCode}`;

    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: 'WordleChain', text, url }).catch(() => {});
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
                    showToast('📋 Link copiato!', 'success');
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
            showToast('📋 Link copiato!', 'success');
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

// ─── ROOM PERSISTENCE (keepalive when backgrounded) ──────────
let keepAliveInterval = null;

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (!keepAliveInterval && myRoomCode) {
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
        if (!socket.connected && myRoomCode) {
            socket.connect();
        }
    }
});
