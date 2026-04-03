const { getRandomWord, isValidWord } = require('./words');

// Rooms storage (internal to this module, isolated)
const rooms = {};

// Helper to generate room code
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

// Select a word based on room configuration
function selectSecretWord(config) {
    let lengthToUse;

    if (config.selectedLengths.length === 1) {
        lengthToUse = config.selectedLengths[0];
    } else {
        // Shuffle/Multiple: pick random from selected
        const idx = Math.floor(Math.random() * config.selectedLengths.length);
        lengthToUse = config.selectedLengths[idx];
    }

    const word = getRandomWord(lengthToUse, config.language || 'it');
    console.log(`[PAROLE-XL DEBUG] Selected word length: ${lengthToUse}, lang: ${config.language || 'it'}, Word: ${word}`);
    return { word, length: lengthToUse };
}

function initParoleXL(ioMain) {
    // Determine if we should use a namespace or main io.
    // Using a namespace '/parole_xl' is best for isolation.
    const io = ioMain.of('/parole_xl');

    console.log("[PAROLE-XL] Module initialized on namespace /parole_xl");

    io.on('connection', (socket) => {
        console.log(`[PAROLE-XL] New connection: ${socket.id}`);

        // Create Room
        socket.on('createRoom', (config) => {
            // Config: { nickname, selectedLengths: [5, 6...], timerEnabled: bool, autoNext: bool, language: 'it'|'en' }
            const roomCode = generateRoomCode();

            rooms[roomCode] = {
                code: roomCode,
                host: socket.id,
                players: [{
                    id: socket.id,
                    nickname: config.nickname || 'Host',
                    score: 0,
                    status: 'waiting' // waiting, ready, playing
                }],
                config: {
                    selectedLengths: config.selectedLengths || [5],
                    gameMode: config.gameMode || 'turns',
                    timerEnabled: config.gameMode === 'turns',
                    autoNext: config.autoNext || false,
                    language: config.language || 'it'
                },
                gameState: {
                    status: 'lobby', // lobby, playing, ended
                    secretWord: null,
                    wordLength: 0,
                    turnIndex: 0,
                    timer: null,
                    grids: {}, // playerId -> [] of guesses
                    greenIndices: {} // For Realtime
                }
            };

            socket.join(roomCode);
            socket.roomId = roomCode;

            socket.emit('roomCreated', { roomCode, config: rooms[roomCode].config });
            console.log(`[PAROLE-XL] Room created: ${roomCode}`);
        });

        // Join Room
        socket.on('joinRoom', ({ roomCode, nickname }) => {
            const room = rooms[roomCode];
            if (!room) {
                return socket.emit('error', 'Stanza non trovata');
            }

            const nickLower = (nickname || '').toLowerCase();
            const existingPlayer = room.players.find(p => p.nickname.toLowerCase() === nickLower);

            if (existingPlayer) {
                if (existingPlayer.disconnected) {
                    clearTimeout(existingPlayer.disconnectTimeout);
                    existingPlayer.disconnected = false;

                    const oldId = existingPlayer.id;
                    existingPlayer.id = socket.id;

                    if (room.host === oldId) {
                        room.host = socket.id;
                    }

                    if (room.gameState.currentTurnPlayerId === oldId) {
                        room.gameState.currentTurnPlayerId = socket.id;
                    }

                    if (room.gameState.grids[oldId]) {
                        room.gameState.grids[socket.id] = room.gameState.grids[oldId];
                        delete room.gameState.grids[oldId];
                    } else {
                        room.gameState.grids[socket.id] = [];
                    }

                    if (room.gameState.greenIndices[oldId]) {
                        room.gameState.greenIndices[socket.id] = room.gameState.greenIndices[oldId];
                        delete room.gameState.greenIndices[oldId];
                    } else {
                        room.gameState.greenIndices[socket.id] = new Set();
                    }

                    socket.join(roomCode);
                    socket.roomId = roomCode;

                    console.log(`[PAROLE-XL] ${nickname} reconnected to ${roomCode}`);

                    io.to(roomCode).emit('playerReconnected', {
                        oldId,
                        newId: socket.id,
                        nickname: existingPlayer.nickname,
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected, status: p.status }))
                    });

                    socket.emit('reconnectSuccess', {
                        roomCode,
                        config: room.config,
                        isHost: room.host === socket.id,
                        gameState: { ...room.gameState, timer: null, greenIndices: {} }, // Passiamo greenIndices vuoto per non serializzare Set complessi
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected, status: p.status })),
                        myGrid: room.gameState.grids[socket.id]
                    });
                    return;
                } else {
                    return socket.emit('error', 'Il nickname è già in uso in questa stanza.');
                }
            }

            const newPlayer = {
                id: socket.id,
                nickname: nickname || `Player ${room.players.length + 1}`,
                score: 0,
                status: room.gameState.status === 'playing' ? 'playing' : 'waiting',
                disconnected: false
            };

            room.players.push(newPlayer);
            socket.join(roomCode);
            socket.roomId = roomCode;

            if (room.gameState.status === 'playing') {
                room.gameState.grids[socket.id] = [];
                room.gameState.greenIndices[socket.id] = new Set();
            }

            console.log(`[PAROLE-XL] ${nickname} joined ${roomCode}`);

            if (room.gameState.status === 'playing') {
                socket.emit('reconnectSuccess', {
                    roomCode,
                    config: room.config,
                    isHost: false,
                    gameState: { ...room.gameState, timer: null, greenIndices: {} },
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected, status: p.status })),
                    myGrid: []
                });
            } else {
                socket.emit('playerJoined', {
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, status: p.status, disconnected: p.disconnected }))
                });
            }

            socket.to(roomCode).emit('playerJoined', {
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, status: p.status, disconnected: p.disconnected }))
            });
        });

        // Start Game
        socket.on('startGame', () => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;

            startRound(roomCode);
        });

        function startRound(roomCode) {
            const room = rooms[roomCode];
            const selection = selectSecretWord(room.config);

            if (!selection.word) {
                io.to(roomCode).emit('error', 'Impossibile trovare una parola per la lunghezza selezionata.');
                return;
            }

            // Clean up any existing timer before starting new round
            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
                console.log(`[PAROLE-XL] Cleaned existing timer in ${roomCode}`);
            }

            room.gameState.status = 'playing';
            room.gameState.secretWord = selection.word;
            room.gameState.wordLength = selection.length;
            room.gameState.grids = {};
            room.gameState.startTime = Date.now();
            room.players.forEach(p => {
                room.gameState.grids[p.id] = [];
                room.gameState.greenIndices[p.id] = new Set();
                p.status = 'playing';
            });

            io.to(roomCode).emit('gameStarted', {
                wordLength: selection.length,
                language: room.config.language || 'it',
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
                gameMode: room.config.gameMode,
                timerEnabled: room.config.timerEnabled
            });

            console.log(`[PAROLE-XL] Round started in ${roomCode}. Word: ${selection.word}`);

            if (room.config.gameMode === 'turns') {
                room.gameState.turnIndex = 0;
                room.gameState.currentTurnPlayerId = room.players[0].id;
                notifyTurn(room);
            } else {
                io.to(roomCode).emit('turnUpdate', { playerId: null, message: "GARA DI VELOCITÀ!" });
            }
        }

        function notifyTurn(room) {
            // Validate room and players exist
            if (!room || !room.players || room.players.length === 0) {
                console.log(`[PAROLE-XL] Cannot notify turn - invalid room state`);
                return;
            }

            const currentPlayerId = room.gameState.currentTurnPlayerId;
            if (!currentPlayerId) {
                console.log(`[PAROLE-XL] Cannot notify turn - no current player ID`);
                return;
            }

            const timeLeft = 45; // Seconds

            io.to(room.code).emit('turnUpdate', {
                playerId: currentPlayerId,
                timeLeft: room.config.timerEnabled ? timeLeft : null
            });

            if (room.config.timerEnabled) {
                // Clean up existing timer
                if (room.gameState.timer) {
                    clearInterval(room.gameState.timer);
                    room.gameState.timer = null;
                }

                let seconds = timeLeft;
                const roomCode = room.code;
                room.gameState.timer = setInterval(() => {
                    // Validate room still exists
                    if (!rooms[roomCode]) {
                        clearInterval(room.gameState.timer);
                        console.log(`[PAROLE-XL] Timer stopped - room ${roomCode} no longer exists`);
                        return;
                    }

                    seconds--;
                    if (seconds <= 0) {
                        clearInterval(room.gameState.timer);
                        room.gameState.timer = null;
                        console.log(`[PAROLE-XL] Timer expired in ${roomCode}, passing turn`);
                        handlePassTurn(rooms[roomCode]);
                    }
                }, 1000);
            }
        }

        function handlePassTurn(room) {
            // Validate room and its state
            if (!room || !room.gameState) {
                console.log(`[PAROLE-XL] Cannot pass turn - invalid room`);
                return;
            }

            // Clean up timer
            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
            }

            // Check if game is still active before passing turn
            if (room.gameState.status !== 'playing') {
                console.log(`[PAROLE-XL] Cannot pass turn - game status is ${room.gameState.status}`);
                return;
            }

            // Validate players exist
            if (!room.players || room.players.length === 0) {
                console.log(`[PAROLE-XL] Cannot pass turn - no players in room`);
                return;
            }

            // Move to next player
            room.gameState.turnIndex = (room.gameState.turnIndex + 1) % room.players.length;
            room.gameState.currentTurnPlayerId = room.players[room.gameState.turnIndex].id;

            console.log(`[PAROLE-XL] Turn passed to player ${room.gameState.currentTurnPlayerId} (index ${room.gameState.turnIndex})`);
            notifyTurn(room);
        }

        socket.on('submitGuess', (guess) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.gameState.status !== 'playing') return;

            // Turn Validation
            if (room.config.gameMode === 'turns') {
                if (room.gameState.currentTurnPlayerId !== socket.id) {
                    return socket.emit('error', 'Non è il tuo turno!');
                }
            }

            const word = guess.toUpperCase();
            if (word.length !== room.gameState.wordLength) {
                return socket.emit('error', `Lunghezza errata. Devi usare ${room.gameState.wordLength} lettere.`);
            }

            // Logic
            const feedback = calculateFeedback(word, room.gameState.secretWord);
            room.gameState.grids[socket.id].push({ word, feedback });

            const won = word === room.gameState.secretWord;

            if (room.config.gameMode === 'turns') {
                // Shared View: Broadcast to ALL
                io.to(roomCode).emit('guessResult', {
                    playerId: socket.id,
                    word,
                    feedback,
                    won
                });

                if (won) {
                    handleWin(room, socket.id);
                } else {
                    handlePassTurn(room);
                }
            } else {
                // Realtime: Private View

                // 1. Send full result only to sender
                socket.emit('guessResult', {
                    playerId: socket.id,
                    word,
                    feedback,
                    won
                });

                // 2. Update Green Count and Broadcast Score to Others
                const greenSet = room.gameState.greenIndices[socket.id];
                feedback.forEach((status, idx) => {
                    if (status === 'correct') greenSet.add(idx);
                });
                const greenCount = greenSet.size;

                io.to(roomCode).emit('scoreUpdate', {
                    playerId: socket.id,
                    greenCount: greenCount,
                    totalLength: room.gameState.wordLength,
                    won: won
                });

                if (won) {
                    handleWin(room, socket.id);
                }
            }
        });




        function handleWin(room, winnerId) {
            // Clean up timer properly
            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
                console.log(`[PAROLE-XL] Timer cleaned on win in room ${room.code}`);
            }

            room.gameState.status = 'ended';

            const winner = room.players.find(p => p.id === winnerId);
            if (winner) winner.score++;

            io.to(room.code).emit('roundEnded', {
                winnerId,
                secretWord: room.gameState.secretWord,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score })),
                scores: room.players.map(p => ({ id: p.id, score: p.score }))
            });

            console.log(`[PAROLE-XL] Round ended in ${room.code}. Winner: ${winnerId}`);
        }

        function calculateFeedback(guess, secret) {
            const res = new Array(guess.length).fill('absent');
            const secretArr = secret.split('');
            const guessArr = guess.split('');

            // Green
            for (let i = 0; i < guess.length; i++) {
                if (guessArr[i] === secretArr[i]) {
                    res[i] = 'correct';
                    secretArr[i] = null;
                    guessArr[i] = null;
                }
            }

            // Yellow
            for (let i = 0; i < guess.length; i++) {
                if (guessArr[i] !== null) {
                    const idx = secretArr.indexOf(guessArr[i]);
                    if (idx !== -1) {
                        res[i] = 'present';
                        secretArr[idx] = null;
                    }
                }
            }
            return res;
        }

        // Emoji Reactions
        socket.on('emojiReaction', ({ emoji, roomCode }) => {
            const room = rooms[roomCode];
            if (!room) return;

            const player = room.players.find(p => p.id === socket.id);
            const playerName = player ? player.nickname : 'Unknown';

            // Broadcast to all players in the room
            io.to(roomCode).emit('emojiReaction', {
                emoji,
                playerId: socket.id,
                playerName
            });

            console.log(`[PAROLE-XL] ${playerName} sent emoji ${emoji} in room ${roomCode}`);
        });

        // Rematch / Next Round
        socket.on('nextRound', (configUpdate) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.host !== socket.id) return;

            // Allow host to update config for next round
            if (configUpdate && configUpdate.length) {
                // Validate length
                room.config.selectedLengths = [configUpdate.length]; // Simplified for manual choice
            }
            if (configUpdate && configUpdate.language) {
                room.config.language = configUpdate.language;
            }

            startRound(roomCode);
        });

        socket.on('disconnect', () => {
            console.log(`[PAROLE-XL] Disconnect: ${socket.id}`);

            if (socket.roomId && rooms[socket.roomId]) {
                const room = rooms[socket.roomId];
                const player = room.players.find(p => p.id === socket.id);

                if (player) {
                    player.disconnected = true;
                    player.disconnectTimeout = setTimeout(() => {
                        if (rooms[socket.roomId]) {
                            handleLeave(socket.id, socket.roomId);
                        }
                    }, 60000); // 60s

                    io.to(socket.roomId).emit('playerDisconnected', {
                        playerId: socket.id,
                        nickname: player.nickname
                    });
                }
            }
        });

        // Manual Leave
        socket.on('leaveRoom', () => {
            if (socket.roomId) {
                handleLeave(socket.id, socket.roomId);
                socket.roomId = null;
            }
        });

        function handleLeave(playerId, roomCode) {
            if (!roomCode || !rooms[roomCode]) return;
            const room = rooms[roomCode];

            // Clean up timer if current player disconnected/left AND they are actually being removed
            if (room.gameState && room.gameState.currentTurnPlayerId === playerId) {
                if (room.gameState.timer) {
                    clearInterval(room.gameState.timer);
                    room.gameState.timer = null;
                }
            }

            room.players = room.players.filter(p => p.id !== playerId);
            io.to(room.code).emit('playerLeft', {
                playerId: playerId,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected, status: p.status })),
                secretWord: room.gameState ? room.gameState.secretWord : null
            });

            if (room.players.length === 0) {
                if (room.gameState && room.gameState.timer) {
                    clearInterval(room.gameState.timer);
                    room.gameState.timer = null;
                }
                delete rooms[roomCode];
                console.log(`[PAROLE-XL] Room ${roomCode} deleted - no players left`);
            } else if (playerId === room.host) {
                if (room.players.length > 0) {
                    room.host = room.players[0].id;
                    io.to(room.code).emit('newHost', { hostId: room.host });
                }

                if (room.gameState && room.gameState.status === 'playing' && room.gameState.currentTurnPlayerId === playerId) {
                    console.log(`[PAROLE-XL] Passing turn due to disconnect/leave`);
                    handlePassTurn(room);
                }
            } else if (room.gameState && room.gameState.status === 'playing' && room.gameState.currentTurnPlayerId === playerId) {
                console.log(`[PAROLE-XL] Passing turn due to disconnect/leave`);
                handlePassTurn(room);
            }
        }
    });
}

module.exports = initParoleXL;
