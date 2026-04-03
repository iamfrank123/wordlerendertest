// --- SPLASH SCREEN LOGIC ---
window.addEventListener('DOMContentLoaded', () => {
    const splashScreen = document.getElementById('splash-screen');
    setTimeout(() => {
        if (splashScreen) {
            splashScreen.style.opacity = '0';
            setTimeout(() => {
                splashScreen.style.display = 'none';
            }, 500);
        }
    }, 3000);
});

if (typeof io === 'undefined') {
    alert("Errore: Socket.io non caricato! Assicurati di:\n1. Avviare il server con 'npm start'\n2. Cancellare il Service Worker (F12 → Application → Service Workers → Unregister)\n3. Ricaricare la pagina con Ctrl+Shift+R");
    throw new Error("Socket.io not found");
}
const socket = io();

// [keep-alive Render.com] Pinga il server ogni 4 minuti per evitare il sleep su Render free tier
const SERVER_URL = window.location.origin;
setInterval(() => {
    fetch(SERVER_URL + '/ping')
        .then(() => console.log('[keep-alive] server sveglio'))
        .catch(() => console.warn('[keep-alive] server non raggiungibile'));
}, 4 * 60 * 1000); // ogni 4 minuti

// [keep-alive Render.com] Gestione reconnect automatico dopo disconnessione
socket.on('disconnect', (reason) => {
    console.warn('[socket] disconnesso:', reason);
    if (reason === 'io server disconnect') {
        // Il server ha forzato la disconnessione — riconnetti manualmente
        socket.connect();
    }
    // Negli altri casi socket.io si riconnette automaticamente
});

socket.on('reconnect', (attemptNumber) => {
    console.log('[socket] riconnesso dopo', attemptNumber, 'tentativi');
});

socket.on('reconnect_error', (error) => {
    console.error('[socket] errore riconnessione:', error);
});


const lobbyContainer = document.getElementById('lobby-container');
const gameContainer = document.getElementById('game-container');
const lobbyMessage = document.getElementById('lobby-message');
const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const gridContainer = document.getElementById('grid-container');
const playerTurnH3 = document.getElementById('player-turn');
const gameMessageP = document.getElementById('game-message');
const keyboardContainer = document.getElementById('keyboard-container');
const languageSelect = document.getElementById('languageSelect');
const backToLobbyBtn = document.getElementById('back-to-lobby-btn');

// ------------------ SUONI ------------------
const soundWin = new Audio('audio/audio_win.mp3');
const soundTurn = new Audio('audio/audio_turn.mp3');
const soundTick = new Audio('audio/tick.mp3'); // il tuo suono "tick"
const soundMyTurn = new Audio('audio/myturn.mp3'); // suono "bell" soft


let gameStatusDiv = document.getElementById('game-status');
let rematchBtn = null;

let currentRoomCode = '';
let isMyTurn = false;
let currentGuess = '';
let currentRowIndex = 0;
const WORD_LENGTH = 5;
let totalRows = 6;
let keyStates = {};

// ------------------ TIMER ------------------
let turnTime = 45;
let turnTimerId = null;

function startTurnTimer() {
    clearInterval(turnTimerId);
    turnTime = 45;
    updateTimerDisplay();

    turnTimerId = setInterval(() => {
        turnTime--;
        updateTimerDisplay();

        // Suono a 8 secondi
        if (turnTime === 8) {
            soundTick.play();
        }

        if (turnTime <= 0) {
            clearInterval(turnTimerId);
            timeUp();
        }
    }, 1000);
}


function updateTimerDisplay() {
    const timerDiv = document.getElementById('turn-timer');
    if (timerDiv) timerDiv.textContent = TranslationManager.t('timer_prefix') + turnTime + 's';
}

function timeUp() {
    gameMessageP.textContent = TranslationManager.t('msg_time_up');
    socket.emit('passTurn'); // server gestisce cambio turno
}

// ------------------ GRID ------------------

function generateGrid(rows) {
    gridContainer.innerHTML = '';
    totalRows = rows;
    for (let r = 0; r < totalRows; r++) {
        addNewRow();
    }
    updateCurrentRowVisual();
}

