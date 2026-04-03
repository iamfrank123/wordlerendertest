const { getRandomWord } = require('./words');

// Rooms storage for Maratona mode
const rooms = {};

// Generate unique room code
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

// Calculate points for the winner
function calculatePoints(wordLength, revealedCount, elapsedSeconds) {
    const total = wordLength;
    const multiplier = 1 + (wordLength - 5) * 0.2;
    const bonusLetters = 100 * (total - revealedCount) / total;
    const timePenalty = Math.min(2 * elapsedSeconds, 60);
    const raw = (50 + bonusLetters - timePenalty) * multiplier;
    return Math.max(Math.round(raw), 10);
}

function initMaratona(ioMain) {
    const io = ioMain.of('/maratona');
    console.log('[MARATONA] Module initialized on namespace /maratona');

    io.on('connection', (socket) => {
        console.log(`[MARATONA] New connection: ${socket.id}`);

        // ──────────────────────────────────────────────
        //  CREATE ROOM
        // ──────────────────────────────────────────────
        socket.on('createRoom', ({ nickname, wordLength, language }) => {
            const roomCode = generateRoomCode();
            const isShufflef = wordLength === 'shuffle';

            rooms[roomCode] = {
                code: roomCode,
                host: socket.id,
                players: [{
                    id: socket.id,
                    nickname: nickname || 'Host',
                    score: 0
                }],
                config: {
                    wordLength: isShufflef ? null : (parseInt(wordLength) || 5),
                    shuffle: isShufflef,
                    language: language || 'it'
                },
                gameState: {
                    status: 'lobby',      // lobby | playing | ended
                    secretWord: null,
                    revealedLetters: {},  // { position: letter }
                    revealInterval: null,
                    startTime: null,
                    revealOrder: []       // shuffled positions to reveal
                }
            };

            socket.join(roomCode);
            socket.roomId = roomCode;

            socket.emit('roomCreated', { roomCode, config: rooms[roomCode].config });
            console.log(`[MARATONA] Room created: ${roomCode} by ${nickname}`);
        });

        // ──────────────────────────────────────────────
        //  JOIN ROOM
        // ──────────────────────────────────────────────
        socket.on('joinRoom', ({ roomCode, nickname }) => {
            const room = rooms[roomCode];
            if (!room) return socket.emit('error', 'Stanza non trovata');

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

                    socket.join(roomCode);
                    socket.roomId = roomCode;

                    console.log(`[MARATONA] ${nickname} reconnected to ${roomCode}`);

                    io.to(roomCode).emit('playerReconnected', {
                        oldId,
                        newId: socket.id,
                        nickname: existingPlayer.nickname,
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                    });

                    // Invia lo stato attuale al giocatore riconnesso
                    socket.emit('reconnectSuccess', {
                        roomCode,
                        config: room.config,
                        isHost: room.host === socket.id,
                        gameState: { ...room.gameState, revealInterval: null }, // Evita problemi di conversione al JSON dell'intervallo
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                    });
                    return;
                } else {
                    return socket.emit('error', 'Il nickname è già in uso in questa stanza.');
                }
            }

            // Se è in corso una partita, il giocatore può comunque entrare (Join Tardivo).
            // Rimuoviamo questo blocco:
            // if (room.gameState.status !== 'lobby') return socket.emit('error', 'Partita già in corso');

            const newPlayer = {
                id: socket.id,
                nickname: nickname || `Player ${room.players.length + 1}`,
                score: 0,
                disconnected: false
            };

            room.players.push(newPlayer);
            socket.join(roomCode);
            socket.roomId = roomCode;

            console.log(`[MARATONA] ${nickname} joined ${roomCode}`);

            // Se la partita è in corso, manda al nuovo arrivato tutto il contesto necessario per saltare subito in gioco
            if (room.gameState.status === 'playing') {
                socket.emit('reconnectSuccess', {
                    roomCode,
                    config: room.config,
                    isHost: false, // I nuovi entrati non sono host
                    gameState: { ...room.gameState, revealInterval: null }, // Manda lo stato per fargli vedere le lettere rivelate
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                });
            } else {
                // Se sono in lobby, normale reazione
                socket.emit('playerJoined', {
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                });
            }

            // Avvisa gli ALTRI giocatori
            socket.to(roomCode).emit('playerJoined', {
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
            });
        });

        // ──────────────────────────────────────────────
        //  START GAME  (host only)
        // ──────────────────────────────────────────────
        socket.on('startGame', () => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.host !== socket.id) return;
            startRound(roomCode);
        });

        function startRound(roomCode) {
            const room = rooms[roomCode];

            // Choose word length
            let length;
            if (room.config.shuffle) {
                length = Math.floor(Math.random() * 4) + 5; // 5-8
            } else {
                length = room.config.wordLength || 5;
            }

            const secretWord = getRandomWord(length, room.config.language);
            if (!secretWord) {
                io.to(roomCode).emit('error', 'Impossibile trovare una parola.');
                return;
            }

            // Clean up any existing interval
            if (room.gameState.revealInterval) {
                clearInterval(room.gameState.revealInterval);
                room.gameState.revealInterval = null;
            }

            // Build shuffled reveal order (random letter positions)
            const revealOrder = Array.from({ length: secretWord.length }, (_, i) => i);
            for (let i = revealOrder.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [revealOrder[i], revealOrder[j]] = [revealOrder[j], revealOrder[i]];
            }

            room.gameState.status = 'playing';
            room.gameState.secretWord = secretWord;
            room.gameState.revealedLetters = {};
            room.gameState.revealOrder = revealOrder;
            room.gameState.startTime = Date.now();

            io.to(roomCode).emit('gameStarted', {
                wordLength: secretWord.length,
                language: room.config.language,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
            });

            console.log(`[MARATONA] Round started in ${roomCode}. Word: ${secretWord} (${secretWord.length} letters)`);

            // Reveal one letter every 10 seconds
            let revealIndex = 0;
            room.gameState.revealInterval = setInterval(() => {
                if (!rooms[roomCode]) {
                    clearInterval(room.gameState.revealInterval);
                    return;
                }

                if (room.gameState.status !== 'playing') {
                    clearInterval(room.gameState.revealInterval);
                    room.gameState.revealInterval = null;
                    return;
                }

                if (revealIndex >= revealOrder.length) {
                    // All letters revealed — force end if nobody won
                    clearInterval(room.gameState.revealInterval);
                    room.gameState.revealInterval = null;

                    if (room.gameState.status === 'playing') {
                        room.gameState.status = 'ended';
                        io.to(roomCode).emit('roundEnded', {
                            winnerId: null,
                            winnerNickname: null,
                            secretWord: secretWord,
                            winnerScore: 0,
                            players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
                        });
                        console.log(`[MARATONA] Round ended with no winner in ${roomCode}`);
                    }
                    return;
                }

                const pos = revealOrder[revealIndex];
                const letter = secretWord[pos];
                room.gameState.revealedLetters[pos] = letter;
                revealIndex++;

                io.to(roomCode).emit('letterRevealed', {
                    position: pos,
                    letter: letter,
                    revealedLetters: room.gameState.revealedLetters,
                    revealedCount: Object.keys(room.gameState.revealedLetters).length
                });

                console.log(`[MARATONA] Letter revealed in ${roomCode}: ${letter} at pos ${pos}`);
            }, 10000);
        }

        // ──────────────────────────────────────────────
        //  SUBMIT WORD
        // ──────────────────────────────────────────────
        socket.on('submitWord', (word) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.gameState.status !== 'playing') return;

            const upper = word.toUpperCase().trim();

            if (upper.length !== room.gameState.secretWord.length) {
                return socket.emit('wordResult', {
                    correct: false,
                    message: `Usa una parola di ${room.gameState.secretWord.length} lettere.`
                });
            }

            const correct = upper === room.gameState.secretWord;

            if (correct) {
                handleWin(room, socket.id);
            } else {
                socket.emit('wordResult', {
                    correct: false,
                    message: '❌ Parola sbagliata!'
                });
            }
        });

        function handleWin(room, winnerId) {
            if (room.gameState.status !== 'playing') return;

            // Stop the reveal interval
            if (room.gameState.revealInterval) {
                clearInterval(room.gameState.revealInterval);
                room.gameState.revealInterval = null;
            }

            room.gameState.status = 'ended';

            const revealedCount = Object.keys(room.gameState.revealedLetters).length;
            const elapsedSeconds = Math.floor((Date.now() - room.gameState.startTime) / 1000);
            const points = calculatePoints(room.gameState.secretWord.length, revealedCount, elapsedSeconds);

            const winner = room.players.find(p => p.id === winnerId);
            if (winner) winner.score += points;

            const winnerNickname = winner ? winner.nickname : 'Unknown';

            io.to(room.code).emit('roundEnded', {
                winnerId,
                winnerNickname,
                secretWord: room.gameState.secretWord,
                winnerScore: points,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
            });

            console.log(`[MARATONA] Round ended in ${room.code}. Winner: ${winnerNickname} (+${points} pts)`);
        }

        // ──────────────────────────────────────────────
        //  NEXT ROUND  (host only)
        // ──────────────────────────────────────────────
        socket.on('nextRound', (configUpdate) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.host !== socket.id) return;

            if (configUpdate) {
                if (configUpdate.wordLength !== undefined) {
                    if (configUpdate.wordLength === 'shuffle') {
                        room.config.shuffle = true;
                        room.config.wordLength = null;
                    } else {
                        room.config.shuffle = false;
                        room.config.wordLength = parseInt(configUpdate.wordLength) || 5;
                    }
                }
                if (configUpdate.language) {
                    room.config.language = configUpdate.language;
                }
            }

            room.gameState.status = 'lobby';
            startRound(roomCode);
        });

        // ──────────────────────────────────────────────
        //  LEAVE ROOM  (voluntary exit)
        // ──────────────────────────────────────────────
        socket.on('leaveRoom', () => {
            const roomCode = socket.roomId;
            handleLeave(socket.id, roomCode);
            socket.roomId = null;
        });

        // ──────────────────────────────────────────────
        //  DISCONNECT
        // ──────────────────────────────────────────────
        socket.on('disconnect', () => {
            console.log(`[MARATONA] Disconnect: ${socket.id}`);
            const roomCode = socket.roomId;
            if (!roomCode || !rooms[roomCode]) return;
            const room = rooms[roomCode];

            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.disconnected = true;
                player.disconnectTimeout = setTimeout(() => {
                    if (rooms[roomCode]) {
                        handleLeave(socket.id, roomCode);
                    }
                }, 60000); // 60 secondi di tolleranza

                io.to(roomCode).emit('playerDisconnected', {
                    playerId: socket.id,
                    nickname: player.nickname
                });
            }
        });

        function handleLeave(playerId, roomCode) {
            if (!roomCode || !rooms[roomCode]) return;

            const room = rooms[roomCode];

            room.players = room.players.filter(p => p.id !== playerId);

            if (room.players.length === 0) {
                if (room.gameState.revealInterval) {
                    clearInterval(room.gameState.revealInterval);
                    room.gameState.revealInterval = null;
                }
                delete rooms[roomCode];
                console.log(`[MARATONA] Room ${roomCode} deleted — no players left`);
                return;
            }

            // Assign new host if needed
            if (playerId === room.host) {
                if (room.players.length > 0) {
                    room.host = room.players[0].id;
                    io.to(room.code).emit('newHost', { hostId: room.host });
                    console.log(`[MARATONA] New host in ${roomCode}: ${room.host}`);
                }
            }

            io.to(room.code).emit('playerLeft', {
                playerId: playerId,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
            });
        }
    });
}

module.exports = initMaratona;
