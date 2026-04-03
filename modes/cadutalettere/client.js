// ────────────────────────────────────────────────────────────
//  Caduta Lettere – Client Logic
// ────────────────────────────────────────────────────────────

const socket = io('/cadutalettere');

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
let gameActive = false;
let currentSpeed = 7;
let score = 0;
let correctLetters = 0;
let config = {};

// Falling letters state
let fallingLetters = [];
let letterIdCounter = 0;
let letterSpawnInterval = null;
let gameLoopRAF = null;
let lastFrameTime = 0;
let scoreUpdateTimer = null;

// Time mode countdown
let timeRemaining = 0;
let countdownInterval = null;

// Game area
let gameCanvas = null;

const ALPHABET = 'ABCDEFGHILMNOPQRSTUVZ';

// ─── DOM Helpers ─────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function showFeedback(msg, type) {
    const el = document.getElementById('feedback-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'feedback-msg ' + type;
    clearTimeout(showFeedback._t);
    showFeedback._t = setTimeout(() => { el.textContent = ''; el.className = 'feedback-msg'; }, 2500);
}

// ─── Room Code Input auto-uppercase ──────────────────────────
document.getElementById('room-code-input').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
});

// ─── Actions: Lobby ──────────────────────────────────────────
function createRoom() {
    const nickname = document.getElementById('nickname').value.trim();
    const gameMode = document.querySelector('input[name="gameMode"]:checked').value;
    const gameModeValue = document.getElementById('game-mode-value').value;

    if (!nickname) {
        document.getElementById('create-error').textContent = 'Inserisci un nickname!';
        return;
    }
    document.getElementById('create-error').textContent = '';
    socket.emit('createRoom', { nickname, gameMode, gameModeValue });
}

function joinRoom() {
    const nickname = document.getElementById('nickname').value.trim();
    const roomCode = document.getElementById('room-code-input').value.trim().toUpperCase();

    if (!nickname) {
        document.getElementById('join-error').textContent = 'Inserisci un nickname!';
        return;
    }
    if (!roomCode) {
        document.getElementById('join-error').textContent = 'Inserisci il codice stanza!';
        return;
    }
    document.getElementById('join-error').textContent = '';
    socket.emit('joinRoom', { roomCode, nickname });
}

// ─── Game Mode Value Options ─────────────────────────────────
function updateGameModeOptions() {
    const mode = document.querySelector('input[name="gameMode"]:checked').value;
    const select = document.getElementById('game-mode-value');
    const label = document.getElementById('game-mode-value-label');

    select.innerHTML = '';

    if (mode === 'time') {
        label.textContent = '⏱️ Durata:';
        [
            { v: 60, t: '1 Minuto' },
            { v: 180, t: '3 Minuti' },
            { v: 300, t: '5 Minuti' },
            { v: 600, t: '10 Minuti' }
        ].forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.v;
            o.textContent = opt.t;
            select.appendChild(o);
        });
        select.value = '180';
    } else {
        label.textContent = '🎯 Obiettivo:';
        [
            { v: 200, t: '200 Punti' },
            { v: 500, t: '500 Punti' },
            { v: 1000, t: '1000 Punti' },
            { v: 2000, t: '2000 Punti' }
        ].forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.v;
            o.textContent = opt.t;
            select.appendChild(o);
        });
        select.value = '500';
    }
}

document.querySelectorAll('input[name="gameMode"]').forEach(radio => {
    radio.addEventListener('change', updateGameModeOptions);
});
updateGameModeOptions();

// ─── Actions: Game ───────────────────────────────────────────
function startGame() {
    socket.emit('startGame');
}

function exitGame() {
    if (confirm('Sei sicuro di voler uscire?')) {
        socket.emit('leaveRoom');
        stopGame();
        window.location.href = '../../index.html';
    }
}

// ─── Falling Letters Engine ──────────────────────────────────

function getSpeedPixelsPerSecond(speed) {
    // Speed 5, 7, 8 maps to pixels per second
    const speeds = { 5: 120, 7: 240, 8: 340 };
    return speeds[speed] || 240;
}