function addNewRow() {
    const r = gridContainer.children.length;
    const rowDiv = document.createElement('div');
    rowDiv.className = 'grid-row';
    rowDiv.id = `row-${r}`;

    for (let c = 0; c < WORD_LENGTH; c++) {
        const boxDiv = document.createElement('div');
        boxDiv.className = 'box';
        boxDiv.id = `box-${r}-${c}`;
        rowDiv.appendChild(boxDiv);
    }

    gridContainer.appendChild(rowDiv);
    totalRows = gridContainer.children.length;
    updateCurrentRowVisual();
}

function updateCurrentRowVisual() {
    document.querySelectorAll('.grid-row').forEach(row => row.classList.remove('current-row'));
    const currentRowElement = document.getElementById(`row-${currentRowIndex}`);
    if (currentRowIndex < totalRows && currentRowElement) {
        currentRowElement.classList.add('current-row');
    }
}

function updateGridState(gridData) {
    gridData.forEach((attempt, r) => {
        const rowElement = document.getElementById(`row-${r}`);
        if (rowElement) {
            const boxes = rowElement.querySelectorAll('.box');

            attempt.word.split('').forEach((letter, c) => {
                boxes[c].textContent = letter;
            });

            attempt.feedback.forEach((feedbackClass, c) => {
                boxes[c].classList.add(feedbackClass);
            });

            updateKeyboardFeedback(attempt.word, attempt.feedback);
        }
    });
}

// ------------------ INPUT ------------------

function handleKeyInput(key) {
    if (!isMyTurn || currentRowIndex >= totalRows) return;
    if (playerTurnH3.textContent.includes("Waiting for the server...")) return;

    const char = key.toUpperCase();

    if (char === 'ENTER') {
        submitCurrentGuess();
    } else if (char === 'BACKSPACE' || char === 'DELETE') {
        currentGuess = currentGuess.slice(0, -1);
        gameMessageP.textContent = '';
    } else if (char.length === 1 && /^[A-Z]$/.test(char) && currentGuess.length < WORD_LENGTH) {
        currentGuess += char;
        gameMessageP.textContent = '';
    }

    const rowBoxes = document.getElementById(`row-${currentRowIndex}`)?.querySelectorAll('.box');
    if (rowBoxes) {
        for (let i = 0; i < WORD_LENGTH; i++) {
            rowBoxes[i].textContent = currentGuess[i] || '';
        }
    }
}

document.addEventListener('keyup', (e) => {
    handleKeyInput(e.key);
});

// ------------------ KEYBOARD ------------------

function generateKeyboard() {
    const rows = [
        ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
        ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
        ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACKSPACE'],
    ];

    keyboardContainer.innerHTML = '';

    rows.forEach(rowKeys => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'keyboard-row';

        rowKeys.forEach(keyText => {
            const key = document.createElement('div');
            key.className = 'key';
            key.textContent = keyText;
            key.id = `key-${keyText}`;

            if (keyText === 'ENTER' || keyText === 'BACKSPACE') key.classList.add('wide-key');
            if (keyStates[keyText]) key.classList.add(keyStates[keyText]);

            key.addEventListener('click', () => handleKeyInput(keyText));
            rowDiv.appendChild(key);

            keyStates[keyText] = keyStates[keyText] || '';
        });

        keyboardContainer.appendChild(rowDiv);
    });
}

generateKeyboard();

// --- BACK TO LOBBY BUTTON ---
if (backToLobbyBtn) {
    backToLobbyBtn.addEventListener('click', () => {
        showGameModal(
            TranslationManager.t('back_lobby'),
            TranslationManager.t('leave_game_msg'),
            () => {
                location.reload();
            }
        );
    });
}

