// duello.js
// Client-side logic for Duello a Parole mode

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
        socket.connect(); // riconnetti manualmente solo se il server ha forzato la disconnessione
    }
});


// DOM Elements
const setupContainer = document.getElementById('duello-setup-container');
const gameContainer = document.getElementById('duello-game-container');
const secretWordInput = document.getElementById('secret-word-input');
const hintInput = document.getElementById('hint-input');
const readyBtn = document.getElementById('ready-btn');
const setupMessage = document.getElementById('setup-message');
const ownGridContainer = document.getElementById('own-grid-container');
const opponentGridContainer = document.getElementById('opponent-grid-container');
const keyboardContainer = document.getElementById('duello-keyboard-container');
const opponentHintDisplay = document.getElementById('opponent-hint');
const duelloGameMessage = document.getElementById('duello-game-message');
const backToLobbySetupBtn = document.getElementById('back-to-lobby-setup-btn');
const backToLobbyGameBtn = document.getElementById('back-to-lobby-game-btn');

// Game State
let currentGuess = '';
let ownGrid = [];
let opponentGrid = [];
const WORD_LENGTH = 5;
let hintsEnabled = true;
let gameStarted = false;
let roomCode = '';

// Initialize Player Session
let playerId = localStorage.getItem('duelloPlayerId');
if (!playerId) {
    playerId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
    localStorage.setItem('duelloPlayerId', playerId);
}

// Get room code and state from URL or Storage
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode');
const urlRoomCode = urlParams.get('room');

// Check for active session to rejoin
let savedRoom = localStorage.getItem('duelloCurrentRoom');

// FIX: Race Condition
// If we are explicitly creating or joining a NEW room via URL (from Lobby), 
// we must ignore/clear any previous saved session to prevent auto-rejoin conflict.
if ((mode === 'create' && !urlRoomCode) || (mode === 'join' && urlRoomCode)) {
    console.log("Explicit new game mode detected. Clearing stale session.");
    localStorage.removeItem('duelloCurrentRoom');
    savedRoom = null;
}

// Initialize
if (mode === 'create') {
    // New Game as Host
    const lang = localStorage.getItem('language') || 'it';
    socket.emit('createDuelloRoom', { language: lang, playerId: playerId });
} else if (mode === 'join' && urlRoomCode) {
    // New Game as Guest
    socket.emit('joinDuelloRoom', { roomCode: urlRoomCode, playerId: playerId });
    // Hide hints checkbox for guest
    const hintsCheckboxFn = document.getElementById('hints-enabled-checkbox');
    if (hintsCheckboxFn && hintsCheckboxFn.parentElement) {
        hintsCheckboxFn.parentElement.style.display = 'none';
    }
} else if (savedRoom && !mode) {
    // Attempt Rejoin
    console.log('Tentativo di riconnessione alla stanza:', savedRoom);
    socket.emit('rejoinDuelloRoom', { roomCode: savedRoom, playerId: playerId });
    roomCode = savedRoom;
} else {
    // Clear stale state if land here without params
    localStorage.removeItem('duelloCurrentRoom');
}

// ========== SETUP HANDLERS ==========

readyBtn.addEventListener('click', () => {
    const secretWord = secretWordInput.value.trim().toUpperCase();
    const hint = hintInput.value.trim();

    if (secretWord.length !== WORD_LENGTH) {
        setupMessage.textContent = TranslationManager.t('msg_word_length_error', { length: WORD_LENGTH });
        setupMessage.style.color = '#ff6b6b';
        return;
    }

    // Capture hints preference (only if Host)
    const hintsCheckbox = document.getElementById('hints-enabled-checkbox');
    if (hintsCheckbox && mode === 'create') {
        hintsEnabled = hintsCheckbox.checked;
    }

    // Send hintsEnabled only if Host (server will handle room storage)
    socket.emit('setSecretWord', {
        word: secretWord,
        hint: hint,
        hintsEnabled: (mode === 'create' ? hintsEnabled : null)
    });
});

// ========== CONNECTION HANDLERS ==========

socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
    // Automatic Rejoin on Reconnection (e.g., wifi flicker)
    const savedRoom = localStorage.getItem('duelloCurrentRoom');
    const pid = localStorage.getItem('duelloPlayerId');

    // Only rejoin if we have a room and we're not possibly in the middle of creating/joining via URL (which handles itself)
    // Actually, safe to just emit if we have data. Server handles duplicates.
    if (savedRoom && pid) {
        console.log('Riconnessione socket rilevata. Tentativo di rejoin...');
        socket.emit('rejoinDuelloRoom', { roomCode: savedRoom, playerId: pid });
    }
});

