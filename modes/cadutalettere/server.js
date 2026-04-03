// ────────────────────────────────────────────────────────────
//  Caduta Lettere – Server Logic
// ────────────────────────────────────────────────────────────

const rooms = {};

// Generate unique 4-char room code
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

// Weighted random speed as requested: 30 per 5, 40 per 8, 70 per 7 (total 140 = probability distribution)
function randomSpeed() {
    const r = Math.random() * 140;
    if (r < 30) return 5;  // 30 / 140 = ~21%
    if (r < 70) return 8;  // 40 / 140 = ~29%
    return 7;              // 70 / 140 = 50%
}

// Random letter (A-Z, excluding rare Italian letters for more fun)
const ALPHABET = 'ABCDEFGHILMNOPQRSTUVZ'; // Italian-friendly
function randomLetter() {
    return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

function initCadutaLettere(ioMain) {
    const io = ioMain.of('/cadutalettere');
    console.log('[CADUTA LETTERE] Module initialized on namespace /cadutalettere');

    io.on('connection', (socket) => {
        console.log(`[CADUTA LETTERE] New connection: ${socket.id}`);

        // ──────────────────────────────────────────────
        //  CREATE ROOM
        // ──────────────────────────────────────────────
        socket.on('createRoom', ({ nickname, gameMode, gameModeValue }) => {
            const roomCode = generateRoomCode();

            rooms[roomCode] = {
                code: roomCode,
                host: socket.id,
                players: [{
                    id: socket.id,
                    nickname: nickname || 'Host',
                    score: 0,
                    correctLetters: 0
                }],
                config: {
                    gameMode: gameMode || 'time',       // 'time' | 'points'
                    gameModeValue: parseInt(gameModeValue) || 180  // seconds or target points
                },
                gameState: {
                    status: 'lobby',       // lobby | playing | ended
                    speed: 7,
                    speedInterval: null,
                    letterInterval: null,
                    gameTimer: null,
                    startTime: null,
                    seed: Math.floor(Math.random() * 1000000)
                }
            };

            socket.join(roomCode);
            socket.roomId = roomCode;

            socket.emit('roomCreated', {
                roomCode,
                config: rooms[roomCode].config
            });
            console.log(`[CADUTA LETTERE] Room created: ${roomCode} by ${nickname}`);
        });

        // ──────────────────────────────────────────────
        //  JOIN ROOM
        // ──────────────────────────────────────────────
        socket.on('joinRoom', ({ roomCode, nickname }) => {
            const room = rooms[roomCode];
            if (!room) return socket.emit('error', 'Stanza non trovata!');

            const nickLower = (nickname || '').toLowerCase();
            const existing = room.players.find(p => p.nickname.toLowerCase() === nickLower);

            if (existing) {
                if (existing.disconnected) {
                    clearTimeout(existing.disconnectTimeout);
                    existing.disconnected = false;
                    const oldId = existing.id;
                    existing.id = socket.id;
                    if (room.host === oldId) room.host = socket.id;

                    socket.join(roomCode);
                    socket.roomId = roomCode;

                    io.to(roomCode).emit('playerReconnected', {
                        nickname: existing.nickname,
                        players: room.players.map(p => ({
                            id: p.id, nickname: p.nickname, score: p.score,
                            correctLetters: p.correctLetters, disconnected: p.disconnected
                        }))
                    });

                    // Send state sync to reconnected player
                    socket.emit('reconnectSuccess', {
                        roomCode,
                        config: room.config,
                        isHost: room.host === socket.id,
                        gameState: {
                            status: room.gameState.status,
                            speed: room.gameState.speed,
                            seed: room.gameState.seed,
                            startTime: room.gameState.startTime
                        },
                        players: room.players.map(p => ({
                            id: p.id, nickname: p.nickname, score: p.score,
                            correctLetters: p.correctLetters, disconnected: p.disconnected
                        }))
                    });
                    console.log(`[CADUTA LETTERE] ${nickname} reconnected to ${roomCode}`);
                    return;
                } else {
                    return socket.emit('error', 'Il nickname è già in uso in questa stanza.');
                }
            }

            const newPlayer = {
                id: socket.id,
                nickname: nickname || `Player ${room.players.length + 1}`,
                score: 0,
                correctLetters: 0,
                disconnected: false
            };

            room.players.push(newPlayer);
            socket.join(roomCode);
            socket.roomId = roomCode;

            console.log(`[CADUTA LETTERE] ${nickname} joined ${roomCode}`);

            // If game is already playing, send full state
            if (room.gameState.status === 'playing') {
                socket.emit('reconnectSuccess', {
                    roomCode,
                    config: room.config,
                    isHost: false,
                    gameState: {
                        status: room.gameState.status,
                        speed: room.gameState.speed,
                        seed: room.gameState.seed,
                        startTime: room.gameState.startTime
                    },
                    players: room.players.map(p => ({
                        id: p.id, nickname: p.nickname, score: p.score,
                        correctLetters: p.correctLetters, disconnected: p.disconnected
                    }))
                });
            } else {
                socket.emit('playerJoined', {
                    players: room.players.map(p => ({
                        id: p.id, nickname: p.nickname, score: p.score,
                        correctLetters: p.correctLetters, disconnected: p.disconnected
                    }))
                });
            }

            socket.to(roomCode).emit('playerJoined', {
                players: room.players.map(p => ({
                    id: p.id, nickname: p.nickname, score: p.score,
                    correctLetters: p.correctLetters, disconnected: p.disconnected
                }))
            });
        });

        // ──────────────────────────────────────────────
        //  START GAME (host only)
        // ──────────────────────────────────────────────
        socket.on('startGame', () => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.host !== socket.id) return;
            if (room.gameState.status === 'playing') return;

            startGame(roomCode);
        });

        function startGame(roomCode) {
            const room = rooms[roomCode];
            if (!room) return;

            // Reset scores
            room.players.forEach(p => {
                p.score = 0;
                p.correctLetters = 0;
            });

            const seed = Math.floor(Math.random() * 1000000);
            room.gameState.status = 'playing';
            room.gameState.speed = 7;
            room.gameState.seed = seed;
            room.gameState.startTime = Date.now();

            io.to(roomCode).emit('gameStarted', {
                seed: seed,
                speed: 6,
                config: room.config,
                startTime: room.gameState.startTime,
                players: room.players.map(p => ({
                    id: p.id, nickname: p.nickname, score: p.score,
                    correctLetters: p.correctLetters
                }))
            });

            console.log(`[CADUTA LETTERE] Game started in ${roomCode} (mode: ${room.config.gameMode}, value: ${room.config.gameModeValue})`);

            // Speed change every 20 seconds
            room.gameState.speedInterval = setInterval(() => {
                if (!rooms[roomCode] || room.gameState.status !== 'playing') {
                    clearInterval(room.gameState.speedInterval);
                    return;
                }

                const newSpeed = randomSpeed();
                room.gameState.speed = newSpeed;
                io.to(roomCode).emit('speedChange', { speed: newSpeed });
                console.log(`[CADUTA LETTERE] Speed change in ${roomCode}: ${newSpeed}`);
            }, 20000);

            // Game timer for 'time' mode
            if (room.config.gameMode === 'time') {
                const durationMs = room.config.gameModeValue * 1000;
                room.gameState.gameTimer = setTimeout(() => {
                    endGame(roomCode, null);
                }, durationMs);
            }
        }

        // ──────────────────────────────────────────────
        //  SCORE UPDATE (from client)
        // ──────────────────────────────────────────────
        socket.on('scoreUpdate', ({ score, correctLetters }) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.gameState.status !== 'playing') return;

            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            player.score = score;
            player.correctLetters = correctLetters;

            // Broadcast to all players
            io.to(roomCode).emit('leaderboardUpdate', {
                players: room.players.map(p => ({
                    id: p.id, nickname: p.nickname, score: p.score,
                    correctLetters: p.correctLetters
                }))
            });

            // Check if points target reached
            if (room.config.gameMode === 'points' && score >= room.config.gameModeValue) {
                endGame(roomCode, socket.id);
            }
        });

        function endGame(roomCode, winnerId) {
            const room = rooms[roomCode];
            if (!room || room.gameState.status !== 'playing') return;

            room.gameState.status = 'ended';

            // Clean up intervals/timers
            if (room.gameState.speedInterval) {
                clearInterval(room.gameState.speedInterval);
                room.gameState.speedInterval = null;
            }
            if (room.gameState.gameTimer) {
                clearTimeout(room.gameState.gameTimer);
                room.gameState.gameTimer = null;
            }

            // Sort players by score
            const sorted = [...room.players].sort((a, b) => b.score - a.score);
            const winner = winnerId
                ? room.players.find(p => p.id === winnerId)
                : sorted[0];

            io.to(roomCode).emit('gameEnded', {
                winnerId: winner ? winner.id : null,
                winnerNickname: winner ? winner.nickname : null,
                players: sorted.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    score: p.score,
                    correctLetters: p.correctLetters
                }))
            });

            console.log(`[CADUTA LETTERE] Game ended in ${roomCode}. Winner: ${winner ? winner.nickname : 'none'}`);
        }

        // ──────────────────────────────────────────────
        //  NEW GAME (host only)
        // ──────────────────────────────────────────────
        socket.on('newGame', (configUpdate) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];
            if (!room || room.host !== socket.id) return;

            if (configUpdate) {
                if (configUpdate.gameMode) room.config.gameMode = configUpdate.gameMode;
                if (configUpdate.gameModeValue) room.config.gameModeValue = parseInt(configUpdate.gameModeValue);
            }

            room.gameState.status = 'lobby';
            startGame(roomCode);
        });

        // ──────────────────────────────────────────────
        //  LEAVE ROOM
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
            console.log(`[CADUTA LETTERE] Disconnect: ${socket.id}`);
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
                }, 60000);

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
                if (room.gameState.speedInterval) clearInterval(room.gameState.speedInterval);
                if (room.gameState.gameTimer) clearTimeout(room.gameState.gameTimer);
                delete rooms[roomCode];
                console.log(`[CADUTA LETTERE] Room ${roomCode} deleted — no players left`);
                return;
            }

            // Assign new host if needed
            if (playerId === room.host) {
                room.host = room.players[0].id;
                io.to(roomCode).emit('newHost', { hostId: room.host });
                console.log(`[CADUTA LETTERE] New host in ${roomCode}: ${room.host}`);
            }

            io.to(roomCode).emit('playerLeft', {
                playerId,
                players: room.players.map(p => ({
                    id: p.id, nickname: p.nickname, score: p.score,
                    correctLetters: p.correctLetters, disconnected: p.disconnected
                }))
            });
        }
    });
}

module.exports = initCadutaLettere;
