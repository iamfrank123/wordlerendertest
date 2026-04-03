document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

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

    // DOM Elements
    const setupContainer = document.getElementById('all-setup-container');
    const gameContainer = document.getElementById('all-game-container');
    const nicknameInput = document.getElementById('nickname-input');
    const hostControls = document.getElementById('host-controls');
    const waitingMessage = document.getElementById('waiting-message');
    const lobbyPlayerList = document.getElementById('lobby-player-list');
    const roomCodeDisplay = document.getElementById('room-code-display');
    const startGameBtn = document.getElementById('start-game-btn');
    const backToMainBtn = document.getElementById('back-to-main-btn');
    const gameLangGroup = document.getElementById('game-lang-group');
    const gameLangSelect = document.getElementById('game-lang-select');

    const gridContainer = document.getElementById('grid-container');
    const keyboardContainer = document.getElementById('keyboard-container');
    const livePlayerList = document.getElementById('live-player-list');
    const winOverlay = document.getElementById('win-overlay');
    const winnerName = document.getElementById('winner-name');
    const secretWordDisplay = document.getElementById('secret-word-display');
    const newRoundBtn = document.getElementById('new-round-btn');
    const backToMenuOverlay = document.getElementById('back-to-menu-overlay');

    // Game State
    let roomId = null;
    let playerId = null;
    let isHost = false;
    let currentGuess = '';
    const WORD_LENGTH = 5;
    let currentRowIndex = 0;
    // let totalRows = 6; // REMOVED: Infinite Grid
    let keyStates = {};
    let gameOver = false;

    // URL Params checking (create vs join)
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    const joinCode = urlParams.get('room');

    // --- INITIALIZATION ---
    // Show setup button immediately
    setupButtonAction();

    // 1. Connection / Room Setup
    socket.on('connect', () => {
        console.log("Socket connected");
    });

    // Helper to setup the start button 
    function setupButtonAction() {
        const actionsContainer = document.getElementById('setup-actions');
        actionsContainer.innerHTML = ''; // Clear previous

        // CASE 1: Creation Mode (from Lobby)
        if (mode === 'create') {
            gameLangGroup.style.display = 'block'; // Show language selector
            // Set default language from localStorage
            const savedLang = localStorage.getItem('language') || 'it';
            gameLangSelect.value = savedLang;

            const createBtn = document.createElement('button');
            createBtn.className = 'primary-btn pulse-anim';
            createBtn.innerHTML = `<span class="btn-icon">🎲</span> ${TranslationManager.t('ava_btn_generate')}`;
            createBtn.style.marginTop = '15px';
            createBtn.onclick = () => {
                const nick = nicknameInput.value.trim() || 'Player';
                localStorage.setItem('nickname', nick); // Persist nickname

                // Use the EXPLICITLY selected language for the game
                const selectedGameLang = gameLangSelect.value;

                socket.emit('createRoomAllVsAll', { nickname: nick, language: selectedGameLang });
                createBtn.disabled = true;
                createBtn.textContent = TranslationManager.t('msg_creating_room');
                nicknameInput.disabled = true;
            };
            actionsContainer.appendChild(createBtn);
        }
        // CASE 2: Join Mode (from Lobby with Code)
        else if (joinCode) {
            roomId = joinCode; // Set global
            const joinBtn = document.createElement('button');
            joinBtn.className = 'primary-btn pulse-anim';
            joinBtn.innerHTML = `<span class="btn-icon">➡️</span> ${TranslationManager.t('ava_btn_join_code', { code: joinCode })}`;
            joinBtn.style.marginTop = '15px';
            joinBtn.onclick = () => {
                const nick = nicknameInput.value.trim() || 'Player';
                localStorage.setItem('nickname', nick);
                socket.emit('joinRoomAllVsAll', { roomId: joinCode, nickname: nick });
                joinBtn.disabled = true;
                joinBtn.textContent = TranslationManager.t('msg_attempt_join', { code: '' });
                nicknameInput.disabled = true;
            };
            actionsContainer.appendChild(joinBtn);
        }
        // CASE 3: Manual Entry (Direct Access)
        else {
            // Show Room Code Input
            const codeInputGroup = document.createElement('div');
            codeInputGroup.className = 'input-group';
            codeInputGroup.style.marginTop = '15px';
            codeInputGroup.innerHTML = `
                <label>${TranslationManager.t('ava_label_enter_code')}</label>
                <div style="display: flex; gap: 10px;">
                    <input type="text" id="manual-room-code" placeholder="CODE" maxlength="4" style="text-transform:uppercase; text-align:center; letter-spacing:2px;">
                    <button id="manual-join-btn" class="secondary-btn" style="width: auto; margin:0;">GO</button>
                </div>
            `;
            actionsContainer.appendChild(codeInputGroup);

            // Create New Room Button
            const createBtn = document.createElement('button');
            createBtn.className = 'primary-btn';
            createBtn.innerHTML = `<span class="btn-icon">➕</span> ${TranslationManager.t('btn_create_room')}`;
            createBtn.style.marginTop = '20px';
            createBtn.onclick = () => {
                const nick = nicknameInput.value.trim() || 'Player';
                localStorage.setItem('nickname', nick);
                // For manual creation logic here, we should probably also use language if we expose it.
                // But the current UI for 'manual-join' + 'create new room' button is a bit mixed.
                // Assuming 'create new room' button here leads to same flow?
                // Actually the button below calls createRoomAllVsAll.
                // Let's assume we want to support language selection here too if we want full consistency.
                // But simplified: existing `createBtn` below doesn't show the selector beforehand.
                // Let's leave it simple or force redirect to ?mode=create
                window.location.href = 'all_vs_all.html?mode=create'; // Redirect to proper create flow
                // socket.emit('createRoomAllVsAll', nick); 
                // setupContainer.querySelector('#manual-join-btn').disabled = true;
            };
            actionsContainer.appendChild(createBtn);

            // Bind Manual Join
            setTimeout(() => {
                const manualJoinBtn = document.getElementById('manual-join-btn');
                const manualInput = document.getElementById('manual-room-code');
                manualJoinBtn.onclick = () => {
                    const code = manualInput.value.trim().toUpperCase();
                    const nick = nicknameInput.value.trim() || 'Player';
                    if (code.length === 4) {
                        roomId = code;
                        localStorage.setItem('nickname', nick);
                        socket.emit('joinRoomAllVsAll', { roomId: code, nickname: nick });
                    } else {
                        alert(TranslationManager.t('msg_enter_valid_code'));
                    }
                };
            }, 0);
        }

        // recover nickname
        const savedNick = localStorage.getItem('nickname');
        if (savedNick) nicknameInput.value = savedNick;
    }


    socket.on('roomCreated', (data) => {
        roomId = data.roomId;
        isHost = true;
        roomCodeDisplay.textContent = `${TranslationManager.t('label_room_code')}: ${roomId}`;
        hostControls.style.display = 'block';
        updateLobbyList([{ nickname: data.hostNickname, isHost: true }]); // Initial list
    });

    socket.on('joinedRoom', (data) => {
        roomId = data.roomId;
        roomCodeDisplay.textContent = `${TranslationManager.t('label_room_code')}: ${roomId}`;
        waitingMessage.style.display = 'block';
        updateLobbyList(data.players);
    });

    socket.on('playerJoined', (players) => {
        updateLobbyList(players);
    });

    socket.on('playerLeft', (data) => {
        // Support both legacy array and new object format
        let players = Array.isArray(data) ? data : data.players;
        let secretWord = data.secretWord || null;

        updateLobbyList(players);

        // Check if game is running and only 1 player remains (Me)
        const isGameRunning = gameContainer.style.display === 'block'; // Simple check

        if (isGameRunning && players.length === 1) {
            // Victory by Default
            gameOver = true;
            winOverlay.style.display = 'flex';
            winnerName.textContent = "VITTORIA A TAVOLINO";

            // Customize message
            const winTitle = winOverlay.querySelector('h2');
            if (winTitle) winTitle.textContent = "AVVERSARIO DISCONNESSO";

            secretWordDisplay.innerHTML = `Nessun giocatore rimanente.<br>La parola era: <strong>${secretWord || "???"}</strong>`;

            // Hide Play Again button or adapt it
            newRoundBtn.style.display = 'none';

        } else {
            // Standard notification
            const toast = document.createElement('div');
            toast.style.position = 'fixed';
            toast.style.top = '20px';
            toast.style.left = '50%';
            toast.style.transform = 'translateX(-50%)';
            toast.style.background = '#ff4444';
            toast.style.color = 'white';
            toast.style.padding = '10px 20px';
            toast.style.borderRadius = '5px';
            toast.style.zIndex = '3000';
            toast.textContent = "Un giocatore si è disconnesso";
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }
    });

    socket.on('gameStarted', (data) => {
        setupContainer.style.display = 'none';
        gameContainer.style.display = 'block';
        winOverlay.style.display = 'none';
        gameOver = false;

        generateGrid();
        generateKeyboard();
        updateLiveStandings(data.players); // Initial standings (0 dots)

        // Initialize emoji reactions
        initEmojiReactions();

        // Track player nicknames for emoji reactions
        data.players.forEach(p => {
            playerNicknames[p.id] = p.nickname;
            if (p.id === socket.id) {
                myNickname = p.nickname;
            }
        });
    });

    socket.on('guessResult', (data) => {
        // data: { valid: boolean, feedback: [], word: string, rowIndex: int }
        if (!data.valid) {
            // Shake animation or alert
            const row = document.getElementById(`row-${currentRowIndex}`);
            row.classList.add('shake');
            setTimeout(() => row.classList.remove('shake'), 500);
            return;
        }
        updateGridRow(currentRowIndex, data.word, data.feedback);
    });

    socket.on('standingsUpdate', (players) => {
        updateLiveStandings(players);
    });

    // Handle Win
    socket.on('gameWon', (data) => {
        // data: { winnerNickname: string, secretWord: string }
        gameOver = true;
        winnerName.textContent = TranslationManager.t('ava_win_title', { name: data.winnerNickname });
        secretWordDisplay.textContent = data.secretWord;
        winOverlay.style.display = 'flex';

        if (isHost) {
            document.getElementById('host-actions').style.display = 'block';
            document.getElementById('client-waiting').style.display = 'none';
        } else {
            document.getElementById('host-actions').style.display = 'none';
            document.getElementById('client-waiting').style.display = 'block';
        }
    });

    // Buttons
    startGameBtn.addEventListener('click', () => {
        socket.emit('startAllVsAll', roomId);
    });

    backToMainBtn.addEventListener('click', () => {
        window.location.href = 'index.html';
    });

    document.getElementById('leave-game-btn').addEventListener('click', () => {
        if (confirm(TranslationManager.t('leave_game_msg'))) {
            window.location.href = 'index.html';
        }
    });

    newRoundBtn.addEventListener('click', () => {
        socket.emit('startAllVsAll', roomId); // Restart same logic
    });

    backToMenuOverlay.addEventListener('click', () => {
        window.location.href = 'index.html';
    });

    // Keyboard events
    document.addEventListener('keyup', (e) => {
        handleInput(e.key.toUpperCase());
    });

    // --- UI HELPERS ---
    function updateLobbyList(players) {
        lobbyPlayerList.innerHTML = '';
        players.forEach(p => {
            const li = document.createElement('li');
            li.textContent = p.nickname + (p.isHost ? ' (Host)' : '');
            lobbyPlayerList.appendChild(li);
        });
    }

    function generateGrid() {
        gridContainer.innerHTML = '';
        currentRowIndex = 0;
        // Start with 1 row for Infinite Mode
        addNewRow(0);
        updateCurrentRowVisual();
    }

    function addNewRow(index) {
        const row = document.createElement('div');
        row.className = 'grid-row';
        row.id = `row-${index}`;
        for (let c = 0; c < WORD_LENGTH; c++) {
            const box = document.createElement('div');
            box.className = 'box';
            row.appendChild(box);
        }
        gridContainer.appendChild(row);

        // Scroll to bottom of the WRAPPER (not window)
        setTimeout(() => {
            const scrollContainer = document.getElementById('grid-wrapper');
            if (scrollContainer) {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
        }, 50);
    }

    function updateCurrentRowVisual() {
        document.querySelectorAll('.grid-row').forEach(row => row.classList.remove('current-row'));
        const currentRow = document.getElementById(`row-${currentRowIndex}`);
        if (currentRow) currentRow.classList.add('current-row');
    }

    function generateKeyboard() {
        keyboardContainer.innerHTML = '';
        keyStates = {};
        const rows = [
            ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
            ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACKSPACE']
        ];
        rows.forEach(rowArr => {
            const rowDiv = document.createElement('div');
            rowDiv.className = 'keyboard-row';
            rowArr.forEach(keyVal => {
                const key = document.createElement('div');
                key.className = 'key';
                key.textContent = keyVal;
                key.id = `key-${keyVal}`;
                if (keyVal.length > 1) key.classList.add('wide-key');
                key.onclick = () => handleInput(keyVal);
                rowDiv.appendChild(key);
            });
            keyboardContainer.appendChild(rowDiv);
        });
    }

    function handleInput(key) {
        if (gameOver) return;
        // BUG FIX: Don't capture input if user is typing in a text field
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;

        if (key === 'ENTER') {
            submitGuess();
        } else if (key === 'BACKSPACE') {
            currentGuess = currentGuess.slice(0, -1);
        } else if (key.length === 1 && currentGuess.length < WORD_LENGTH) {
            if (/^[a-zA-Z]$/.test(key)) {
                currentGuess += key.toUpperCase();
            }
        }
        updateGridUI();
    }

    function updateGridUI() {
        const row = document.getElementById(`row-${currentRowIndex}`);
        if (!row) return;
        const boxes = row.querySelectorAll('.box');
        for (let i = 0; i < WORD_LENGTH; i++) {
            boxes[i].textContent = currentGuess[i] || '';
        }
    }

    function submitGuess() {
        if (currentGuess.length !== WORD_LENGTH) return;

        // Optimistic UI update or wait for server? Wait for server validation usually better for mplayer
        socket.emit('submitAllVsAll', { roomId, guess: currentGuess });
    }

    function updateGridRow(rowIndex, word, feedback) {
        const row = document.getElementById(`row-${rowIndex}`);
        if (!row) return;
        const boxes = row.querySelectorAll('.box');

        for (let i = 0; i < WORD_LENGTH; i++) {
            boxes[i].textContent = word[i];

            // IMMEDATE FEEDBACK (No Animation delay)
            boxes[i].classList.add(feedback[i]); // correct-position, wrong-position, not-in-word

            // Update keyboard
            const key = document.getElementById(`key-${word[i]}`);
            if (key) {
                if (feedback[i] === 'correct-position') {
                    key.classList.remove('wrong-position', 'not-in-word');
                    key.classList.add('correct-position');
                } else if (feedback[i] === 'wrong-position' && !key.classList.contains('correct-position')) {
                    key.classList.remove('not-in-word');
                    key.classList.add('wrong-position');
                } else if (feedback[i] === 'not-in-word' && !key.classList.contains('correct-position') && !key.classList.contains('wrong-position')) {
                    key.classList.add('not-in-word');
                }
            }
        }

        currentRowIndex++;
        currentGuess = '';

        // INFINITE GRID: Add new row immediately
        addNewRow(currentRowIndex);
        updateCurrentRowVisual();
    }

    function updateLiveStandings(players) {
        console.log("Updating standings:", players);
        livePlayerList.innerHTML = '';

        // Sort players? Maybe by dot count desc?
        players.sort((a, b) => b.dots - a.dots);

        players.forEach(p => {
            const li = document.createElement('li');
            li.className = 'player-item';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'player-name';
            nameSpan.textContent = p.nickname;
            if (p.id === socket.id) nameSpan.style.fontWeight = 'bold'; // Highlight self

            const dotsDiv = document.createElement('div');
            dotsDiv.className = 'progress-dots';

            for (let i = 0; i < 5; i++) {
                const dot = document.createElement('span');
                dot.className = 'dot' + (i < p.dots ? ' filled' : '');
                dotsDiv.appendChild(dot);
            }

            li.appendChild(nameSpan);
            li.appendChild(dotsDiv);
            livePlayerList.appendChild(li);
        });
    }

    // --- EMOJI REACTIONS ---

    let myNickname = '';
    let playerNicknames = {}; // Map of playerId -> nickname

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
        socket.emit('emojiReactionAllVsAll', { emoji, roomId });
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
    socket.on('emojiReactionAllVsAll', (data) => {
        // data: { emoji, playerId, playerName }
        if (data.playerId !== socket.id) {
            // Display reaction from other player
            displayReaction(data.emoji, data.playerName);
            createFloatingEmoji(data.emoji);
        }
    });

});