// ========== SOCKET EVENTS ==========

socket.on('duelloRoomCreated', (code) => {
    roomCode = code;
    localStorage.setItem('duelloCurrentRoom', roomCode); // Save session
    setupMessage.textContent = TranslationManager.t('msg_room_created', { code: code, lang: 'IT' }); // Lang hardcoded here? No we should get it.
    setupMessage.style.color = '#51cf66';

    // Update URL
    window.history.replaceState({}, '', `duello.html?mode=create&room=${code}`);
});

socket.on('duelloRoomJoined', (code) => {
    roomCode = code;
    localStorage.setItem('duelloCurrentRoom', roomCode); // Save session
    setupMessage.textContent = TranslationManager.t('msg_connected_room', { code: code });
    setupMessage.style.color = '#51cf66';
});

socket.on('gameStateSync', (state) => {
    console.log('Game State Synced:', state);
    gameStarted = state.gameStarted;
    roomCode = state.roomCode;
    hintsEnabled = state.hintsEnabled;

    if (state.gameStarted) {
        // Restore Game UI
        setupContainer.style.display = 'none';
        gameContainer.style.display = 'flex';

        // Restore Hints
        if (state.opponentHint) opponentHintDisplay.textContent = state.opponentHint;

        // Restore Grids
        ownGrid = state.ownGrid || [];
        opponentGrid = state.opponentGrid || []; // This should be the SCRAMBLED/MASKED version from server if hard mode

        // Regenerate core UI
        generateGrid(ownGridContainer);
        generateGrid(opponentGridContainer);
        generateKeyboard();

        // Populate Grids
        updateGrid(ownGridContainer, ownGrid);
        updateGrid(opponentGridContainer, opponentGrid);

        // Update Keyboard coloring
        if (ownGrid.length > 0) {
            // Re-apply verify all keyboard colors
            ownGrid.forEach(attempt => {
                updateKeyboardFeedback(attempt.word, attempt.feedback);
            });
        }

        updateCurrentRow(ownGridContainer);
        if (!duelloGameMessage.innerHTML.includes('<span')) // Avoid overwriting complex messages
            duelloGameMessage.innerHTML = state.message || TranslationManager.t('duel_msg_guess_opponent');
    } else {
        // Restore Setup UI (if in setup phase)
        setupMessage.textContent = TranslationManager.t('msg_connected_room', { code: state.roomCode });
        setupMessage.style.color = '#51cf66';

        if (state.hasSetSecret) {
            setupMessage.textContent = "Hai già impostato la parola. In attesa dell'avversario...";
            secretWordInput.disabled = true;
            hintInput.disabled = true;
            readyBtn.disabled = true;
        }
    }
});

socket.on('opponentStatus', (status) => {
    // Handle opponent connection status
    const statusDiv = document.getElementById('duello-game-message');
    if (status.connected) {
        statusDiv.innerHTML = status.message || TranslationManager.t('msg_opponent_reconnected');
        setTimeout(() => {
            if (gameStarted) statusDiv.innerHTML = TranslationManager.t('duel_msg_guess_opponent');
        }, 3000);
    } else {
        statusDiv.innerHTML = `<span style="color: #ffd43b;">⚠️ ${status.message || TranslationManager.t('msg_opponent_waiting')}</span>`;
    }
});

socket.on('duelloPlayerJoined', (data) => {
    setupMessage.textContent = data.message;
    setupMessage.style.color = '#51cf66';
});

socket.on('playerLeft', () => {
    // Opponent left handling
    gameStarted = false;
    const statusDiv = document.getElementById('duello-game-message');
    if (statusDiv) {
        statusDiv.innerHTML = `<span style="color: #ff6b6b; font-weight:bold;">Il tuo avversario si è disconnesso.</span><br>La partita è terminata.`;
    }
    // Also update setup message if in lobby
    if (setupMessage) {
        setupMessage.textContent = "Il tuo avversario ha lasciato la stanza.";
        setupMessage.style.color = '#ff6b6b';
    }

    // Disable inputs
    if (secretWordInput) secretWordInput.disabled = false;
    if (hintInput) hintInput.disabled = false;
    if (readyBtn) readyBtn.disabled = false;
});

