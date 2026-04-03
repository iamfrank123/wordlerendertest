// ────────────────────────────────────────────────────────────
//  Maratona – Client Logic
// ────────────────────────────────────────────────────────────

const socket = io('/maratona');

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

// ─── State ───────────────────────────────────────────────────
let myId = null;
let myRoomCode = null;
let isHost = false;
let wordLength = 0;
let revealedMap = {};  // { pos: letter }
let revealCountdown = 10;
let revealTimerInterval = null;
let gameActive = false;

// ─── DOM Helpers ─────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function showFeedback(msg, type /* 'correct' | 'wrong' */) {
    const el = document.getElementById('feedback-msg');
    el.textContent = msg;
    el.className = type;
    clearTimeout(showFeedback._t);
    showFeedback._t = setTimeout(() => { el.textContent = ''; el.className = ''; }, 2500);
}

// ─── Room Code Input auto-uppercase ──────────────────────────
document.getElementById('room-code-input').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
});

// ─── Actions: Lobby ──────────────────────────────────────────
function createRoom() {
    const nickname = document.getElementById('nickname').value.trim();
    const language = document.querySelector('input[name="language"]:checked').value;
    const lengthVal = document.querySelector('input[name="wordLength"]:checked').value;

    if (!nickname) {
        document.getElementById('create-error').textContent = t('mar_error_nickname');
        return;
    }
    document.getElementById('create-error').textContent = '';
    socket.emit('createRoom', { nickname, wordLength: lengthVal, language });
}

function joinRoom() {
    const nickname = document.getElementById('nickname').value.trim();
    const roomCode = document.getElementById('room-code-input').value.trim().toUpperCase();

    if (!nickname) {
        document.getElementById('join-error').textContent = t('mar_error_nickname');
        return;
    }
    if (!roomCode) {
        document.getElementById('join-error').textContent = t('mar_error_code');
        return;
    }
    document.getElementById('join-error').textContent = '';
    socket.emit('joinRoom', { roomCode, nickname });
}

// ─── Actions: Game ───────────────────────────────────────────
function startGame() {
    socket.emit('startGame');
}

function submitWord() {
    const input = document.getElementById('word-input');
    const word = input.value.trim().toUpperCase();
    if (word.length !== wordLength) {
        showFeedback(t('mar_word_length_error', { length: wordLength }), 'wrong');
        return;
    }
    socket.emit('submitWord', word);
    input.value = '';
    input.focus();
}

function nextRound() {
    const lengthSel = document.getElementById('next-length-modal').value;
    const langSel = document.getElementById('next-language-modal').value;
    hideModal();
    socket.emit('nextRound', { wordLength: lengthSel, language: langSel });
}

function exitGame() {
    if (confirm(t('mar_confirm_exit'))) {
        socket.emit('leaveRoom');
        stopRevealTimer();
        window.location.href = '../../index.html';
    }
}

// Enter key on word input
document.getElementById('word-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitWord();
});

// ─── Modal ───────────────────────────────────────────────────
function showModal() {
    document.getElementById('end-modal').classList.add('active');
}

function hideModal() {
    document.getElementById('end-modal').classList.remove('active');
}

// ─── Word Grid ───────────────────────────────────────────────
function buildWordGrid(length, revealed) {
    const grid = document.getElementById('word-grid');
    grid.innerHTML = '';
    grid.style.setProperty('--word-len', length);

    for (let i = 0; i < length; i++) {
        const box = document.createElement('div');
        box.classList.add('letter-box');
        box.id = `box-${i}`;
        if (revealed && revealed[i]) {
            box.textContent = revealed[i];
            box.classList.add('revealed');
        } else {
            box.classList.add('empty');
        }
        grid.appendChild(box);
    }
}

function revealBox(pos, letter) {
    const box = document.getElementById(`box-${pos}`);
    if (!box) return;
    box.classList.remove('empty');
    box.classList.add('revealed');
    box.style.animation = 'none';
    // Trigger reflow for animation restart
    void box.offsetWidth;
    box.style.animation = '';
    box.textContent = letter;
}

// ─── Players Rendering ───────────────────────────────────────
function renderPlayersWaiting(players) {
    const list = document.getElementById('players-list');
    list.innerHTML = players.map(p =>
        `<div class="player-item ${p.id === (window._maratonaHost || '') ? 'host' : ''}">
            ${p.nickname}
        </div>`
    ).join('');
}

function renderPlayersSidebar(players) {
    const el = document.getElementById('players-status');
    const sorted = [...players].sort((a, b) => b.score - a.score);
    el.innerHTML = sorted.map(p =>
        `<div class="player-status-item">
            <span class="player-name">${p.id === myId ? '⭐ ' : ''}${p.nickname}</span>
            <span class="player-score">${p.score} pt</span>
        </div>`
    ).join('');
}