function getSpawnIntervalMs(speed) {
    // How often a new letter appears (ms)
    const intervals = { 5: 1100, 7: 650, 8: 450 };
    return intervals[speed] || 650;
}

function spawnLetter() {
    const gameArea = document.getElementById('game-area');
    if (!gameArea) return;

    const areaWidth = gameArea.clientWidth;
    const letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const id = ++letterIdCounter;

    // Random horizontal position (with padding)
    const boxSize = 56;
    const x = Math.floor(Math.random() * (areaWidth - boxSize - 20)) + 10;

    // Create DOM element
    const el = document.createElement('div');
    el.className = 'falling-letter';
    el.id = `fl-${id}`;
    el.textContent = letter;
    el.style.left = `${x}px`;
    el.style.top = '-60px';
    gameArea.appendChild(el);

    fallingLetters.push({
        id,
        letter,
        x,
        y: -60,
        el,
        removed: false
    });
}

function gameLoop(timestamp) {
    if (!gameActive) return;

    if (!lastFrameTime) lastFrameTime = timestamp;
    const dt = (timestamp - lastFrameTime) / 1000; // seconds
    lastFrameTime = timestamp;

    const gameArea = document.getElementById('game-area');
    if (!gameArea) return;
    const areaHeight = gameArea.clientHeight;

    const pxPerSec = getSpeedPixelsPerSecond(currentSpeed);

    for (let i = fallingLetters.length - 1; i >= 0; i--) {
        const fl = fallingLetters[i];
        if (fl.removed) continue;

        fl.y += pxPerSec * dt;
        fl.el.style.top = `${fl.y}px`;

        // Hit bottom — remove without penalty
        if (fl.y > areaHeight) {
            fl.removed = true;
            fl.el.classList.add('letter-missed');
            setTimeout(() => fl.el.remove(), 300);
            fallingLetters.splice(i, 1);
        }
    }

    gameLoopRAF = requestAnimationFrame(gameLoop);
}

function handleKeyPress(key) {
    if (!gameActive) return;
    const upperKey = key.toUpperCase();
    if (upperKey.length !== 1 || !ALPHABET.includes(upperKey)) return;

    // Find the lowest (closest to bottom) matching letter
    let bestIdx = -1;
    let bestY = -1;
    for (let i = 0; i < fallingLetters.length; i++) {
        const fl = fallingLetters[i];
        if (!fl.removed && fl.letter === upperKey && fl.y > bestY) {
            bestY = fl.y;
            bestIdx = i;
        }
    }

    if (bestIdx >= 0) {
        // Correct!
        const fl = fallingLetters[bestIdx];
        fl.removed = true;

        // Punti in base alla velocità: 5 (Lenta) -> 5, 7 (Normale) -> 10, 8 (Veloce) -> 15
        const pointsMapping = { 5: 5, 7: 10, 8: 15 };
        score += pointsMapping[currentSpeed] || 10;

        correctLetters++;

        // Create particle explosion
        createParticles(fl.x + 28, fl.y + 28);

        // Animate letter out
        fl.el.classList.add('letter-caught');
        setTimeout(() => fl.el.remove(), 400);
        fallingLetters.splice(bestIdx, 1);

        updateScoreDisplay();
        playSound('audio-correct');

        // Send score update
        sendScoreUpdate();
    } else {
        // Wrong key — penalty
        score = Math.max(0, score - 5);
        updateScoreDisplay();
        showFeedback(`✗ ${upperKey}`, 'wrong');
        playSound('audio-wrong');
        shakeScreen();
        sendScoreUpdate();
    }
}

function createParticles(cx, cy) {
    const gameArea = document.getElementById('game-area');
    if (!gameArea) return;

    const colors = ['#00ff88', '#00d4ff', '#ffd200', '#ff6b6b', '#c084fc'];

    for (let i = 0; i < 8; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.left = `${cx}px`;
        p.style.top = `${cy}px`;
        p.style.background = colors[Math.floor(Math.random() * colors.length)];

        const angle = (Math.PI * 2 * i) / 8 + (Math.random() - 0.5) * 0.5;
        const distance = 40 + Math.random() * 30;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance;

        p.style.setProperty('--dx', `${dx}px`);
        p.style.setProperty('--dy', `${dy}px`);
        gameArea.appendChild(p);

        setTimeout(() => p.remove(), 600);
    }
}