// --- CUSTOM MODAL FUNCTIONS ---
function showGameModal(title, message, onConfirm) {
    const overlay = document.getElementById('game-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    if (!overlay) return;

    modalTitle.textContent = title;
    modalMessage.textContent = message;

    // Reset buttons
    confirmBtn.style.display = 'block';
    cancelBtn.style.display = 'block';
    confirmBtn.textContent = TranslationManager.t('btn_confirm');

    overlay.style.display = 'flex';

    // Remove old event listeners by cloning
    const newConfirmBtn = confirmBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newConfirmBtn.addEventListener('click', () => {
        hideGameModal();
        if (onConfirm) onConfirm();
    });

    newCancelBtn.addEventListener('click', hideGameModal);
}

function showGameAlert(title, message) {
    const overlay = document.getElementById('game-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    if (!overlay) return;

    modalTitle.textContent = title;
    modalMessage.textContent = message;

    // Alert mode: only OK button
    confirmBtn.style.display = 'block';
    cancelBtn.style.display = 'none';
    confirmBtn.textContent = TranslationManager.t('btn_ok');

    overlay.style.display = 'flex';

    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.addEventListener('click', hideGameModal);
}

function hideGameModal() {
    const overlay = document.getElementById('game-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

function submitCurrentGuess() {
    if (currentGuess.length === WORD_LENGTH) {
        gameMessageP.textContent = TranslationManager.t('msg_verifying');
        playerTurnH3.textContent = TranslationManager.t('msg_waiting_server');
        socket.emit('submitWord', currentGuess);
    } else {
        gameMessageP.textContent = TranslationManager.t('msg_word_length_error', { length: WORD_LENGTH });
    }
}

function updateKeyboardFeedback(word, feedback) {
    const letters = word.split('');
    letters.forEach((letter, index) => {
        const keyElement = document.getElementById(`key-${letter}`);
        if (!keyElement) return;

        const newClass = feedback[index]; // "correct-position", "wrong-position", "not-in-word"

        if (newClass === 'not-in-word') {
            keyElement.classList.remove('correct-position', 'wrong-position');
            keyElement.classList.add('not-in-word');
        } else {
            keyElement.classList.remove('not-in-word');
            keyElement.classList.add('correct-position');
        }
    });
}

// ------------------ REMATCH ------------------

function createRematchButton() {
    if (rematchBtn) rematchBtn.remove();

    rematchBtn = document.createElement('button');
    rematchBtn.textContent = TranslationManager.t('btn_rematch');
    rematchBtn.style.padding = '10px 20px';
    rematchBtn.style.marginTop = '15px';
    rematchBtn.style.cursor = 'pointer';

    rematchBtn.addEventListener('click', () => {
        socket.emit('requestRematch');
        rematchBtn.textContent = TranslationManager.t('btn_rematch_sent');
        rematchBtn.disabled = true;
    });

    gameStatusDiv.appendChild(rematchBtn);
}

function resetGameInterface() {
    if (rematchBtn) {
        rematchBtn.remove();
        rematchBtn = null;
    }

    clearInterval(turnTimerId);
    isMyTurn = false;
    currentGuess = '';
    currentRowIndex = 0;
    totalRows = 6;
    keyStates = {};

    playerTurnH3.textContent = TranslationManager.t('status_waiting_opponent');
    gameMessageP.textContent = TranslationManager.t('msg_new_game_started');
    generateGrid(6);
    generateKeyboard();
}

// ------------------ SOCKET.IO ------------------

// CREA STANZA CON LINGUA (Multiplayer Arena - only if elements exist)
if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => {
        const selectedLanguage = languageSelect.value;
        socket.emit('createRoom', selectedLanguage);
        if (lobbyMessage) lobbyMessage.textContent = TranslationManager.t('msg_creating_room');
        createRoomBtn.disabled = true;
        if (joinRoomBtn) joinRoomBtn.disabled = true;
    });
}

if (joinRoomBtn) {
    joinRoomBtn.addEventListener('click', () => {
        const code = roomCodeInput.value.trim().toUpperCase();
        if (code.length === 4) {
            socket.emit('joinRoom', code);
            if (lobbyMessage) lobbyMessage.textContent = TranslationManager.t('msg_attempt_join', { code: code });
            if (createRoomBtn) createRoomBtn.disabled = true;
            joinRoomBtn.disabled = true;
        } else {
            if (lobbyMessage) lobbyMessage.textContent = TranslationManager.t('msg_enter_valid_code');
        }
    });
}

// DUELLO MODE BUTTONS
const createDuelloBtn = document.getElementById('create-duello-btn');
const joinDuelloBtn = document.getElementById('join-duello-btn');
const duelloCodeInput = document.getElementById('duello-code-input');

if (createDuelloBtn) {
    createDuelloBtn.addEventListener('click', () => {
        window.location.href = 'duello.html?mode=create';
    });
}

if (joinDuelloBtn) {
    joinDuelloBtn.addEventListener('click', () => {
        const code = duelloCodeInput.value.trim().toUpperCase();
        if (code.length === 4) {
            window.location.href = `duello.html?mode=join&room=${code}`;
        } else {
            lobbyMessage.textContent = TranslationManager.t('msg_enter_valid_code');
        }
    });
}

// ALL VS ALL BUTTONS
const joinAllVsAllBtn = document.getElementById('join-all-vs-all-btn');
const allVsAllCodeInput = document.getElementById('all-vs-all-code-input');

if (joinAllVsAllBtn) {
    joinAllVsAllBtn.addEventListener('click', () => {
        const code = allVsAllCodeInput.value.trim().toUpperCase();
        if (code.length === 4) {
            window.location.href = `all_vs_all.html?mode=join&room=${code}`;
        } else {
            lobbyMessage.textContent = TranslationManager.t('msg_enter_valid_code');
        }
    });
}

socket.on('roomCreated', (code) => {
    currentRoomCode = code;
    const langText = languageSelect.value === "en" ? "English" : "Italiano";
    lobbyMessage.textContent = TranslationManager.t('msg_room_created', { code: code, lang: langText });
});

socket.on('lobbyMessage', (msg) => {
    lobbyMessage.textContent = msg;
    if (!currentRoomCode) {
        createRoomBtn.disabled = false;
        joinRoomBtn.disabled = false;
    }
});

socket.on('lobbyError', (msg) => {
    lobbyMessage.textContent = `ERRORE: ${msg}`;
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
});

socket.on('startGame', (roomCode, players) => {
    currentRoomCode = roomCode;
    lobbyContainer.style.display = 'none';
    gameContainer.style.display = 'flex';
    document.body.classList.add('game-active');
    gameMessageP.textContent = TranslationManager.t('msg_game_started');
    resetGameInterface();
});

socket.on('updateTurnStatus', (status) => {
    isMyTurn = status.isTurn;
    playerTurnH3.textContent = status.message; // From Server but could be translated if we detect key

    if (isMyTurn) {
        gameMessageP.textContent = TranslationManager.t('msg_your_turn');
        soundMyTurn.play(); // suono solo sul tuo turno
        startTurnTimer();
    } else {
        clearInterval(turnTimerId);
        gameMessageP.textContent = TranslationManager.t('msg_opponent_turn');
        currentGuess = '';
        const rowBoxes = document.getElementById(`row-${currentRowIndex}`)?.querySelectorAll('.box');
        if (rowBoxes) rowBoxes.forEach(box => box.textContent = '');
    }

    updateCurrentRowVisual();
    scrollToBottom();
});


socket.on('updateGameState', (state) => {
    updateGridState(state.grid);
    currentRowIndex = state.currentRow;
    totalRows = state.maxRows;

    while (gridContainer.children.length < totalRows) {
        addNewRow();
    }

    updateGridState(state.grid);
    currentGuess = '';
    updateCurrentRowVisual();
    scrollToBottom();
});

function scrollToBottom() {
    const container = document.getElementById('game-container');
    if (container) {
        setTimeout(() => {
            container.scrollTop = container.scrollHeight;
        }, 100);
    }
}

socket.on('gameOver', (data) => {
    clearInterval(turnTimerId);
    isMyTurn = false;
    const winnerText = data.winner === socket.id ? TranslationManager.t('msg_you') : TranslationManager.t('msg_opponent');
    playerTurnH3.textContent = TranslationManager.t('msg_game_ended', { winner: winnerText });
    gameMessageP.textContent = TranslationManager.t('msg_secret_word', { word: data.secretWord });
    currentGuess = '';

    if (data.winner === socket.id) {
        soundWin.play();
    }

    createRematchButton();
});

socket.on('rematchRequested', (msg) => {
    gameMessageP.textContent = msg; // msg from server usually
    createRematchButton();
    rematchBtn.textContent = TranslationManager.t('btn_accept_rematch');
});

socket.on('rematchStart', () => {
    resetGameInterface();
    gameMessageP.textContent = TranslationManager.t('msg_rematch_accepted');
});

socket.on('opponentDisconnected', (message) => {
    clearInterval(turnTimerId);
    isMyTurn = false;
    playerTurnH3.textContent = 'Game Ended';
    gameMessageP.textContent = message;
    if (rematchBtn) rematchBtn.remove();
    showGameAlert(TranslationManager.t('msg_opponent_disconnected'), TranslationManager.t('msg_opponent_disconnected_desc'));
});

socket.on('gameError', (msg) => {
    gameMessageP.textContent = `ERRORE GIOCO: ${msg}`;
    if (isMyTurn) playerTurnH3.textContent = "Your turn!";
});