socket.on('secretWordSet', (message) => {
    setupMessage.textContent = message;
    setupMessage.style.color = '#51cf66';

    // Disable inputs
    secretWordInput.disabled = true;
    hintInput.disabled = true;
    readyBtn.disabled = true;

    // Detect Self-Join / Testing Scenario
    // If I just joined and I'm already set, I might want to be the OTHER player.
    const resetBtn = document.createElement('button');
    resetBtn.className = 'secondary-btn';
    resetBtn.style.marginTop = '10px';
    resetBtn.style.fontSize = '0.9em';
    resetBtn.innerHTML = "🔄 Test: Entra come Nuovo Giocatore";
    resetBtn.onclick = () => {
        if (confirm("Vuoi generare una nuova identità per testare contro te stesso?")) {
            localStorage.removeItem('duelloPlayerId'); // Clear ID
            location.reload(); // Refresh to generate new one
        }
    };
    setupMessage.appendChild(document.createElement('br'));
    setupMessage.appendChild(resetBtn);

    // Emit ready
    socket.emit('playerReady');
});

socket.on('waitingForOpponent', (message) => {
    setupMessage.textContent = message;
    setupMessage.style.color = '#ffd43b';
});

socket.on('duelloGameStart', (data) => {
    gameStarted = true;

    // Update hintsEnabled from server (Host's choice)
    if (typeof data.hintsEnabled !== 'undefined') {
        hintsEnabled = data.hintsEnabled;
    }

    // Hide setup, show game
    setupContainer.style.display = 'none';
    gameContainer.style.display = 'flex';

    // Display opponent hint
    opponentHintDisplay.textContent = data.opponentHint;

    // Initialize grids
    ownGridContainer.innerHTML = '';
    opponentGridContainer.innerHTML = '';
    generateGrid(ownGridContainer);
    generateGrid(opponentGridContainer);
    generateKeyboard();

    duelloGameMessage.textContent = TranslationManager.t('duel_msg_guess_opponent');
});

socket.on('duelloGuessResult', (data) => {
    ownGrid = data.ownGrid;

    let displayGrid = ownGrid;
    let displayFeedback = data.feedback;

    if (!hintsEnabled) {
        // Hard mode: Mask feedback unless it's a full win
        // Check if the current guess is the winning one
        const isWin = data.feedback.every(f => f === 'correct');

        if (!isWin) {
            displayGrid = ownGrid.map(att => {
                const attWin = att.feedback.every(f => f === 'correct');
                if (attWin) return att;
                return { word: att.word, feedback: att.feedback.map(() => 'neutral') };
            });
            displayFeedback = new Array(5).fill('neutral');
        }
    }

    updateGrid(ownGridContainer, displayGrid);
    updateKeyboardFeedback(data.word, displayFeedback);
    currentGuess = '';
    updateCurrentRow(ownGridContainer);
});

socket.on('opponentGuessUpdate', (data) => {
    opponentGrid = data.opponentGrid;
    updateGrid(opponentGridContainer, opponentGrid);
});

socket.on('duelloGameOver', (data) => {
    gameStarted = false;

    if (data.won) {
        duelloGameMessage.innerHTML = `<span style="color: #51cf66;">${TranslationManager.t('duel_msg_win')}</span><br>${TranslationManager.t('msg_secret_word', { word: data.secretWord })}`;
    } else {
        duelloGameMessage.innerHTML = `<span style="color: #ff6b6b;">${TranslationManager.t('duel_msg_lose')}</span><br>${TranslationManager.t('duel_msg_your_word_was', { word: data.secretWord })}`;
    }

    // Show rematch button
    createRematchButton();
});

socket.on('duelloRematchStart', (message) => {
    resetGameUI();
    setupMessage.textContent = message;
    setupMessage.style.color = '#51cf66';
});

socket.on('duelloRematchRequested', (message) => {
    duelloGameMessage.textContent = message;
});

socket.on('duelloError', (message) => {
    if (gameStarted) {
        duelloGameMessage.textContent = message;
        duelloGameMessage.style.color = '#ff6b6b';
    } else {
        setupMessage.textContent = message;
        setupMessage.style.color = '#ff6b6b';
    }
});

// ========== GRID FUNCTIONS ==========

function generateGrid(container) {
    container.innerHTML = '';
    // Start with 6 rows
    for (let i = 0; i < 6; i++) {
        addRow(container);
    }
}

function addRow(container) {
    const row = document.createElement('div');
    row.classList.add('grid-row');

    for (let i = 0; i < WORD_LENGTH; i++) {
        const tile = document.createElement('div');
        tile.classList.add('box');
        row.appendChild(tile);
    }

    container.appendChild(row);

    // Scroll the game container so the latest row is visible
    setTimeout(() => {
        const gameContainer = document.getElementById('duello-game-container');
        if (gameContainer) gameContainer.scrollTop = gameContainer.scrollHeight;
    }, 50);
}