function shakeScreen() {
    const gameArea = document.getElementById('game-area');
    if (!gameArea) return;
    gameArea.classList.add('shake');
    setTimeout(() => gameArea.classList.remove('shake'), 300);
}

function updateScoreDisplay() {
    const el = document.getElementById('score-value');
    if (el) {
        el.textContent = score;
        el.classList.remove('score-pulse');
        void el.offsetWidth;
        el.classList.add('score-pulse');
    }
}

function sendScoreUpdate() {
    socket.emit('scoreUpdate', { score, correctLetters });
}

function startGameLoop() {
    score = 0;
    correctLetters = 0;
    fallingLetters = [];
    letterIdCounter = 0;
    lastFrameTime = 0;
    gameActive = true;

    // Clear game area
    const gameArea = document.getElementById('game-area');
    if (gameArea) gameArea.innerHTML = '';

    updateScoreDisplay();
    updateSpeedDisplay();

    // Spawn letters
    letterSpawnInterval = setInterval(() => {
        if (gameActive) spawnLetter();
    }, getSpawnIntervalMs(currentSpeed));

    // Start animation loop
    gameLoopRAF = requestAnimationFrame(gameLoop);

    // Score sync every 2 seconds
    scoreUpdateTimer = setInterval(() => {
        if (gameActive) sendScoreUpdate();
    }, 2000);
}

function stopGame() {
    gameActive = false;
    if (letterSpawnInterval) { clearInterval(letterSpawnInterval); letterSpawnInterval = null; }
    if (gameLoopRAF) { cancelAnimationFrame(gameLoopRAF); gameLoopRAF = null; }
    if (scoreUpdateTimer) { clearInterval(scoreUpdateTimer); scoreUpdateTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

function updateSpeedDisplay() {
    const el = document.getElementById('speed-indicator');
    if (!el) return;

    const labels = { 5: 'LENTA', 7: 'NORMALE', 8: 'VELOCE' };
    const classes = { 5: 'speed-slow', 7: 'speed-normal', 8: 'speed-fast' };

    el.textContent = `⚡ ${labels[currentSpeed] || 'NORMALE'}`;
    el.className = 'speed-indicator ' + (classes[currentSpeed] || 'speed-normal');
}

function startCountdown(totalSeconds) {
    timeRemaining = totalSeconds;
    updateTimerDisplay();

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        timeRemaining--;
        if (timeRemaining <= 0) timeRemaining = 0;
        updateTimerDisplay();
    }, 1000);
}

function updateTimerDisplay() {
    const el = document.getElementById('timer-display');
    if (!el) return;

    const min = Math.floor(timeRemaining / 60);
    const sec = timeRemaining % 60;
    el.textContent = `${min}:${sec.toString().padStart(2, '0')}`;

    if (timeRemaining <= 10) {
        el.classList.add('timer-danger');
    } else if (timeRemaining <= 30) {
        el.classList.add('timer-warning');
        el.classList.remove('timer-danger');
    } else {
        el.classList.remove('timer-warning', 'timer-danger');
    }
}

function playSound(id) {
    const el = document.getElementById(id);
    if (el) {
        el.currentTime = 0;
        el.play().catch(() => { });
    }
}

// ─── Players Rendering ───────────────────────────────────────
function renderPlayersWaiting(players) {
    const list = document.getElementById('players-list');
    if (!list) return;
    list.innerHTML = players.map(p =>
        `<div class="player-item ${p.id === (window._clHost || '') ? 'host' : ''}">
            ${p.nickname}
        </div>`
    ).join('');
}

