// solo.js
// Modalità singola (no timer, no turni). Usa la connessione Socket.io già esistente.

document.addEventListener('DOMContentLoaded', () => {

    if (typeof io === 'undefined') return; // Evita crash se socket.io manca
    const socket = io(); // Connessione unica

    const soloButton = document.getElementById('solo-mode-btn');
    const lobbyContainer = document.getElementById('lobby-container');
    const gameContainer = document.getElementById('game-container');
    const gridContainer = document.getElementById('grid-container');
    const playerTurnH3 = document.getElementById('player-turn');
    const gameMessageP = document.getElementById('game-message');
    const keyboardContainer = document.getElementById('keyboard-container');
    const languageSelect = document.getElementById('languageSelect');
    const backToLobbyBtn = document.getElementById('back-to-lobby-btn');

    const WORD_LENGTH = 5;
    let totalRows = 6;
    let currentRowIndex = 0;
    let currentGuess = '';
    let isSoloMode = false;
    let keyStates = {};
    let soloGrid = [];

    // ------ UI helpers -----
    function generateGrid(rows) {
        gridContainer.innerHTML = '';
        totalRows = rows;
        for (let r = 0; r < totalRows; r++) addNewRow();
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
        if (currentRowIndex < totalRows && currentRowElement) currentRowElement.classList.add('current-row');
    }

    function updateGridState(gridData) {
        gridData.forEach((attempt, r) => {
            const rowElement = document.getElementById(`row-${r}`);
            if (!rowElement) return;
            const boxes = rowElement.querySelectorAll('.box');

            attempt.word.split('').forEach((letter, c) => {
                boxes[c].textContent = letter;
            });

            setTimeout(() => {
                attempt.feedback.forEach((feedbackClass, c) => {
                    boxes[c].classList.add(feedbackClass);
                });
            }, 50 * r);

            updateKeyboardFeedback(attempt.word, attempt.feedback);
        });
    }

    // ------- Keyboard -------
    function generateKeyboard() {
        const rows = [
            ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
            ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACKSPACE']
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

    function updateKeyboardFeedback(word, feedback) {
        const letters = word.split('');
        letters.forEach((letter, index) => {
            const keyElement = document.getElementById(`key-${letter}`);
            if (!keyElement) return;
            const newClass = feedback[index];
            if (newClass === 'not-in-word') {
                keyElement.classList.remove('correct-position', 'wrong-position');
                keyElement.classList.add('not-in-word');
            } else {
                keyElement.classList.remove('not-in-word');
                keyElement.classList.add('correct-position');
            }
        });
    }

    // ------- Input handling -------
    function handleKeyInput(key) {
        if (!isSoloMode) return;
        const char = key.toUpperCase();

        if (char === 'ENTER') submitCurrentGuess();
        else if (char === 'BACKSPACE' || char === 'DELETE') {
            currentGuess = currentGuess.slice(0, -1);
            gameMessageP.textContent = '';
        }
        else if (char.length === 1 && /^[A-Z]$/.test(char) && currentGuess.length < WORD_LENGTH) {
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

    document.addEventListener('keyup', (e) => handleKeyInput(e.key));

    // ------- Submit guess (solo) -------
    function submitCurrentGuess() {
        if (!isSoloMode) return;
        if (currentGuess.length !== WORD_LENGTH) {
            gameMessageP.textContent = `La parola deve essere di ${WORD_LENGTH} lettere!`;
            return;
        }
        const guess = currentGuess.toUpperCase();
        gameMessageP.textContent = 'Verifying...';
        socket.emit('submitSolo', guess);
    }

    // ------- Avvio / reset interfaccia solo -------
    function resetSoloInterface() {
        currentGuess = '';
        currentRowIndex = 0;
        totalRows = 6;
        keyStates = {};
        soloGrid = [];
        generateGrid(totalRows);
        generateKeyboard();
        playerTurnH3.textContent = 'Modalità Solo';
        gameMessageP.textContent = 'Modalità singola: inserisci una parola.';
        updateCurrentRowVisual();
    }

    // ------- Bottone Solo Mode -------
    soloButton?.addEventListener('click', () => {
        const lang = languageSelect.value || 'it';
        socket.emit('startSolo', lang);
        gameMessageP.textContent = 'Inizializzo partita singola...';
    });

    // ------- Bottone Back to Lobby -------
    backToLobbyBtn?.addEventListener('click', () => {
        showGameModal(
            'Torna alla Lobby',
            'Sei sicuro di voler tornare alla lobby? I progressi andranno persi.',
            () => {
                location.reload();
            }
        );
    });

    // ------- Socket handlers per Solo -------
    socket.on('soloStarted', (data) => {
        isSoloMode = true;
        lobbyContainer.style.display = 'none';
        gameContainer.style.display = 'flex';
        document.body.classList.add('game-active');
        resetSoloInterface();
    });

    socket.on('soloUpdate', (state) => {
        soloGrid = state.grid || [];
        currentRowIndex = state.currentRow || 0;
        totalRows = state.maxRows || 6;

        while (gridContainer.children.length < totalRows) addNewRow();
        updateGridState(soloGrid);
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

    socket.on('soloGameOver', (data) => {
        isSoloMode = false;
        updateGridState(data.grid || []);
        playerTurnH3.textContent = data.won ? 'Hai vinto!' : 'Hai perso';
        gameMessageP.textContent = `La parola segreta era: ${data.secretWord}`;

        const rem = document.createElement('button');
        rem.textContent = 'Gioca Solo di nuovo';
        rem.style.padding = '10px 16px';
        rem.style.marginTop = '12px';
        rem.style.cursor = 'pointer';
        rem.addEventListener('click', () => {
            rem.remove();
            const lang = languageSelect.value || 'it';
            socket.emit('startSolo', lang);
        });
        gameContainer.querySelector('#game-status')?.appendChild(rem);
    });

    socket.on('soloError', (msg) => {
        gameMessageP.textContent = `Errore: ${msg}`;
    });

});