function updateGrid(container, gridData) {
    const rows = container.querySelectorAll('.grid-row');

    // Clear all rows first
    rows.forEach(row => {
        const tiles = row.querySelectorAll('.box');
        tiles.forEach(tile => {
            tile.textContent = '';
            tile.className = 'box';
        });
    });

    // Fill with data
    gridData.forEach((attempt, rowIndex) => {
        if (rowIndex < rows.length) {
            const tiles = rows[rowIndex].querySelectorAll('.box');
            attempt.word.split('').forEach((letter, colIndex) => {
                tiles[colIndex].textContent = letter;

                // Map feedback to standard classes
                let feedbackClass = '';
                if (attempt.feedback[colIndex] === 'correct') feedbackClass = 'correct-position';
                else if (attempt.feedback[colIndex] === 'present') feedbackClass = 'wrong-position';
                else if (attempt.feedback[colIndex] === 'absent') feedbackClass = 'not-in-word';

                if (feedbackClass) tiles[colIndex].classList.add(feedbackClass);
            });
        }
    });

    // Add more rows if needed
    while (container.querySelectorAll('.grid-row').length <= gridData.length) {
        addRow(container);
    }
}

function updateCurrentRow(container) {
    const rows = container.querySelectorAll('.grid-row');
    const currentRowIndex = ownGrid.length;

    // Reset current-row class
    rows.forEach(row => row.classList.remove('current-row'));

    if (currentRowIndex < rows.length) {
        const currentRow = rows[currentRowIndex];
        currentRow.classList.add('current-row');

        const tiles = currentRow.querySelectorAll('.box');
        const letters = currentGuess.split('');

        tiles.forEach((tile, index) => {
            tile.textContent = letters[index] || '';
            tile.className = 'box';
            // Standard game relies on content and .current-row for styling
        });
    }
}

// ========== KEYBOARD ==========

function generateKeyboard() {
    const rows = [
        ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
        ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
        ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
    ];

    keyboardContainer.innerHTML = '';

    rows.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.classList.add('keyboard-row');

        row.forEach(key => {
            const keyBtn = document.createElement('div');
            keyBtn.classList.add('key');
            keyBtn.textContent = key;
            keyBtn.dataset.key = key;

            if (key === 'ENTER' || key === '⌫') {
                keyBtn.classList.add('wide-key');
            }

            keyBtn.addEventListener('click', () => handleKeyInput(key));
            rowDiv.appendChild(keyBtn);
        });

        keyboardContainer.appendChild(rowDiv);
    });
}

function updateKeyboardFeedback(word, feedback) {
    const letters = word.split('');

    letters.forEach((letter, index) => {
        const keyBtn = keyboardContainer.querySelector(`[data-key="${letter}"]`);
        if (keyBtn) {
            const currentClass = keyBtn.classList.contains('correct-position') ? 'correct-position' :
                keyBtn.classList.contains('wrong-position') ? 'wrong-position' :
                    keyBtn.classList.contains('not-in-word') ? 'not-in-word' : '';

            let newClass = '';
            if (feedback[index] === 'correct') newClass = 'correct-position';
            else if (feedback[index] === 'present') newClass = 'wrong-position';
            else if (feedback[index] === 'absent') newClass = 'not-in-word';

            // Priority: correct-position > wrong-position > not-in-word
            if (newClass === 'correct-position' ||
                (newClass === 'wrong-position' && currentClass !== 'correct-position') ||
                (newClass === 'not-in-word' && !currentClass)) {

                keyBtn.classList.remove('correct-position', 'wrong-position', 'not-in-word');
                if (newClass) keyBtn.classList.add(newClass);
            }
        }
    });
}

// ========== INPUT HANDLING ==========

function resetGameUI() {
    gameStarted = false;
    currentGuess = '';
    ownGrid = [];
    opponentGrid = [];

    // Clear session for room, but KEEP playerId
    localStorage.removeItem('duelloCurrentRoom');

    // Clear DOM grids
    if (ownGridContainer) ownGridContainer.innerHTML = '';
    if (opponentGridContainer) opponentGridContainer.innerHTML = '';

    // Enable setup inputs
    if (secretWordInput) {
        secretWordInput.value = '';
        secretWordInput.disabled = false;
    }
    if (hintInput) {
        hintInput.value = '';
        hintInput.disabled = false;
    }
    if (readyBtn) readyBtn.disabled = false;

    // Reset UI visibility
    if (setupContainer) setupContainer.style.display = 'flex';
    if (gameContainer) gameContainer.style.display = 'none';
    if (duelloGameMessage) duelloGameMessage.textContent = '';

    // Remove rematch button if exists
    const existingRematchBtn = document.getElementById('duello-rematch-btn');
    if (existingRematchBtn) existingRematchBtn.remove();
}