function renderLeaderboard(players) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const body = sorted.map((p, i) =>
        `<tr>
            <td>#${i + 1}</td>
            <td>${p.id === myId ? '⭐ ' : ''}${p.nickname}</td>
            <td>${p.score}</td>
        </tr>`
    ).join('');
    document.getElementById('leaderboard').innerHTML =
        `<table>
            <thead><tr><th>${t('mar_table_rank')}</th><th>${t('mar_table_player')}</th><th>${t('mar_table_points')}</th></tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

// ─── Reveal Countdown Timer ───────────────────────────────────
function startRevealTimer() {
    stopRevealTimer();
    revealCountdown = 10;
    updateRevealBar();
    revealTimerInterval = setInterval(() => {
        revealCountdown--;
        if (revealCountdown < 0) revealCountdown = 10; // reset after reveal
        updateRevealBar();
    }, 1000);
}

function stopRevealTimer() {
    if (revealTimerInterval) {
        clearInterval(revealTimerInterval);
        revealTimerInterval = null;
    }
}

function resetRevealTimer() {
    revealCountdown = 10;
    updateRevealBar();
}

function updateRevealBar() {
    const bar = document.getElementById('reveal-timer-bar');
    const label = document.getElementById('reveal-timer-seconds');
    const pct = (revealCountdown / 10) * 100;
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${revealCountdown}s`;
}

// ─── Socket Events ───────────────────────────────────────────

socket.on('connect', () => {
    myId = socket.id;
    console.log('[MARATONA] Connected:', myId);

    // Auto-reconnect if we drop and reconnect while window is open
    const nicknameInput = document.getElementById('nickname');
    const nickname = nicknameInput ? nicknameInput.value.trim() : null;

    if (myRoomCode && nickname) {
        console.log(`[MARATONA] Attempting to auto-reconnect to ${myRoomCode} as ${nickname}`);
        socket.emit('joinRoom', { roomCode: myRoomCode, nickname: nickname });
    }
});

socket.on('roomCreated', ({ roomCode, config }) => {
    myRoomCode = roomCode;
    isHost = true;
    window._maratonaHost = socket.id;
    document.getElementById('display-room-code').textContent = roomCode;
    document.getElementById('start-btn').style.display = 'block';
    document.getElementById('players-list').innerHTML =
        `<div class="player-item host">${document.getElementById('nickname').value.trim()}</div>`;
    showScreen('waiting-screen');
});

socket.on('playerJoined', ({ players }) => {
    renderPlayersWaiting(players);
    // If we just joined (not host), switch to waiting screen
    if (!myRoomCode && players.find(p => p.id === myId)) {
        myRoomCode = document.getElementById('room-code-input')?.value?.trim()?.toUpperCase();
        document.getElementById('display-room-code').textContent = myRoomCode || '';
        showScreen('waiting-screen');
    }
});

socket.on('newHost', ({ hostId }) => {
    if (hostId === myId) {
        isHost = true;
        document.getElementById('start-btn').style.display = 'block';
    }
});

socket.on('gameStarted', ({ wordLength: wLen, language, players }) => {
    wordLength = wLen;
    revealedMap = {};
    gameActive = true;

    hideModal(); // close end-round modal for all players (non-host included)

    document.getElementById('word-input').value = '';
    document.getElementById('word-input').placeholder = t('mar_word_input_placeholder', { length: wordLength });
    document.getElementById('feedback-msg').textContent = '';

    buildWordGrid(wordLength, {});
    renderPlayersSidebar(players);
    showScreen('game-screen');
    startRevealTimer();
});

socket.on('letterRevealed', ({ position, letter, revealedLetters, revealedCount }) => {
    revealedMap = revealedLetters;
    revealBox(position, letter);
    resetRevealTimer(); // restart 10-second bar

    // Suono tick quando viene rivelata una lettera
    const sndTick = document.getElementById('audio-tick');
    if (sndTick) {
        sndTick.currentTime = 0;
        sndTick.play().catch(e => console.warn('Audio tick blocked', e));
    }
});

socket.on('wordResult', ({ correct, message }) => {
    if (correct) {
        showFeedback(t('mar_correct_processing'), 'correct');
    } else {
        showFeedback(message || t('mar_wrong_default'), 'wrong');
    }
});

