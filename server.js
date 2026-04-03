const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,      // Wait 60s for pong before closing connection
    pingInterval: 25000,     // Send ping every 25s to keep connection alive
    transports: ['websocket', 'polling'], // Try WebSocket first, fallback to polling
    cors: {
        origin: "*",         // Configure appropriately for production
        methods: ["GET", "POST"]
    },
    allowEIO3: true          // Compatibility with older clients
});

const PORT = process.env.PORT || 3000;

// Configurazione MIME types per Render.com
const mime = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.html': 'text/html; charset=utf-8'
};

// Middleware per impostare MIME types corretti
app.use((req, res, next) => {
    const ext = path.extname(req.path).toLowerCase();
    if (mime[ext]) {
        res.setHeader('Content-Type', mime[ext]);
    }
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '.'), {
    setHeaders: (res, filepath) => {
        const ext = path.extname(filepath).toLowerCase();
        if (mime[ext]) {
            res.setHeader('Content-Type', mime[ext]);
        }
    }
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// [keep-alive Render.com] Route /ping: risponde in <1ms, mantiene il processo sveglio
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

const rooms = {};
const allVsAllRooms = {};
const initAllVsAll = require('./all_vs_all_server_logic');
// Load additional game modes
require('./modes/parole_xl/server')(io);
require('./modes/impiccato/server')(io);
require('./modes/maratona/server')(io);
require('./modes/wordlechain/server')(io);
require('./modes/cadutalettere/server')(io);
const duelloRooms = {};
const maratonaRooms = {};
const MAX_PLAYERS = 2;
const WORD_LENGTH = 5;


const { SECRET_WORDS_IT, SECRET_WORDS_EN, VALID_WORDS_IT, VALID_WORDS_EN } = require('./constants');
const SERVER_TRANSLATIONS = require('./server_translations');

function t(key, lang = 'it', params = {}) {
    const dict = SERVER_TRANSLATIONS[lang] || SERVER_TRANSLATIONS['it'];
    let text = dict[key] || key;
    for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
    }
    return text;
}

function getWordList(language) {
    return language === "en" ? SECRET_WORDS_EN : SECRET_WORDS_IT;
}

function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

function selectSecretWord(language = "it") {
    const list = getWordList(language);
    return list[Math.floor(Math.random() * list.length)];
}

function getFeedback(guess, secret) {
    const length = WORD_LENGTH;
    const feedback = new Array(length).fill('not-in-word');
    let secretTemp = secret.split('');

    for (let i = 0; i < length; i++) {
        if (guess[i] === secret[i]) {
            feedback[i] = 'correct-position';
            secretTemp[i] = '#';
        }
    }

    for (let i = 0; i < length; i++) {
        if (feedback[i] === 'not-in-word') {
            const index = secretTemp.indexOf(guess[i]);
            if (index !== -1) {
                feedback[i] = 'wrong-position';
                secretTemp[index] = '#';
            }
        }
    }

    return feedback;
}

function initializeRoomState(roomCode, players, language = "it") {
    const newSecretWord = selectSecretWord(language);
    rooms[roomCode] = {
        secretWord: newSecretWord,
        players: players,
        currentPlayerIndex: 0,
        currentTurnSocket: players[0],
        grid: [],
        currentRow: 0,
        maxRows: 6,
        rematchRequests: 0,
        language: language
    };
    return rooms[roomCode];
}


function isValidLinguisticPattern(word, language) {
    // Basic check: only letters
    if (!/^[A-Z]+$/.test(word)) return false;

    // Define patterns based on Consonant (C) and Vowel (V)
    // IT: CV, VC, CC, VV, CCCV, CCV
    // EN: CCV, CCCV, VC, VV

    const vowels = "AEIOU";

    // Helper to get structure string e.g. "CVCVV"
    let structure = "";
    for (const char of word) {
        structure += vowels.includes(char) ? "V" : "C";
    }

    if (language === 'it') {
        // Italian Patterns:
        // Consonante + Vocale di fila (CV)
        // Vocale + Consonante di fila (VC)
        // Doppia Consonante di fila (CC)
        // Doppia Vocale di fila (VV)
        // Tripla Consonante + Vocale (CCCV)

        // We check if the word "contains" any of these valid substructures?
        // OR does the user mean the word must be composed of these? 
        // "consonante + vocale di fila" -> if I have "B" (C)... invalid?
        // Usually these rules mean "if it contains at least one of these patterns it is acceptable" 
        // OR "it must not violate structural rules".
        // The prompt says: "applica che la parola inviata italiana è valida se rispetta questi pattern"
        // indicating positive matching.

        // Let's use Regex on the structure string for efficiency

        // Patterns:
        // 1. CV
        // 2. VC
        // 3. CC
        // 4. VV
        // 5. CCCV

        const itPatterns = [/CV/, /VC/, /CC/, /VV/, /CCCV/];
        return itPatterns.some(regex => regex.test(structure));
    }

    if (language === 'en') {
        // English Patterns:
        // 1. Doppia consonante + vocale (CCV)
        // 2. Tripla consonante + vocale (CCCV)
        // 3. Vocale + consonante (VC)
        // 4. Doppia vocale di fila (VV)

        const enPatterns = [/CCV/, /CCCV/, /VC/, /VV/];
        return enPatterns.some(regex => regex.test(structure));
    }

    return false;
}

function isValidWord(word, language) {
    const upperWord = word.toUpperCase();

    // 1. Dictionary Check
    if (language === "it" && VALID_WORDS_IT.includes(upperWord)) return true;
    if (language === "en" && VALID_WORDS_EN.includes(upperWord)) return true;

    // 2. Linguistic Pattern Fallback
    return isValidLinguisticPattern(upperWord, language);
}

io.on('connection', (socket) => {// --------- STORAGE SOLO MODE ----------
    initAllVsAll(socket, io, allVsAllRooms, isValidWord);
    const solos = {}; // socket.id -> { secretWord, grid, currentRow, maxRows, language }

    // --- Solo Mode ---
    socket.on('startSolo', (language = "it") => {
        const secret = selectSecretWord(language);
        solos[socket.id] = {
            secretWord: secret,
            grid: [],
            currentRow: 0,
            maxRows: 6,
            language
        };
        console.log(`[SERVER] Solo started for ${socket.id}, secret: ${secret}`);
        socket.emit('soloStarted', { maxRows: 6 });
    });

    socket.on('submitSolo', (word) => {
        const session = solos[socket.id];
        if (!session) return socket.emit('soloError', t('solo_session_error', 'it'));

        const guess = word.toUpperCase();
        if (guess.length !== WORD_LENGTH) return socket.emit('soloError', t('solo_word_length', session.language, { length: WORD_LENGTH }));

        if (!isValidWord(guess, session.language)) return socket.emit('soloError', t('solo_word_invalid', session.language));

        const feedback = getFeedback(guess, session.secretWord);
        session.grid.push({ word: guess, feedback });
        const hasWon = feedback.every(f => f === 'correct-position');

        if (hasWon) {
            socket.emit('soloUpdate', { grid: session.grid, currentRow: session.currentRow, maxRows: session.maxRows });
            socket.emit('soloGameOver', { won: true, secretWord: session.secretWord, grid: session.grid });
            delete solos[socket.id];
            return;
        }

        session.currentRow++;
        if (session.currentRow >= session.maxRows) session.maxRows += 5;

        socket.emit('soloUpdate', { grid: session.grid, currentRow: session.currentRow, maxRows: session.maxRows });
    });

    socket.on('disconnect', () => {
        if (solos[socket.id]) delete solos[socket.id];
    });

    console.log(`[SERVER] Nuovo utente connesso: ${socket.id}`);

    socket.on('createRoom', (language = "it") => {
        const roomCode = generateRoomCode();
        initializeRoomState(roomCode, [socket.id], language);

        socket.join(roomCode);
        socket.roomId = roomCode;
        console.log(`[SERVER] Stanza creata: ${roomCode} con parola: ${rooms[roomCode].secretWord} (${language})`);

        socket.emit('roomCreated', roomCode);
        socket.emit('lobbyMessage', t('room_created', language, { code: roomCode }));
    });

    socket.on('joinRoom', (roomCode) => {
        const room = rooms[roomCode];

        if (!room) return socket.emit('lobbyError', t('room_not_found', 'it'));
        if (room.players.length >= MAX_PLAYERS) return socket.emit('lobbyError', t('room_full', room.language));

        socket.join(roomCode);
        room.players.push(socket.id);
        socket.roomId = roomCode;
        console.log(`[SERVER] Utente ${socket.id} unito alla stanza ${roomCode}`);

        io.to(roomCode).emit('startGame', roomCode, room.players);

        room.players.forEach(playerId => {
            io.sockets.sockets.get(playerId)?.emit('updateTurnStatus', {
                isTurn: playerId === room.currentTurnSocket,
                message: playerId === room.currentTurnSocket ? t('turn_you', room.language) : t('turn_opponent', room.language)
            });
        });
    });

    socket.on('submitWord', (word) => {
        const roomCode = socket.roomId;
        const room = rooms[roomCode];
        const upperWord = word.toUpperCase();

        if (!room || room.players.length !== MAX_PLAYERS) return socket.emit('gameError', t('game_error_invalid', room ? room.language : 'it'));
        if (socket.id !== room.currentTurnSocket) return socket.emit('gameError', t('game_error_turn', room.language));
        if (upperWord.length !== WORD_LENGTH) return socket.emit('gameError', t('game_error_length', room.language, { length: WORD_LENGTH }));



        if (!isValidWord(upperWord, room.language)) {
            socket.emit('gameError', t('game_error_dict', room.language));
            return;
        }

        const feedback = getFeedback(upperWord, room.secretWord);
        room.grid.push({ word: upperWord, feedback: feedback });
        const hasWon = feedback.every(f => f === 'correct-position');

        if (hasWon) {
            const winnerName = socket.id === room.players[0] ? "Giocatore 1" : "Giocatore 2";
            console.log(`[SERVER] VITTORIA nella stanza ${roomCode}. Vincitore: ${winnerName}`);

            io.to(roomCode).emit('updateGameState', {
                grid: room.grid,
                currentRow: room.currentRow,
                maxRows: room.maxRows,
                currentTurnSocket: room.currentTurnSocket
            });

            io.to(roomCode).emit('gameOver', {
                winner: socket.id,
                winnerName: winnerName,
                secretWord: room.secretWord
            });
            return;
        }

        room.currentRow++;
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % MAX_PLAYERS;
        room.currentTurnSocket = room.players[room.currentPlayerIndex];

        if (room.currentRow >= room.maxRows) {
            room.maxRows += 5;
        }

        io.to(roomCode).emit('updateGameState', {
            grid: room.grid,
            currentRow: room.currentRow,
            maxRows: room.maxRows,
            currentTurnSocket: room.currentTurnSocket
        });

        const nextPlayerId = room.currentTurnSocket;
        const opponentPlayerId = room.players.find(id => id !== nextPlayerId);

        io.sockets.sockets.get(nextPlayerId)?.emit('updateTurnStatus', {
            isTurn: true,
            message: "Tocca a te!"
        });

        if (opponentPlayerId) {
            io.sockets.sockets.get(opponentPlayerId)?.emit('updateTurnStatus', {
                isTurn: false,
                message: "Tocca all'avversario."
            });
        }
    });


    socket.on('passTurn', () => {
        const roomCode = socket.roomId;
        const room = rooms[roomCode];

        if (!room || socket.id !== room.currentTurnSocket) return;

        console.log(`[SERVER] ${socket.id} ha passato il turno.`);

        // Switch turn
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
        room.currentTurnSocket = room.players[room.currentPlayerIndex];

        // Notify players
        const nextPlayerId = room.currentTurnSocket;
        const opponentPlayerId = room.players.find(id => id !== nextPlayerId);

        io.sockets.sockets.get(nextPlayerId)?.emit('updateTurnStatus', {
            isTurn: true,
            message: "Tocca a te!"
        });

        if (opponentPlayerId) {
            io.sockets.sockets.get(opponentPlayerId)?.emit('updateTurnStatus', {
                isTurn: false,
                message: "Tocca all'avversario."
            });
        }
    });

    socket.on('requestRematch', () => {
        const roomCode = socket.roomId;
        const room = rooms[roomCode];
        if (!room) return;

        room.rematchRequests++;
        if (room.rematchRequests === MAX_PLAYERS) {
            const playerIds = room.players;
            const newRoom = initializeRoomState(roomCode, playerIds, room.language);

            io.to(roomCode).emit('rematchStart', roomCode);

            room.players.forEach(playerId => {
                io.sockets.sockets.get(playerId)?.emit('updateTurnStatus', {
                    isTurn: newRoom.currentTurnSocket === playerId,
                    message: newRoom.currentTurnSocket === playerId ? t('turn_you', newRoom.language) : t('turn_opponent', newRoom.language)
                });
            });

            console.log(`[SERVER] REMATCH accettato per stanza ${roomCode}. Nuova parola: ${newRoom.secretWord} (${room.language})`);
        } else {
            socket.to(roomCode).emit('rematchRequested', 'L\'avversario ha richiesto una rivincita!');
        }
    });

    socket.on('disconnect', () => {
        console.log(`[SERVER] Utente disconnesso: ${socket.id}`);
        // Handle STANDARD Rooms
        const roomCode = socket.roomId;
        if (roomCode && rooms[roomCode]) {
            const room = rooms[roomCode];
            room.players = room.players.filter(id => id !== socket.id);

            if (room.players.length === 0) {
                delete rooms[roomCode];
            } else {
                const remainingPlayerId = room.players[0];
                io.to(remainingPlayerId).emit('opponentDisconnected', t('opponent_disconnected', room.language));
                delete rooms[roomCode];
            }
        }

        // Handle DUELLO Rooms (Robust)
        // Since socket.roomId matches, we check duelloRooms[roomCode]
        if (roomCode && duelloRooms[roomCode]) {
            const room = duelloRooms[roomCode];
            const playerId = socket.playerId;

            if (playerId && room.players.includes(playerId)) {
                console.log(`[DUELLO] Disconnessione temporanea: ${playerId}`);

                // Notify Opponent
                const opponentId = room.players.find(id => id !== playerId);
                if (opponentId && room.sockets[opponentId]) {
                    io.to(room.sockets[opponentId]).emit('opponentStatus', {
                        connected: false,
                        message: t('duello_opponent_wait_recon', room.language)
                    });
                }

                // Set Timeout for cleanup (e.g., 3 minutes)
                const TIMEOUT_MS = 3 * 60 * 1000;
                if (room.disconnectTimeouts[playerId]) clearTimeout(room.disconnectTimeouts[playerId]);

                room.disconnectTimeouts[playerId] = setTimeout(() => {
                    console.log(`[DUELLO] Timeout scaduto per ${playerId}. Chiusura stanza ${roomCode}`);

                    if (opponentId && room.sockets[opponentId]) {
                        io.to(room.sockets[opponentId]).emit('playerLeft'); // Trigger Game Over
                    }
                    delete duelloRooms[roomCode];
                }, TIMEOUT_MS);
            }
        }

        // Handle ALL VS ALL Rooms
        if (roomCode && allVsAllRooms[roomCode]) {
            const room = allVsAllRooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                console.log(`[ALL VS ALL] Player ${socket.id} left room ${roomCode}`);
                room.players.splice(playerIndex, 1);

                // Emit updated list
                const secretWord = room.gameState ? room.gameState.secretWord : null;
                io.to(roomCode).emit('playerLeft', {
                    players: room.players.map(p => ({
                        nickname: p.nickname,
                        isHost: p.isHost,
                        dots: p.dots
                    })),
                    secretWord: secretWord
                });

                if (room.players.length === 0) {
                    delete allVsAllRooms[roomCode];
                    console.log(`[ALL VS ALL] Room ${roomCode} deleted (empty)`);
                }
            }
        }
    });

    // ================ DUELLO MODE (ROBUST) ================

    function getDuelloPlayerId(socket) {
        return socket.playerId;
    }

    // ---------------- CREA STANZA DUELLO ----------------
    socket.on('createDuelloRoom', ({ language, playerId }) => {
        if (!playerId) return socket.emit('duelloError', t('duello_missing_id', language));

        const roomCode = generateRoomCode();

        duelloRooms[roomCode] = {
            code: roomCode,
            language: language || 'it',
            players: [playerId], // Store PlayerIDs
            sockets: { [playerId]: socket.id },
            secretWords: {}, // Key: playerId
            hints: {},       // Key: playerId
            grids: {},       // Key: playerId
            ready: {},       // Key: playerId
            gameStarted: false,
            winner: null,
            rematchPlayers: new Set(),
            hintsEnabled: true,
            disconnectTimeouts: {} // Key: playerId -> timeout
        };

        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.isDuello = true;
        socket.playerId = playerId; // Bind ID to socket

        socket.emit('duelloRoomCreated', roomCode);
        console.log(`[DUELLO] Stanza creata: ${roomCode} da ${playerId} (${socket.id})`);
    });

    // ---------------- JOIN STANZA DUELLO ----------------
    socket.on('joinDuelloRoom', ({ roomCode, playerId }) => {
        if (!playerId) return socket.emit('duelloError', t('duello_missing_id', 'it'));

        const room = duelloRooms[roomCode];

        if (!room) {
            socket.emit('duelloError', t('duello_no_room', 'it'));
            return;
        }

        // Check if already in (handle as rejoin automatically)
        if (room.players.includes(playerId)) {
            // Treat as rejoin/socket update
            room.sockets[playerId] = socket.id;
            socket.join(roomCode);
            socket.roomId = roomCode;
            socket.isDuello = true;
            socket.playerId = playerId;

            // Use the same sync logic as rejoin
            // Or simply emit joined if in setup phase
            if (!room.gameStarted) {
                socket.emit('duelloRoomJoined', roomCode);
                // Also sync if they already set a word?
                if (room.secretWords[playerId]) {
                    socket.emit('secretWordSet', t('duello_secret_set', room.language));
                }
            } else {
                // Full rejoin logic if game started
                // Ideally we'd call the rejoin handler, but let's just emit sync here to be safe
                // Copy-paste minimal sync or redirect flow?
                // Simplest: Emit error told client to use Rejoin, but client UI doesn't have a button.
                // Best: Auto-rejoin.

                // Let's just emulate successful join for Setup phase as that's where the user is stuck.
                socket.emit('duelloRoomJoined', roomCode);
            }

            console.log(`[DUELLO] ${playerId} re-joined (via join) room ${roomCode}`);
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('duelloError', t('room_full', room.language));
            return;
        }

        room.players.push(playerId);
        room.sockets[playerId] = socket.id;

        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.isDuello = true;
        socket.playerId = playerId;

        socket.emit('duelloRoomJoined', roomCode);

        // Notify Opponent
        const opponentId = room.players.find(id => id !== playerId);
        if (opponentId && room.sockets[opponentId]) {
            io.to(room.sockets[opponentId]).emit('duelloPlayerJoined', {
                playerCount: room.players.length,
                message: t('duello_opponent_joined', room.language)
            });
        }

        console.log(`[DUELLO] ${playerId} unito alla stanza ${roomCode}`);
    });

    // ---------------- REJOIN (RICONNESSINE) ----------------
    socket.on('rejoinDuelloRoom', ({ roomCode, playerId }) => {
        const room = duelloRooms[roomCode];
        if (!room) {
            socket.emit('duelloError', t('duello_no_room', 'it'));
            // Tell client to clear storage
            socket.emit('gameStateSync', { gameStarted: false, invalid: true });
            return;
        }

        if (!room.players.includes(playerId)) {
            socket.emit('duelloError', t('duello_not_in_room', room.language));
            return;
        }

        // Cancel disconnect timeout if exists
        if (room.disconnectTimeouts[playerId]) {
            clearTimeout(room.disconnectTimeouts[playerId]);
            delete room.disconnectTimeouts[playerId];
        }

        // Update Socket Binding
        room.sockets[playerId] = socket.id;
        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.isDuello = true;
        socket.playerId = playerId;

        console.log(`[DUELLO] ${playerId} RICONNESSO alla stanza ${roomCode}`);

        // Get Opponent ID
        const opponentId = room.players.find(id => id !== playerId);

        // SYNC STATE
        const myGrid = room.grids[playerId] || [];
        // Determine what opponent grid to show (scrambled if hidden?)
        // For simplicity, we send the raw data and let client/server logic decide masking.
        // Wait, server logic was masking in 'duelloGuessResult'.
        // We should send the opponent grid but masked if hints disabled.
        // Actually, let's trust the data we have.
        let opponentGridToSend = [];
        if (opponentId && room.grids[opponentId]) {
            opponentGridToSend = room.grids[opponentId]; // Client handles masking or we should do it here
            // But 'opponentGuessUpdate' usually sends just the guess.
            // On full sync, we probably want to support the masking.
            // Let's send raw and let duello.js handle it (it has logic: `if (!hintsEnabled) ...`) 
            // Wait, duello.js `duelloGuessResult` handles masking for OWN grid display?? No.
            // Client logic:
            // socket.on('duelloGuessResult', (data) => { ownGrid = data.ownGrid; ... display info ... })
            // The client does masking for *hard mode* on its own grid results? 
            // Ah, line 144 in duello.js checks `hintsEnabled`.
            // So we can send raw data.
        }

        socket.emit('gameStateSync', {
            gameStarted: room.gameStarted,
            roomCode: roomCode,
            hintsEnabled: room.hintsEnabled,
            message: room.gameStarted ? 'Partita in corso...' : 'In attesa...',
            hasSetSecret: !!room.secretWords[playerId],

            // Hints
            opponentHint: (opponentId && room.hints[opponentId]) ? room.hints[opponentId] : 'Nessun indizio',
            yourHint: room.hints[playerId] || '',

            // Grids
            ownGrid: myGrid,
            opponentGrid: opponentGridToSend
        });

        // Notify Opponent
        if (opponentId && room.sockets[opponentId]) {
            io.to(room.sockets[opponentId]).emit('opponentStatus', {
                connected: true,
                message: t('duello_reconnected', room.language)
            });
        }
    });


    // ---------------- IMPOSTA PAROLA SEGRETA ----------------
    socket.on('setSecretWord', ({ word, hint, hintsEnabled }) => {
        const roomCode = socket.roomId;
        const playerId = socket.playerId;
        const room = duelloRooms[roomCode];

        if (!room || !playerId) return;

        const upperWord = word.toUpperCase();
        if (upperWord.length !== WORD_LENGTH) {
            socket.emit('duelloError', t('game_error_length', room.language, { length: WORD_LENGTH }));
            return;
        }

        room.secretWords[playerId] = upperWord;
        room.hints[playerId] = hint || '';

        if (hintsEnabled !== null && hintsEnabled !== undefined) {
            room.hintsEnabled = hintsEnabled;
        }
        room.grids[playerId] = [];

        socket.emit('secretWordSet', t('duello_secret_set', room.language));
    });

    // ---------------- GIOCATORE PRONTO ----------------
    socket.on('playerReady', () => {
        const roomCode = socket.roomId;
        const playerId = socket.playerId;
        const room = duelloRooms[roomCode];

        if (!room || !playerId) return;

        if (!room.secretWords[playerId]) {
            socket.emit('duelloError', t('duello_set_secret_first', room.language));
            return;
        }

        room.ready[playerId] = true;

        // Controlla se entrambi i giocatori sono pronti
        const allReady = room.players.every(id => room.ready[id]);

        if (allReady && room.players.length === 2) {
            room.gameStarted = true;

            // Invia dati di inizio partita a ciascun giocatore
            room.players.forEach(pId => {
                const opponentId = room.players.find(id => id !== pId);
                const pSocketId = room.sockets[pId];

                if (pSocketId) {
                    io.to(pSocketId).emit('duelloGameStart', {
                        opponentHint: room.hints[opponentId] || 'Nessun indizio',
                        yourHint: room.hints[pId] || 'Nessun indizio',
                        hintsEnabled: (room.hintsEnabled !== undefined ? room.hintsEnabled : true)
                    });
                }
            });

            console.log(`[DUELLO] Partita iniziata nella stanza ${roomCode}`);
        } else {
            socket.emit('waitingForOpponent', t('duello_waiting_opponent', room.language));
        }
    });

    // ---------------- TENTATIVO DUELLO ----------------
    socket.on('submitDuelloGuess', (guess) => {
        const roomCode = socket.roomId;
        const playerId = socket.playerId;
        const room = duelloRooms[roomCode];

        if (!room || !room.gameStarted || !playerId) {
            socket.emit('duelloError', t('game_error_invalid', room ? room.language : 'it'));
            return;
        }

        const upperGuess = guess.toUpperCase();
        if (upperGuess.length !== WORD_LENGTH) {
            socket.emit('duelloError', t('game_error_length', room.language, { length: WORD_LENGTH }));
            return;
        }

        // Trova la parola segreta dell'avversario
        const opponentId = room.players.find(id => id !== playerId);
        const targetWord = room.secretWords[opponentId];

        if (!targetWord) return; // Should not happen in gameStarted

        // Calcola feedback
        const feedback = [];
        const targetLetters = targetWord.split('');
        const guessLetters = upperGuess.split('');
        const used = new Array(WORD_LENGTH).fill(false);

        // Prima passata: lettere corrette
        for (let i = 0; i < WORD_LENGTH; i++) {
            if (guessLetters[i] === targetLetters[i]) {
                feedback[i] = 'correct';
                used[i] = true;
            }
        }

        // Seconda passata: lettere presenti
        for (let i = 0; i < WORD_LENGTH; i++) {
            if (feedback[i] !== 'correct') {
                let found = false;
                for (let j = 0; j < WORD_LENGTH; j++) {
                    if (!used[j] && guessLetters[i] === targetLetters[j]) {
                        feedback[i] = 'present';
                        used[j] = true;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    feedback[i] = 'absent';
                }
            }
        }

        // Aggiungi tentativo
        const attempt = {
            word: upperGuess,
            feedback: feedback
        };

        if (!room.grids[playerId]) room.grids[playerId] = [];
        room.grids[playerId].push(attempt);

        // Invia aggiornamento al giocatore
        socket.emit('duelloGuessResult', {
            word: upperGuess,
            feedback: feedback,
            ownGrid: room.grids[playerId]
        });

        // Invia aggiornamento all'avversario
        if (opponentId && room.sockets[opponentId]) {
            io.to(room.sockets[opponentId]).emit('opponentGuessUpdate', {
                word: upperGuess,
                feedback: feedback,
                opponentGrid: room.grids[playerId]
            });
        }

        // Controlla vittoria
        if (upperGuess === targetWord) {
            room.winner = playerId;

            // Notify Winner
            socket.emit('duelloGameOver', {
                won: true,
                message: t('duello_win', room.language),
                secretWord: targetWord
            });

            // Notify Loser
            if (opponentId && room.sockets[opponentId]) {
                io.to(room.sockets[opponentId]).emit('duelloGameOver', {
                    won: false,
                    message: t('duello_lose', room.language),
                    secretWord: room.secretWords[playerId]
                });
            }

            console.log(`[DUELLO] ${playerId} ha vinto nella stanza ${roomCode}`);
        }
    });

    // ---------------- REMATCH DUELLO ----------------
    socket.on('duelloRematch', () => {
        const roomCode = socket.roomId;
        const playerId = socket.playerId;
        const room = duelloRooms[roomCode];

        if (!room || !playerId) return;

        if (!room.rematchPlayers) room.rematchPlayers = new Set();
        room.rematchPlayers.add(playerId);

        if (room.rematchPlayers.size >= 2) {
            // Reset stanza
            const p1 = room.players[0];
            const p2 = room.players[1];

            room.secretWords = {};
            room.hints = {};
            room.grids = { [p1]: [], [p2]: [] };
            room.ready = {};
            room.gameStarted = false;
            room.winner = null;
            room.rematchPlayers = new Set();

            io.to(roomCode).emit('duelloRematchStart', t('duello_game_started', room.language));
            console.log(`[DUELLO] Rematch nella stanza ${roomCode}`);
        } else {
            socket.to(roomCode).emit('duelloRematchRequested', t('rematch_requested', room.language));
        }
    });

    // ---------------- PASSAGGIO TURNO ----------------
    socket.on('passTurn', () => {
        const roomCode = socket.roomId;
        const room = rooms[roomCode];
        if (!room || room.players.length !== MAX_PLAYERS) return;

        // Cambia turno al prossimo giocatore
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % MAX_PLAYERS;
        room.currentTurnSocket = room.players[room.currentPlayerIndex];

        const nextPlayerId = room.currentTurnSocket;
        const opponentPlayerId = room.players.find(id => id !== nextPlayerId);

        io.sockets.sockets.get(nextPlayerId)?.emit('updateTurnStatus', {
            isTurn: true,
            message: "Tocca a te!"
        });
        if (opponentPlayerId) {
            io.sockets.sockets.get(opponentPlayerId)?.emit('updateTurnStatus', {
                isTurn: false,
                message: "Tocca all'avversario."
            });
        }
    });

    socket.on('disconnect', () => {
        // ... (existing disconnect logic) ...
        // Check maratonaRooms
        for (const roomCode in maratonaRooms) {
            const room = maratonaRooms[roomCode];
            const playerIndex = room.players.indexOf(socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                io.to(roomCode).emit('maratonaPlayerLeft', t('maratona_player_left', room.language || 'it'));
                if (room.players.length === 0) {
                    delete maratonaRooms[roomCode];
                } else {
                    // Reset game state if a player leaves? Or just let them wait?
                    // For now, let's reset to waiting state
                    room.gameStarted = false;
                    room.guesses = [];
                    io.to(roomCode).emit('waitingForOpponent', t('waiting_opponent', room.language || 'it'));
                }
                break;
            }
        }
    });

    // --- MARATONA MODE ---

    // --- MARATONA MODE (ROBUST) ---

    // ---------------- CREA ROOM ----------------
    socket.on('createMaratonaRoom', ({ lang, playerId }) => {
        if (!playerId) return socket.emit('maratonaError', 'Errore ID Giocatore');

        const roomCode = generateRoomCode();
        let secretList = SECRET_WORDS_IT;
        if (lang === 'en') secretList = SECRET_WORDS_EN;

        const secretWord = secretList[Math.floor(Math.random() * secretList.length)];

        maratonaRooms[roomCode] = {
            players: [playerId],
            sockets: { [playerId]: socket.id },
            lang: lang || 'it',
            secretWord: secretWord,
            gameStarted: false,
            guesses: [],
            disconnectTimeouts: {},
            rematchRequests: new Set()
        };

        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.playerId = playerId;
        socket.isMaratona = true;

        socket.emit('maratonaRoomCreated', roomCode);
        console.log(`[MARATONA] Creata ${roomCode} da ${playerId}`);
    });

    // ---------------- JOIN ROOM ----------------
    socket.on('joinMaratonaRoom', ({ code, playerId }) => {
        if (!playerId) return socket.emit('maratonaError', 'Errore ID Giocatore');

        const room = maratonaRooms[code];
        if (room) {
            // Check if already in
            if (room.players.includes(playerId)) {
                socket.emit('maratonaError', 'Sei giĂ  in questa stanza. Usa la riconnessione.');
                return;
            }

            if (room.players.length < 2) {
                room.players.push(playerId);
                room.sockets[playerId] = socket.id;

                socket.join(code);
                socket.roomId = code;
                socket.playerId = playerId;
                socket.isMaratona = true;

                socket.emit('maratonaRoomJoined', code);

                // Start Game immediately when 2 players are there
                room.gameStarted = true;

                io.to(code).emit('maratonaGameStart', {
                    message: 'La partita inizia! Indovinate la parola segreta!',
                });
                console.log(`[MARATONA] Partita iniziata ${code}`);

            } else {
                socket.emit('maratonaError', 'Stanza piena!');
            }
        } else {
            socket.emit('maratonaError', 'Stanza non trovata!');
        }
    });

    // ---------------- REJOIN ROOM ----------------
    socket.on('rejoinMaratonaRoom', ({ roomCode, playerId }) => {
        const room = maratonaRooms[roomCode];
        if (!room) {
            socket.emit('maratonaStateSync', { gameStarted: false, invalid: true });
            return;
        }

        if (!room.players.includes(playerId)) {
            socket.emit('maratonaError', 'Non autorizzato.');
            return;
        }

        // Cancel timeout
        if (room.disconnectTimeouts[playerId]) {
            clearTimeout(room.disconnectTimeouts[playerId]);
            delete room.disconnectTimeouts[playerId];
        }

        // Update socket
        room.sockets[playerId] = socket.id;
        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.playerId = playerId;
        socket.isMaratona = true;

        console.log(`[MARATONA] ${playerId} Riconnesso a ${roomCode}`);

        // Sync State
        socket.emit('maratonaStateSync', {
            gameStarted: room.gameStarted,
            roomCode: roomCode,
            guesses: room.guesses.map(g => ({
                word: g.word,
                playerId: g.playerId, // Need ID to know owner
                feedback: (g.playerId === playerId) ? g.feedback : null // Mask others?
                // Actually, in Maratona usually everyone sees everyone's guesses? 
                // The original code: emitted `maratonaGuessUpdate` with `isOwner`.
                // The opponent saw the row. Did they see the feedback colors?
                // "feedback: isOwner ? feedback : null". So opponent sees simple row.
                // We replicate that here.
            }))
        });
    });

    // ---------------- SUBMIT GUESS ----------------
    socket.on('submitMaratonaGuess', (data) => {
        // Support both object and legacy string for backward compat if needed, but we updated client
        let guess = data;
        let pId = socket.playerId;

        if (typeof data === 'object') {
            guess = data.guess;
            // pId = data.playerId; // trust socket.playerId check more securely ?
            // Let's use socket.playerId as source of truth if available
        }

        if (!pId) return;

        // Find room
        const roomCode = socket.roomId;
        const room = maratonaRooms[roomCode];

        if (!room || !room.gameStarted) return;

        const guessUpper = guess.toUpperCase();
        if (guessUpper.length !== 5) return;

        // Validate
        let validList = VALID_WORDS_IT;
        if (room.lang === 'en') validList = VALID_WORDS_EN;

        const isDictionaryWord = validList.includes(guessUpper);
        let isValidStructure = true;
        if (!isDictionaryWord) {
            const threeConsonantsRegex = /[^AEIOU]{3}/;
            const hasVowelRegex = /[AEIOU]/;
            if (threeConsonantsRegex.test(guessUpper)) isValidStructure = false;
            if (!hasVowelRegex.test(guessUpper)) isValidStructure = false;
        }

        if (!isDictionaryWord && !isValidStructure) {
            socket.emit('maratonaError', 'Parola non valida!');
            return;
        }

        // Calculate Feedback
        const feedback = checkWord(guessUpper, room.secretWord);

        // Add to history
        const guessEntry = {
            word: guessUpper,
            playerId: pId,
            feedback: feedback
        };
        room.guesses.push(guessEntry);

        // Broadcast
        room.players.forEach(pid => {
            const sockId = room.sockets[pid];
            if (sockId) {
                io.to(sockId).emit('maratonaGuessUpdate', {
                    word: guessUpper,
                    feedback: (pid === pId) ? feedback : null,
                    isOwner: (pid === pId)
                });
            }
        });

        // Win Check
        if (guessUpper === room.secretWord) {
            room.gameStarted = false;
            io.to(roomCode).emit('maratonaGameOver', {
                winnerId: socket.id, // Or playerId? Client checks socket.id usually
                winnerPlayerId: pId,
                secretWord: room.secretWord
            });
        }
    });

    // ---------------- REMATCH ----------------
    socket.on('maratonaRematch', () => {
        const roomCode = socket.roomId;
        const room = maratonaRooms[roomCode];
        if (!room) return;

        const pId = socket.playerId;
        room.rematchRequests.add(pId);

        if (room.rematchRequests.size >= 2) {
            // New Game
            let secretList = SECRET_WORDS_IT;
            if (room.lang === 'en') secretList = SECRET_WORDS_EN;
            room.secretWord = secretList[Math.floor(Math.random() * secretList.length)];
            room.guesses = [];
            room.rematchRequests.clear();
            room.gameStarted = true;

            io.to(roomCode).emit('maratonaRematchStart', {
                message: 'Nuova partita iniziata!',
            });
        } else {
            io.to(roomCode).emit('maratonaRematchRequested', 'Un giocatore vuole la rivincita...');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server Socket.io in ascolto sulla porta ${PORT}`);
    console.log(`Accessibile su http://localhost:${PORT}`);
});

function checkWord(guess, secret) {
    const feedback = new Array(5).fill('not-in-word');
    const secretArr = secret.split('');
    const guessArr = guess.split('');

    // First pass: Correct position
    for (let i = 0; i < 5; i++) {
        if (guessArr[i] === secretArr[i]) {
            feedback[i] = 'correct-position';
            secretArr[i] = null;
            guessArr[i] = null;
        }
    }

    // Second pass: Wrong position
    for (let i = 0; i < 5; i++) {
        if (guessArr[i] && secretArr.includes(guessArr[i])) {
            feedback[i] = 'wrong-position';
            const index = secretArr.indexOf(guessArr[i]);
            secretArr[index] = null;
        }
    }
    return feedback;
}