function handleKeyInput(key) {
    if (!gameStarted) return;

    if (key === 'ENTER') {
        submitGuess();
    } else if (key === '⌫' || key === 'BACKSPACE') {
        currentGuess = currentGuess.slice(0, -1);
        updateCurrentRow(ownGridContainer);
    } else if (currentGuess.length < WORD_LENGTH) {
        const letter = key.toUpperCase();
        if (/^[A-Z]$/.test(letter)) {
            currentGuess += letter;
            updateCurrentRow(ownGridContainer);
        }
    }
}

document.addEventListener('keydown', (e) => {
    if (!gameStarted) return;

    if (e.key === 'Enter') {
        handleKeyInput('ENTER');
    } else if (e.key === 'Backspace') {
        handleKeyInput('⌫');
    } else if (/^[a-zA-Z]$/.test(e.key)) {
        handleKeyInput(e.key.toUpperCase());
    }
});

function submitGuess() {
    if (currentGuess.length !== WORD_LENGTH) {
        duelloGameMessage.textContent = TranslationManager.t('msg_word_length_error', { length: WORD_LENGTH });
        duelloGameMessage.style.color = '#ff6b6b';
        return;
    }

    socket.emit('submitDuelloGuess', currentGuess);
}

// ========== REMATCH ==========

function createRematchButton() {
    const existingBtn = document.getElementById('duello-rematch-btn');
    if (existingBtn) return;

    const rematchBtn = document.createElement('button');
    rematchBtn.id = 'duello-rematch-btn';
    rematchBtn.className = 'primary-btn';
    rematchBtn.innerHTML = '<span class="btn-icon">🔄</span> Rivincita';
    rematchBtn.style.marginTop = '20px';

    rematchBtn.addEventListener('click', () => {
        socket.emit('duelloRematch');
        rematchBtn.disabled = true;
        rematchBtn.textContent = TranslationManager.t('btn_rematch_sent');
    });

    document.getElementById('duello-game-status').appendChild(rematchBtn);
}

// ========== BACK TO LOBBY ==========

backToLobbySetupBtn.addEventListener('click', () => {
    showGameModal(
        TranslationManager.t('back_lobby'),
        TranslationManager.t('leave_game_msg'),
        () => {
            window.location.href = 'index.html';
        }
    );
});

backToLobbyGameBtn.addEventListener('click', () => {
    showGameModal(
        TranslationManager.t('back_lobby'),
        TranslationManager.t('leave_game_msg'),
        () => {
            window.location.href = 'index.html';
        }
    );
});

// ========== MODAL FUNCTIONS ==========

function showGameModal(title, message, onConfirm) {
    const overlay = document.getElementById('game-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    modalTitle.textContent = title;
    modalMessage.textContent = message;
    overlay.style.display = 'flex';

    confirmBtn.onclick = () => {
        overlay.style.display = 'none';
        if (onConfirm) onConfirm();
    };

    cancelBtn.onclick = () => {
        overlay.style.display = 'none';
    };
}

// ========== MOBILE GRID TOGGLE ==========
const toggleGridBtn = document.getElementById('toggle-grid-btn');
let showingOpponentGrid = false;

if (toggleGridBtn) {
    toggleGridBtn.addEventListener('click', () => {
        const gridsWrapper = document.getElementById('duello-grids-wrapper');
        showingOpponentGrid = !showingOpponentGrid;

        if (showingOpponentGrid) {
            gridsWrapper.classList.add('show-opponent-mobile');
            toggleGridBtn.innerHTML = TranslationManager.t('duel_btn_toggle_grid_back');
            toggleGridBtn.classList.remove('secondary-btn');
            toggleGridBtn.classList.add('primary-btn');
        } else {
            gridsWrapper.classList.remove('show-opponent-mobile');
            toggleGridBtn.innerHTML = TranslationManager.t('duel_btn_toggle_grid');
            toggleGridBtn.classList.remove('primary-btn');
            toggleGridBtn.classList.add('secondary-btn');
        }
    });

    // Reset state on game start/rematch
    function resetMobileGridToggle() {
        showingOpponentGrid = false;
        const gridsWrapper = document.getElementById('duello-grids-wrapper');
        if (gridsWrapper) gridsWrapper.classList.remove('show-opponent-mobile');
        if (toggleGridBtn) {
            toggleGridBtn.innerHTML = TranslationManager.t('duel_btn_toggle_grid');
            toggleGridBtn.classList.remove('secondary-btn');
            toggleGridBtn.classList.add('secondary-btn');
        }
    }
}