function renderLeaderboardSidebar(players) {
    const el = document.getElementById('live-leaderboard');
    if (!el) return;
    const sorted = [...players].sort((a, b) => b.score - a.score);
    el.innerHTML = sorted.map((p, i) =>
        `<div class="lb-item ${p.id === myId ? 'lb-me' : ''}">
            <span class="lb-rank">${['🥇', '🥈', '🥉'][i] || `#${i + 1}`}</span>
            <span class="lb-name">${p.nickname}</span>
            <span class="lb-score">${p.score}</span>
        </div>`
    ).join('');
}

function renderFinalLeaderboard(players) {
    const body = players.map((p, i) =>
        `<tr class="${p.id === myId ? 'highlight-me' : ''}">
            <td>${['🥇', '🥈', '🥉'][i] || `#${i + 1}`}</td>
            <td>${p.nickname}</td>
            <td>${p.score}</td>
            <td>${p.correctLetters}</td>
        </tr>`
    ).join('');
    document.getElementById('final-leaderboard').innerHTML =
        `<table>
            <thead><tr><th>Pos</th><th>Giocatore</th><th>Punti</th><th>✓ Lettere</th></tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

// ─── Socket Events ───────────────────────────────────────────

socket.on('connect', () => {
    myId = socket.id;
    console.log('[CADUTA LETTERE] Connected:', myId);

    const nicknameInput = document.getElementById('nickname');
    const nickname = nicknameInput ? nicknameInput.value.trim() : null;
    if (myRoomCode && nickname) {
        socket.emit('joinRoom', { roomCode: myRoomCode, nickname });
    }
});

socket.on('roomCreated', ({ roomCode, config: cfg }) => {
    myRoomCode = roomCode;
    isHost = true;
    config = cfg;
    window._clHost = socket.id;
    document.getElementById('display-room-code').textContent = roomCode;
    document.getElementById('start-btn').style.display = 'inline-block';
    document.getElementById('players-list').innerHTML =
        `<div class="player-item host">${document.getElementById('nickname').value.trim()}</div>`;
    showScreen('waiting-screen');
});

socket.on('playerJoined', ({ players }) => {
    renderPlayersWaiting(players);
    if (!myRoomCode && players.find(p => p.id === myId)) {
        myRoomCode = document.getElementById('room-code-input')?.value?.trim()?.toUpperCase();
        document.getElementById('display-room-code').textContent = myRoomCode || '';
        showScreen('waiting-screen');
    }
});

socket.on('newHost', ({ hostId }) => {
    if (hostId === myId) {
        isHost = true;
        document.getElementById('start-btn').style.display = 'inline-block';
    }
});

socket.on('gameStarted', ({ seed, speed, config: cfg, startTime, players }) => {
    config = cfg;
    currentSpeed = speed;
    gameActive = true;

    showScreen('game-screen');
    startGameLoop();
    renderLeaderboardSidebar(players);

    // Setup timer for time mode
    if (config.gameMode === 'time') {
        document.getElementById('timer-container').style.display = 'flex';
        document.getElementById('target-container').style.display = 'none';
        startCountdown(config.gameModeValue);
    } else {
        document.getElementById('timer-container').style.display = 'none';
        document.getElementById('target-container').style.display = 'flex';
        document.getElementById('target-value').textContent = config.gameModeValue;
    }
});

socket.on('speedChange', ({ speed }) => {
    currentSpeed = speed;
    updateSpeedDisplay();

    // Update spawn interval
    if (letterSpawnInterval) {
        clearInterval(letterSpawnInterval);
        letterSpawnInterval = setInterval(() => {
            if (gameActive) spawnLetter();
        }, getSpawnIntervalMs(currentSpeed));
    }

    // Flash speed change notification
    const notif = document.getElementById('speed-notification');
    if (notif) {
        const labels = { 5: '🐢 Velocità Lenta!', 7: '➡️ Velocità Normale', 8: '🔥 Più Veloce!' };
        notif.textContent = labels[speed] || '';
        notif.classList.add('show');
        setTimeout(() => notif.classList.remove('show'), 2500);
    }
});

socket.on('leaderboardUpdate', ({ players }) => {
    renderLeaderboardSidebar(players);
});

socket.on('gameEnded', ({ winnerId, winnerNickname, players }) => {
    stopGame();
    sendScoreUpdate(); // Final score

    const isWinner = winnerId === myId;

    document.getElementById('modal-title').textContent =
        isWinner ? '🎉 HAI VINTO!' : `🏆 Vittoria di ${winnerNickname}!`;
    document.getElementById('modal-subtitle').textContent =
        isWinner ? `Complimenti! Hai ottenuto ${score} punti!` : `${winnerNickname} ha dominato con ${players[0]?.score || 0} punti!`;

    renderFinalLeaderboard(players);

    // Host controls
    const hostOpts = document.getElementById('host-options');
    const newGameBtn = document.getElementById('btn-new-game');
    if (isHost) {
        hostOpts.style.display = 'block';
        newGameBtn.style.display = 'inline-block';
    } else {
        hostOpts.style.display = 'none';
        newGameBtn.style.display = 'none';
    }

    playSound('audio-win');
    showModal();
});

socket.on('playerLeft', ({ playerId, players }) => {
    renderLeaderboardSidebar(players);
    if (document.getElementById('waiting-screen').classList.contains('active')) {
        renderPlayersWaiting(players);
    }
});

socket.on('playerReconnected', ({ nickname, players }) => {
    showFeedback(`${nickname} si è riconnesso!`, 'correct');
    renderLeaderboardSidebar(players);
});

socket.on('playerDisconnected', ({ playerId, nickname }) => {
    showFeedback(`${nickname} si è disconnesso...`, 'wrong');
});

socket.on('reconnectSuccess', ({ roomCode, config: cfg, isHost: wasHost, gameState, players }) => {
    myRoomCode = roomCode;
    isHost = wasHost;
    config = cfg;
    if (isHost) window._clHost = socket.id;

    if (gameState.status === 'playing') {
        currentSpeed = gameState.speed;
        showScreen('game-screen');
        startGameLoop();
        renderLeaderboardSidebar(players);

        if (config.gameMode === 'time') {
            const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
            const remaining = Math.max(0, config.gameModeValue - elapsed);
            document.getElementById('timer-container').style.display = 'flex';
            document.getElementById('target-container').style.display = 'none';
            startCountdown(remaining);
        } else {
            document.getElementById('timer-container').style.display = 'none';
            document.getElementById('target-container').style.display = 'flex';
            document.getElementById('target-value').textContent = config.gameModeValue;
        }
    } else {
        renderPlayersWaiting(players);
        document.getElementById('display-room-code').textContent = roomCode;
        document.getElementById('start-btn').style.display = isHost ? 'inline-block' : 'none';
        showScreen('waiting-screen');
    }
});

socket.on('error', (msg) => {
    const createErr = document.getElementById('create-error');
    const joinErr = document.getElementById('join-error');
    if (document.getElementById('lobby-screen').classList.contains('active')) {
        if (joinErr) joinErr.textContent = msg;
        if (createErr) createErr.textContent = msg;
    } else if (gameActive) {
        showFeedback(msg, 'wrong');
    } else {
        alert(msg);
    }
});

// ─── Modal ───────────────────────────────────────────────────
function showModal() {
    document.getElementById('end-modal').classList.add('active');
}

function hideModal() {
    document.getElementById('end-modal').classList.remove('active');
}

function newGame() {
    const modeSelect = document.getElementById('next-mode-modal');
    const valueSelect = document.getElementById('next-value-modal');
    hideModal();
    socket.emit('newGame', {
        gameMode: modeSelect ? modeSelect.value : config.gameMode,
        gameModeValue: valueSelect ? valueSelect.value : config.gameModeValue
    });
}

// ─── Keyboard Input ──────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (!gameActive) return;
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        e.preventDefault();
        handleKeyPress(e.key);
    }
});

// ─── Mobile Virtual Keyboard ─────────────────────────────────
(function initMobileKeyboard() {
    const kbContainer = document.getElementById('mobile-keyboard-container');
    if (!kbContainer) return;

    kbContainer.addEventListener('click', function (e) {
        const key = e.target.closest('[data-mob-key]');
        if (!key) return;

        const action = key.dataset.mobKey;
        if (action && action.length === 1) {
            handleKeyPress(action);
        }
    });
})();

// Wire up exit button
const btnExit = document.getElementById('btn-exit-game');
if (btnExit) btnExit.addEventListener('click', exitGame);