socket.on('roundEnded', ({ winnerId, winnerNickname, secretWord, winnerScore, players }) => {
    gameActive = false;
    stopRevealTimer();

    // Suono vittoria fine round
    const sndWin = document.getElementById('audio-win');
    if (sndWin) {
        sndWin.currentTime = 0;
        sndWin.play().catch(e => console.warn('Audio win blocked', e));
    }

    const isWinner = winnerId === myId;
    const noWinner = !winnerId;

    document.getElementById('modal-title').textContent =
        noWinner ? t('mar_no_winner') :
            isWinner ? t('mar_you_won') : t('mar_other_won', { name: winnerNickname });

    document.getElementById('modal-subtitle').textContent =
        noWinner ? t('mar_word_was') :
            isWinner ? t('mar_you_earned', { score: winnerScore }) :
                t('mar_other_earned', { name: winnerNickname, score: winnerScore });

    document.getElementById('modal-word').textContent = secretWord;

    renderLeaderboard(players);

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

    showModal();
});

socket.on('playerLeft', ({ playerId, players }) => {
    renderPlayersSidebar(players);
    if (document.getElementById('waiting-screen').classList.contains('active')) {
        renderPlayersWaiting(players);
    }
});

socket.on('playerReconnected', ({ oldId, newId, nickname, players }) => {
    console.log(`[MARATONA] ${nickname} reconnected.`);
    showFeedback(t('mar_player_reconnected', { name: nickname }), 'correct');

    if (gameActive) {
        renderPlayersSidebar(players);
    } else {
        renderPlayersWaiting(players);
    }
});

socket.on('playerDisconnected', ({ playerId, nickname }) => {
    showFeedback(t('mar_player_disconnected', { name: nickname }), 'wrong');
});

socket.on('reconnectSuccess', ({ roomCode, config, isHost: wasHost, gameState, players }) => {
    myRoomCode = roomCode;
    isHost = wasHost;
    if (isHost) window._maratonaHost = socket.id;

    if (gameState.status === 'lobby') {
        renderPlayersWaiting(players);
        document.getElementById('display-room-code').textContent = roomCode;
        document.getElementById('start-btn').style.display = isHost ? 'block' : 'none';
        showScreen('waiting-screen');
    } else if (gameState.status === 'playing') {
        wordLength = gameState.secretWord ? gameState.secretWord.length : config.wordLength;
        revealedMap = gameState.revealedLetters || {};
        gameActive = true;

        hideModal();
        document.getElementById('word-input').value = '';
        document.getElementById('word-input').placeholder = t('mar_word_input_placeholder', { length: wordLength });
        document.getElementById('feedback-msg').textContent = '';

        buildWordGrid(wordLength, revealedMap);
        renderPlayersSidebar(players);
        showScreen('game-screen');

        startRevealTimer();
    } else if (gameState.status === 'ended') {
        renderLeaderboard(players);
        showScreen('waiting-screen');
        renderPlayersWaiting(players);
    }
});

socket.on('error', (msg) => {
    // Show error in best available place
    const createErr = document.getElementById('create-error');
    const joinErr = document.getElementById('join-error');
    if (document.getElementById('lobby-screen').classList.contains('active')) {
        if (joinErr) joinErr.textContent = msg;
    } else if (gameActive) {
        showFeedback(msg, 'wrong');
    } else {
        alert(msg);
    }
    console.warn('[MARATONA] Server error:', msg);
});

// Wire up exit button
const btnExit = document.getElementById('btn-exit-game');
if (btnExit) btnExit.addEventListener('click', exitGame);

// ─── Mobile Virtual Keyboard ─────────────────────────────────
// Only wires up clicks; CSS controls visibility (hidden on desktop).
(function initMobileKeyboard() {
    const kbContainer = document.getElementById('mobile-keyboard-container');
    if (!kbContainer) return;

    kbContainer.addEventListener('click', function (e) {
        const key = e.target.closest('[data-mob-key]');
        if (!key) return;

        const action = key.dataset.mobKey;
        const input = document.getElementById('word-input');
        if (!input) return;

        if (action === 'BACKSPACE') {
            input.value = input.value.slice(0, -1);
        } else if (action === 'ENTER') {
            submitWord();
        } else {
            // Only append if under word length limit
            if (input.value.length < (wordLength || 8)) {
                input.value += action;
            }
        }
        // Keep focus on input so physical keyboard also works
        input.focus();
    });
})();

// ─── Invite Link Sharing ─────────────────────────────────────
function shareInviteLink() {
    if (!myRoomCode) return;
    const url = `${window.location.origin}${window.location.pathname}?join=${myRoomCode}`;
    const text = `Join my Maratona game! Room: ${myRoomCode}`;

    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: 'Maratona', text, url }).catch(() => {});
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
                    showFeedback('📋 Link copiato!', 'correct');
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
            showFeedback('📋 Link copiato!', 'correct');
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

// ─── Room Persistence (keepalive when backgrounded) ──────────
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
