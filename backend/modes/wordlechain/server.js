// ────────────────────────────────────────────────────────────
//  Word Chain Battle – Server Logic
//  Socket.IO namespace: /wordlechain
// ────────────────────────────────────────────────────────────

const rooms = {};
const wordManager = require('./word_manager');

// ─── Helpers ─────────────────────────────────────────────────

function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

const VOWELS = new Set('AEIOU'.split(''));
const BANNED_PREFIXES_GLOBAL = ['IVY', 'ITY'];
const BANNED_PREFIXES_EN = ['NG', 'RS', 'CK', 'NS', 'KS', 'ERS', 'DS', 'OWS', 'BJ', 'BQ', 'BV', 'CJ', 'CV', 'DJ', 'DQ', 'FV', 'GJ', 'GV',
    'HJ', 'HQ', 'HV', 'JQ', 'JV', 'JX', 'JZ', 'KQ', 'KV', 'KX',
    'LX', 'LZ', 'MQ', 'MV', 'MX', 'MZ', 'PQ', 'PV', 'PX', 'PZ',
    'QG', 'QK', 'QZ', 'RQ', 'RV', 'RX', 'RZ', 'SJ', 'SQ', 'SV',
    'SX', 'TJ', 'TQ', 'TV', 'TX', 'VJ', 'VQ', 'VX', 'VZ', 'WQ',
    'WX', 'XJ', 'XZ', 'YQ', 'YV', 'YX', 'YZ', 'ZJ', 'ZQ', 'ZV',
    'QZX', 'QZK', 'XJZ', 'ZQX', 'ZXV', 'QKV', 'NT', 'WQX'];
const BANNED_PREFIXES_IT = ['NTE', 'NT'];

function isInvalidPrefix(seq, language = 'it') {
    if (seq.length < 2) return false;

    // Ban doppie identiche (AA, LL, SS, EE, …)
    if (seq[0] === seq[1]) return true;

    // Prefissi specificamente vietati
    const bannedPrefixes = [
        ...BANNED_PREFIXES_GLOBAL,
        ...(language === 'en' ? BANNED_PREFIXES_EN : BANNED_PREFIXES_IT)
    ];

    for (const banned of bannedPrefixes) {
        if (seq.startsWith(banned)) return true;
    }

    return false;
}

/**
 * After a valid word, pick 1–3 ending letters as the next prefix.
 * Probabilities: 50% → 1, 30% → 2, 20% → 3
 * Pure probability-based, no cache dependency.
 */
function generateNextPrefix(word, language = 'it') {
    const upper = word.toUpperCase();
    const roll = Math.random() * 100;
    let targetLen;
    if (roll < 50) targetLen = 1;
    else if (roll < 80) targetLen = 2;
    else targetLen = 3;

    // Clamp to word length
    targetLen = Math.min(targetLen, upper.length);

    // Try the target length first, then fall back to shorter
    for (let n = targetLen; n >= 1; n--) {
        const seq = upper.slice(-n);
        if (!isInvalidPrefix(seq, language)) {
            return seq;
        }
    }

    // Extreme fallback: last letter always
    return upper.slice(-1);
}

/**
 * Validate a word using the caching system and LanguageTool.
 * Rules (length >= 3, no accents, no proper nouns) are enforced in wordManager.
 */
async function isWordValid(word, language = 'it') {
    return await wordManager.processWord(word, language);
}

// ─── Main Module ─────────────────────────────────────────────

function initWordleChain(ioMain) {
    const io = ioMain.of('/wordlechain');
    console.log('[WORDLECHAIN] Module initialized on namespace /wordlechain');

    io.on('connection', (socket) => {
        console.log(`[WORDLECHAIN] New connection: ${socket.id}`);

        // ──────────────────────────────────────────────
        //  CREATE ROOM
        // ──────────────────────────────────────────────
        socket.on('createRoom', ({ nickname, language, avatar, timerRestriction, pointsMode, targetScore }) => {
            const roomCode = generateRoomCode();
            const isPoints = !!pointsMode;

            rooms[roomCode] = {
                code: roomCode,
                host: socket.id,
                language: language || 'it',
                timerRestriction: timerRestriction !== undefined ? timerRestriction : true,
                pointsMode: isPoints,
                targetScore: isPoints ? (targetScore || 300) : null,
                roundTimer: parseInt(arguments[0].roundTimer, 10) || 13,
                players: [{
                    id: socket.id,
                    nickname: nickname || 'Host',
                    avatar: avatar || '👤',
                    lives: 5,
                    score: 0,
                    triesLeft: 3,
                    alive: true
                }],
                spectators: [],
                gameState: {
                    status: 'lobby',
                    currentPlayerIndex: 0,
                    currentPrefix: '',
                    turnTimer: null,
                    turnDeadline: null,
                    letterPicker: null,
                    lastWord: null,
                    wordsPlayed: [],
                    cyclesCompleted: 0,
                    turnsInCurrentCycle: 0,
                    processingSubmission: false
                }
            };

            socket.join(roomCode);
            socket.roomId = roomCode;

            socket.emit('roomCreated', { roomCode, pointsMode: isPoints, targetScore: rooms[roomCode].targetScore, roundTimer: rooms[roomCode].roundTimer });
            console.log(`[WORDLECHAIN] Room created: ${roomCode} by ${nickname} [Timer: ${rooms[roomCode].roundTimer}s]`);
        });

        // ──────────────────────────────────────────────
        //  JOIN ROOM
        // ──────────────────────────────────────────────
        socket.on('joinRoom', ({ roomCode, nickname, avatar }) => {
            const room = rooms[roomCode];
            if (!room) return socket.emit('error', 'Room not found.');

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
                        oldId, newId: socket.id, nickname: existing.nickname,
                        players: sanitizePlayers(room)
                    });
                    socket.emit('reconnectState', getFullState(room, socket.id));
                    return;
                } else {
                    return socket.emit('error', 'Nickname already in use.');
                }
            }

            if (room.gameState.status !== 'lobby') {
                return socket.emit('error', 'Game already in progress.');
            }

            room.players.push({
                id: socket.id,
                nickname: nickname || `Player${room.players.length + 1}`,
                avatar: avatar || '👤',
                lives: 5,
                score: 0,
                triesLeft: 3,
                alive: true
            });

            socket.join(roomCode);
            socket.roomId = roomCode;

            const playerData = sanitizePlayers(room);
            io.to(roomCode).emit('playerJoined', { players: playerData, pointsMode: room.pointsMode, targetScore: room.targetScore, roundTimer: room.roundTimer });
            console.log(`[WORDLECHAIN] ${nickname} joined ${roomCode}`);
        });

        // ──────────────────────────────────────────────
        //  SET TARGET SCORE (host only, points mode)
        // ──────────────────────────────────────────────
        socket.on('setTargetScore', (newTarget) => {
            const room = getRoom(socket);
            if (!room || room.host !== socket.id || !room.pointsMode) return;
            const val = parseInt(newTarget, 10);
            if (isNaN(val) || val < 50) return socket.emit('error', 'Target must be at least 50.');
            room.targetScore = val;
            io.to(roomCode(socket)).emit('targetScoreUpdated', { targetScore: val });
            console.log(`[WORDLECHAIN] Target score updated to ${val} in ${roomCode(socket)}`);
        });

        // ──────────────────────────────────────────────
        //  SET ROUND TIMER (host only)
        // ──────────────────────────────────────────────
        socket.on('setRoundTimer', (newTimer) => {
            const room = getRoom(socket);
            if (!room || room.host !== socket.id) return;
            const val = parseInt(newTimer, 10);
            if (isNaN(val) || val < 5) return socket.emit('error', 'Timer must be at least 5s.');
            room.roundTimer = val;
            io.to(roomCode(socket)).emit('roundTimerUpdated', { roundTimer: val });
            console.log(`[WORDLECHAIN] Round timer updated to ${val}s in ${roomCode(socket)}`);
        });

        // ──────────────────────────────────────────────
        //  START GAME (host only)
        // ──────────────────────────────────────────────
        socket.on('startGame', () => {
            const room = getRoom(socket);
            if (!room || room.host !== socket.id) return;
            if (room.players.length < 2) {
                return socket.emit('error', 'Need at least 2 players to start.');
            }

            const pickerIndex = Math.floor(Math.random() * room.players.length);
            const picker = room.players[pickerIndex];
            room.gameState.status = 'pickLetter';
            room.gameState.letterPicker = picker.id;
            room.gameState.currentPlayerIndex = (pickerIndex + 1) % room.players.length;

            io.to(roomCode(socket)).emit('gameStarted', {
                players: sanitizePlayers(room),
                pickerNickname: picker.nickname,
                pickerId: picker.id,
                language: room.language,
                pointsMode: room.pointsMode,
                targetScore: room.targetScore,
                roundTimer: room.roundTimer
            });

            console.log(`[WORDLECHAIN] Game started in ${roomCode(socket)}. Picker: ${picker.nickname}`);
        });

        // ──────────────────────────────────────────────
        //  PICK STARTING LETTER
        // ──────────────────────────────────────────────
        socket.on('pickLetter', (letter) => {
            const room = getRoom(socket);
            if (!room || room.gameState.status !== 'pickLetter') return;
            if (room.gameState.letterPicker !== socket.id) return;

            const clean = (letter || '').toUpperCase().replace(/[^A-Z]/g, '');
            if (clean.length !== 1) return socket.emit('error', 'Pick a single letter A-Z.');

            room.gameState.currentPrefix = clean;
            room.gameState.status = 'playing';

            io.to(roomCode(socket)).emit('prefixSet', {
                prefix: clean,
                currentPlayer: getCurrentPlayer(room),
                players: sanitizePlayers(room)
            });

            startTurnTimer(room, io);
            console.log(`[WORDLECHAIN] Starting letter: ${clean} in ${roomCode(socket)}`);
        });

        // ──────────────────────────────────────────────
        //  SUBMIT WORD
        // ──────────────────────────────────────────────
        socket.on('submitWord', async (word) => {
            const room = getRoom(socket);
            if (!room || room.gameState.status !== 'playing') return;

            // Prevent multiple concurrent submissions (rapid Enter key bug)
            if (room.gameState.processingSubmission) return;

            const currentP = getAlivePlayerByIndex(room, room.gameState.currentPlayerIndex);
            if (!currentP || currentP.id !== socket.id) return;

            // Lock submissions while processing
            room.gameState.processingSubmission = true;

            const upper = (word || '').toUpperCase();
            const prefix = room.gameState.currentPrefix;

            // Check minimum length (handled by wordManager too, but good for UX)
            if (upper.length < 3) {
                io.to(roomCode(socket)).emit('wordResult', { valid: false, message: 'Word must be at least 3 letters.', playerId: currentP.id, playerNickname: currentP.nickname, players: sanitizePlayers(room) });
                room.gameState.processingSubmission = false;
                return;
            }

            // Check for accents or invalid chars (wordManager handles this, but we reject early)
            if (!/^[A-Z]+$/.test(upper)) {
                io.to(roomCode(socket)).emit('wordResult', { valid: false, message: 'La parola non deve avere accenti o simboli. / No accents or symbols.', playerId: currentP.id, playerNickname: currentP.nickname, players: sanitizePlayers(room) });
                room.gameState.processingSubmission = false;
                return;
            }

            // Check starts with prefix
            if (!upper.startsWith(prefix)) {
                io.to(roomCode(socket)).emit('wordResult', { valid: false, message: `Word must start with "${prefix}".`, playerId: currentP.id, playerNickname: currentP.nickname, players: sanitizePlayers(room) });
                room.gameState.processingSubmission = false;
                return;
            }

            // Reject if word is exactly the prefix
            if (upper === prefix) {
                io.to(roomCode(socket)).emit('wordResult', { valid: false, message: `Devi aggiungere almeno una lettera! / You must add at least one letter!`, playerId: currentP.id, playerNickname: currentP.nickname, players: sanitizePlayers(room) });
                room.gameState.processingSubmission = false;
                return;
            }

            // Check not already used
            if (room.gameState.wordsPlayed.includes(upper)) {
                io.to(roomCode(socket)).emit('wordResult', { valid: false, message: `"${upper}" - Parola già usata! / Word already used!`, playerId: currentP.id, playerNickname: currentP.nickname, players: sanitizePlayers(room) });
                room.gameState.processingSubmission = false;
                return;
            }

            // Validate with LanguageTool
            const valid = await isWordValid(upper, room.language);

            if (!valid) {
                // Decrement tries
                currentP.triesLeft = (currentP.triesLeft !== undefined ? currentP.triesLeft : 3) - 1;

                if (room.pointsMode) {
                    if (currentP.triesLeft === 1) {
                        // 2nd fail (triesLeft became 1) -> -10 pts, keeps turn
                        currentP.score = Math.max(0, currentP.score - 10);
                        io.to(roomCode(socket)).emit('wordResult', {
                            valid: false,
                            message: `"${upper}" non valida! -10 ⭐ (1 tentativo rimasto / 1 try left)`,
                            playerId: currentP.id,
                            playerNickname: currentP.nickname,
                            score: currentP.score,
                            lives: currentP.lives,
                            eliminated: false,
                            players: sanitizePlayers(room)
                        });
                    } else if (currentP.triesLeft <= 0) {
                        // 3rd fail (triesLeft became 0) -> -10 pts, ends turn
                        currentP.score = Math.max(0, currentP.score - 10);
                        io.to(roomCode(socket)).emit('wordResult', {
                            valid: false,
                            message: `"${upper}" non valida! -10 ⭐ (Turno perso / Turn lost)`,
                            playerId: currentP.id,
                            playerNickname: currentP.nickname,
                            score: currentP.score,
                            lives: currentP.lives,
                            eliminated: false,
                            players: sanitizePlayers(room)
                        });

                        clearTurnTimer(room);
                        room.gameState.status = 'pickingAfterTimeout';
                        room.gameState.letterPicker = currentP.id;

                        io.to(room.code).emit('awaitingLetterPick', {
                            pickerId: currentP.id,
                            pickerNickname: currentP.nickname,
                            language: room.language
                        });

                        room.gameState.turnTimer = setTimeout(() => {
                            if (room.gameState.status !== 'pickingAfterTimeout') return;
                            const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                            room.gameState.currentPrefix = randomVowel;
                            room.gameState.status = 'playing';

                            advanceToNextPlayer(room);

                            io.to(room.code).emit('prefixSet', {
                                prefix: randomVowel,
                                currentPlayer: getCurrentPlayer(room),
                                players: sanitizePlayers(room),
                                autoGenerated: true
                            });
                            if (!checkGameOver(room, io)) {
                                startTurnTimer(room, io);
                            }
                        }, 10000);
                    } else {
                        // 1st fail (triesLeft became 2) -> just warning
                        io.to(roomCode(socket)).emit('wordResult', {
                            valid: false,
                            message: `"${upper}" is not a valid word! (2 tentativi rimasti / 2 tries left)`,
                            playerId: currentP.id,
                            playerNickname: currentP.nickname,
                            lives: currentP.lives,
                            score: currentP.score,
                            eliminated: false,
                            players: sanitizePlayers(room)
                        });
                    }
                } else {
                    // Classic mode
                    if (currentP.triesLeft <= 1) { // 2nd fail!
                        currentP.lives--;
                        const eliminated = currentP.lives <= 0;
                        if (eliminated) currentP.alive = false;

                        io.to(roomCode(socket)).emit('wordResult', {
                            valid: false,
                            message: `"${upper}" non valida! -1 ❤️ (Turno perso / Turn lost)`,
                            playerId: currentP.id,
                            playerNickname: currentP.nickname,
                            lives: currentP.lives,
                            eliminated,
                            players: sanitizePlayers(room)
                        });

                        if (!checkGameOver(room, io)) {
                            clearTurnTimer(room);

                            if (eliminated) {
                                // If eliminated, they can't pick a letter. Next player gets random vowel.
                                advanceToNextPlayer(room);
                                const nextP = getCurrentPlayer(room);
                                if (nextP) {
                                    const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                                    room.gameState.currentPrefix = randomVowel;
                                    room.gameState.status = 'playing';

                                    io.to(room.code).emit('prefixSet', {
                                        prefix: randomVowel,
                                        currentPlayer: nextP,
                                        players: sanitizePlayers(room),
                                        autoGenerated: true
                                    });
                                    startTurnTimer(room, io);
                                }
                            } else {
                                // Not eliminated, player picks the letter for the next opponent
                                room.gameState.status = 'pickingAfterTimeout';
                                room.gameState.letterPicker = currentP.id;

                                io.to(room.code).emit('awaitingLetterPick', {
                                    pickerId: currentP.id,
                                    pickerNickname: currentP.nickname,
                                    language: room.language
                                });

                                room.gameState.turnTimer = setTimeout(() => {
                                    if (room.gameState.status !== 'pickingAfterTimeout') return;
                                    const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                                    room.gameState.currentPrefix = randomVowel;
                                    room.gameState.status = 'playing';

                                    advanceToNextPlayer(room);

                                    io.to(room.code).emit('prefixSet', {
                                        prefix: randomVowel,
                                        currentPlayer: getCurrentPlayer(room),
                                        players: sanitizePlayers(room),
                                        autoGenerated: true
                                    });
                                    if (!checkGameOver(room, io)) {
                                        startTurnTimer(room, io);
                                    }
                                }, 10000);
                            }
                        }
                    } else {
                        io.to(roomCode(socket)).emit('wordResult', {
                            valid: false,
                            message: `"${upper}" is not a valid word! (1 tentativo rimasto / 1 try left)`,
                            playerId: currentP.id,
                            playerNickname: currentP.nickname,
                            lives: currentP.lives,
                            score: currentP.score,
                            eliminated: false,
                            players: sanitizePlayers(room)
                        });
                    }
                }

                room.gameState.processingSubmission = false;
                return;
            }

            // Valid word!
            // Award points in points mode
            let pointsEarned = 0;
            if (room.pointsMode) {
                // 5 pts per letter (3 letters = 15 pts, 4 = 20, etc.)
                pointsEarned = upper.length * 5;
                currentP.score += pointsEarned;
            }
            currentP.triesLeft = 3;
            room.gameState.processingSubmission = false;
            clearTurnTimer(room);
            room.gameState.wordsPlayed.push(upper);
            room.gameState.lastWord = upper;

            const newPrefix = generateNextPrefix(upper, room.language);
            room.gameState.currentPrefix = newPrefix;

            advanceToNextPlayer(room);

            io.to(roomCode(socket)).emit('wordAccepted', {
                word: upper,
                playerId: currentP.id,
                playerNickname: currentP.nickname,
                pointsEarned,
                score: currentP.score,
                newPrefix,
                currentPlayer: getCurrentPlayer(room),
                players: sanitizePlayers(room)
            });

            if (checkGameOver(room, io)) return;

            startTurnTimer(room, io);
        });

        // ──────────────────────────────────────────────
        //  SKIP TURN
        // ──────────────────────────────────────────────
        socket.on('skipTurn', () => {
            const room = getRoom(socket);
            if (!room || room.gameState.status !== 'playing' || room.gameState.processingSubmission) return;

            const currentP = getAlivePlayerByIndex(room, room.gameState.currentPlayerIndex);
            if (!currentP || currentP.id !== socket.id) return;

            console.log(`[WORDLECHAIN] Player ${currentP.nickname} skipped turn in ${room.code}`);

            if (room.pointsMode) {
                currentP.score = Math.max(0, currentP.score - 10);
                io.to(room.code).emit('wordResult', {
                    valid: false,
                    message: `${currentP.nickname} ha saltato il turno! -10 ⭐`,
                    playerId: currentP.id,
                    playerNickname: currentP.nickname,
                    score: currentP.score,
                    lives: currentP.lives,
                    eliminated: false,
                    players: sanitizePlayers(room)
                });
            } else {
                currentP.lives--;
                const eliminated = currentP.lives <= 0;
                if (eliminated) currentP.alive = false;

                io.to(room.code).emit('wordResult', {
                    valid: false,
                    message: `${currentP.nickname} ha saltato il turno! -1 ❤️`,
                    playerId: currentP.id,
                    playerNickname: currentP.nickname,
                    lives: currentP.lives,
                    eliminated,
                    players: sanitizePlayers(room)
                });

                if (checkGameOver(room, io)) return;
            }

            clearTurnTimer(room);

            // Trigger letter picking
            room.gameState.status = 'pickingAfterTimeout';
            room.gameState.letterPicker = currentP.id;

            io.to(room.code).emit('awaitingLetterPick', {
                pickerId: currentP.id,
                pickerNickname: currentP.nickname,
                language: room.language,
                skipped: true
            });

            room.gameState.turnTimer = setTimeout(() => {
                if (room.gameState.status !== 'pickingAfterTimeout') return;
                const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                room.gameState.currentPrefix = randomVowel;
                room.gameState.status = 'playing';

                advanceToNextPlayer(room);

                io.to(room.code).emit('prefixSet', {
                    prefix: randomVowel,
                    currentPlayer: getCurrentPlayer(room),
                    players: sanitizePlayers(room),
                    autoGenerated: true
                });
                if (!checkGameOver(room, io)) {
                    startTurnTimer(room, io);
                }
            }, 10000);
        });

        // ──────────────────────────────────────────────
        //  LIVE TYPING (broadcast to all)
        // ──────────────────────────────────────────────
        socket.on('typing', (text) => {
            const room = getRoom(socket);
            if (!room) return;
            socket.to(roomCode(socket)).emit('playerTyping', {
                playerId: socket.id,
                text: text || ''
            });
        });

        // ──────────────────────────────────────────────
        //  SPECTATOR REACTION
        // ──────────────────────────────────────────────
        socket.on('reaction', (emoji) => {
            const room = getRoom(socket);
            if (!room) return;
            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;
            io.to(roomCode(socket)).emit('playerReaction', {
                playerId: socket.id,
                nickname: player.nickname,
                emoji: emoji || '👏'
            });
        });

        // ──────────────────────────────────────────────
        //  PICK LETTER AFTER TIMEOUT
        // ──────────────────────────────────────────────
        socket.on('pickLetterAfterTimeout', (letter) => {
            const room = getRoom(socket);
            if (!room || room.gameState.status !== 'pickingAfterTimeout') return;
            if (room.gameState.letterPicker !== socket.id) return;

            const clean = (letter || '').toUpperCase().replace(/[^A-Z]/g, '');
            if (clean.length !== 1) return socket.emit('error', 'Pick a single letter A-Z.');

            room.gameState.currentPrefix = clean;
            room.gameState.status = 'playing';

            // Advance to next alive player
            advanceToNextPlayer(room);

            io.to(roomCode(socket)).emit('prefixSet', {
                prefix: clean,
                currentPlayer: getCurrentPlayer(room),
                players: sanitizePlayers(room)
            });

            if (!checkGameOver(room, io)) {
                startTurnTimer(room, io);
            }
        });

        // ──────────────────────────────────────────────
        //  RESTART GAME (host only)
        // ──────────────────────────────────────────────
        socket.on('restartGame', () => {
            const room = getRoom(socket);
            if (!room || room.host !== socket.id) return;

            clearTurnTimer(room);

            // Reset all players
            room.players.forEach(p => {
                p.lives = 5;
                p.score = 0;
                p.triesLeft = 3;
                p.alive = true;
            });

            room.gameState = {
                status: 'lobby',
                currentPlayerIndex: 0,
                currentPrefix: '',
                turnTimer: null,
                turnDeadline: null,
                letterPicker: null,
                lastWord: null,
                wordsPlayed: [],
                cyclesCompleted: 0,
                turnsInCurrentCycle: 0,
                processingSubmission: false
            };

            io.to(roomCode(socket)).emit('gameRestarted', {
                players: sanitizePlayers(room),
                pointsMode: room.pointsMode,
                targetScore: room.targetScore,
                roundTimer: room.roundTimer
            });
        });

        // ──────────────────────────────────────────────
        //  LEAVE / DISCONNECT
        // ──────────────────────────────────────────────
        socket.on('leaveRoom', () => {
            handleLeave(socket.id, socket.roomId, io);
            socket.roomId = null;
        });

        socket.on('disconnect', () => {
            console.log(`[WORDLECHAIN] Disconnect: ${socket.id}`);
            const rc = socket.roomId;
            if (!rc || !rooms[rc]) return;
            const room = rooms[rc];
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.disconnected = true;
                player.disconnectTimeout = setTimeout(() => {
                    if (rooms[rc]) handleLeave(socket.id, rc, io);
                }, 60000);

                io.to(rc).emit('playerDisconnected', {
                    playerId: socket.id,
                    nickname: player.nickname,
                    players: sanitizePlayers(room)
                });

                if (room.gameState.status === 'playing') {
                    const currentP = getCurrentPlayer(room);
                    if (currentP && currentP.id === socket.id) {
                        clearTurnTimer(room);
                        io.to(rc).emit('error', `${player.nickname} disconnected, turn skipped.`);
                        advanceToNextPlayer(room);

                        if (!checkGameOver(room, io)) {
                            io.to(rc).emit('prefixSet', {
                                prefix: room.gameState.currentPrefix,
                                currentPlayer: getCurrentPlayer(room),
                                players: sanitizePlayers(room)
                            });
                            startTurnTimer(room, io);
                        }
                    }
                } else if (room.gameState.status === 'pickLetter' || room.gameState.status === 'pickingAfterTimeout') {
                    if (room.gameState.letterPicker === socket.id) {
                        clearTurnTimer(room);
                        const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                        room.gameState.currentPrefix = randomVowel;
                        room.gameState.status = 'playing';

                        io.to(rc).emit('error', `${player.nickname} disconnected, auto-picking letter.`);

                        if (room.gameState.status === 'pickingAfterTimeout') {
                            advanceToNextPlayer(room);
                        }

                        if (!checkGameOver(room, io)) {
                            io.to(rc).emit('prefixSet', {
                                prefix: randomVowel,
                                currentPlayer: getCurrentPlayer(room),
                                players: sanitizePlayers(room),
                                autoGenerated: true
                            });
                            startTurnTimer(room, io);
                        }
                    }
                }
            }
        });
    });

    // ─── Internal Helpers ────────────────────────────────────

    function getRoom(socket) {
        return rooms[socket.roomId] || null;
    }

    function roomCode(socket) {
        return socket.roomId;
    }

    function sanitizePlayers(room) {
        let list = room.players.map(p => ({
            id: p.id,
            nickname: p.nickname,
            avatar: p.avatar || '👤',
            lives: p.lives,
            score: p.score || 0,
            alive: p.alive,
            disconnected: p.disconnected || false
        }));
        // Sort by score descending in points mode
        if (room.pointsMode) {
            list = list.sort((a, b) => b.score - a.score);
        }
        return list;
    }

    function getFullState(room, socketId) {
        return {
            roomCode: room.code,
            isHost: room.host === socketId,
            language: room.language,
            pointsMode: room.pointsMode,
            targetScore: room.targetScore,
            roundTimer: room.roundTimer,
            gameState: {
                status: room.gameState.status,
                currentPrefix: room.gameState.currentPrefix,
                currentPlayer: getCurrentPlayer(room),
                wordsPlayed: room.gameState.wordsPlayed,
                lastWord: room.gameState.lastWord
            },
            players: sanitizePlayers(room)
        };
    }

    function getCurrentPlayer(room) {
        const alivePlayers = room.players.filter(p => p.alive);
        if (alivePlayers.length === 0) return null;
        const idx = room.gameState.currentPlayerIndex % alivePlayers.length;
        const p = alivePlayers[idx];
        return { id: p.id, nickname: p.nickname };
    }

    function getAlivePlayerByIndex(room, index) {
        const alivePlayers = room.players.filter(p => p.alive);
        if (alivePlayers.length === 0) return null;
        return alivePlayers[index % alivePlayers.length];
    }

    function advanceToNextPlayer(room) {
        room.gameState.turnsInCurrentCycle = (room.gameState.turnsInCurrentCycle || 0) + 1;
        const alivePlayers = room.players.filter(p => p.alive);

        if (room.gameState.turnsInCurrentCycle >= alivePlayers.length) {
            room.gameState.cyclesCompleted = (room.gameState.cyclesCompleted || 0) + 1;
            room.gameState.turnsInCurrentCycle = 0;
        }

        if (alivePlayers.length <= 1) return;

        let attempts = 0;
        do {
            room.gameState.currentPlayerIndex = (room.gameState.currentPlayerIndex + 1) % alivePlayers.length;
            attempts++;
        } while (alivePlayers[room.gameState.currentPlayerIndex].disconnected && attempts < alivePlayers.length);
    }

    function startTurnTimer(room, io) {
        clearTurnTimer(room);
        const cycles = room.gameState.cyclesCompleted || 0;
        let TURN_SECONDS = room.roundTimer || 13;

        if (room.timerRestriction && cycles >= 20) {
            TURN_SECONDS = Math.max(7, (room.roundTimer || 13) - (cycles - 19));
        }

        room.gameState.turnDeadline = Date.now() + TURN_SECONDS * 1000;

        // Reset tries for the incoming player
        const currentP = getAlivePlayerByIndex(room, room.gameState.currentPlayerIndex);
        if (currentP) {
            currentP.triesLeft = 3;
        }

        io.to(room.code).emit('turnStarted', {
            currentPlayer: getCurrentPlayer(room),
            prefix: room.gameState.currentPrefix,
            deadline: room.gameState.turnDeadline,
            seconds: TURN_SECONDS
        });

        room.gameState.turnTimer = setTimeout(() => {
            handleTimeout(room, io);
        }, TURN_SECONDS * 1000);
    }

    function clearTurnTimer(room) {
        if (room.gameState.turnTimer) {
            clearTimeout(room.gameState.turnTimer);
            room.gameState.turnTimer = null;
        }
    }

    function handleTimeout(room, io) {
        const currentP = getAlivePlayerByIndex(room, room.gameState.currentPlayerIndex);
        if (!currentP) return;

        if (room.pointsMode) {
            // Points mode: -10 points (floor at 0)
            currentP.score = Math.max(0, currentP.score - 10);

            io.to(room.code).emit('turnTimeout', {
                playerId: currentP.id,
                playerNickname: currentP.nickname,
                score: currentP.score,
                lives: currentP.lives,
                eliminated: false,
                players: sanitizePlayers(room)
            });

            if (checkGameOver(room, io)) return;

            // In points mode, player picks letter for next opponent
            room.gameState.status = 'pickingAfterTimeout';
            room.gameState.letterPicker = currentP.id;

            io.to(room.code).emit('awaitingLetterPick', {
                pickerId: currentP.id,
                pickerNickname: currentP.nickname,
                language: room.language
            });

            room.gameState.turnTimer = setTimeout(() => {
                if (room.gameState.status !== 'pickingAfterTimeout') return;
                const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                room.gameState.currentPrefix = randomVowel;
                room.gameState.status = 'playing';

                advanceToNextPlayer(room);

                io.to(room.code).emit('prefixSet', {
                    prefix: randomVowel,
                    currentPlayer: getCurrentPlayer(room),
                    players: sanitizePlayers(room),
                    autoGenerated: true
                });
                if (!checkGameOver(room, io)) {
                    startTurnTimer(room, io);
                }
            }, 10000);
        } else {
            // Classic mode: -1 life
            currentP.lives--;
            const eliminated = currentP.lives <= 0;
            if (eliminated) currentP.alive = false;

            io.to(room.code).emit('turnTimeout', {
                playerId: currentP.id,
                playerNickname: currentP.nickname,
                lives: currentP.lives,
                eliminated,
                players: sanitizePlayers(room)
            });

            if (checkGameOver(room, io)) return;

            if (eliminated) {
                advanceToNextPlayer(room);
                const nextP = getCurrentPlayer(room);
                if (!nextP) return;
                const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                room.gameState.currentPrefix = randomVowel;
                room.gameState.status = 'playing';

                io.to(room.code).emit('prefixSet', {
                    prefix: randomVowel,
                    currentPlayer: nextP,
                    players: sanitizePlayers(room),
                    autoGenerated: true
                });
                startTurnTimer(room, io);
            } else {
                room.gameState.status = 'pickingAfterTimeout';
                room.gameState.letterPicker = currentP.id;

                io.to(room.code).emit('awaitingLetterPick', {
                    pickerId: currentP.id,
                    pickerNickname: currentP.nickname,
                    language: room.language
                });

                room.gameState.turnTimer = setTimeout(() => {
                    if (room.gameState.status !== 'pickingAfterTimeout') return;
                    const randomVowel = 'AEIOU'[Math.floor(Math.random() * 5)];
                    room.gameState.currentPrefix = randomVowel;
                    room.gameState.status = 'playing';

                    advanceToNextPlayer(room);

                    io.to(room.code).emit('prefixSet', {
                        prefix: randomVowel,
                        currentPlayer: getCurrentPlayer(room),
                        players: sanitizePlayers(room),
                        autoGenerated: true
                    });
                    if (!checkGameOver(room, io)) {
                        startTurnTimer(room, io);
                    }
                }, 10000);
            }
        }
    }

    function checkGameOver(room, io) {
        if (room.pointsMode) {
            // Points mode: check if any player reached target score
            const winner = room.players.find(p => p.score >= room.targetScore);
            if (winner) {
                clearTurnTimer(room);
                room.gameState.status = 'ended';

                io.to(room.code).emit('gameOver', {
                    winnerId: winner.id,
                    winnerNickname: winner.nickname,
                    winnerScore: winner.score,
                    targetScore: room.targetScore,
                    pointsMode: true,
                    players: sanitizePlayers(room)
                });

                console.log(`[WORDLECHAIN] Game over in ${room.code}. Winner: ${winner.nickname} with ${winner.score} pts`);
                return true;
            }
            return false;
        } else {
            // Classic mode: last alive wins
            const alive = room.players.filter(p => p.alive);
            if (alive.length <= 1) {
                clearTurnTimer(room);
                room.gameState.status = 'ended';
                const winner = alive[0] || null;

                io.to(room.code).emit('gameOver', {
                    winnerId: winner ? winner.id : null,
                    winnerNickname: winner ? winner.nickname : null,
                    pointsMode: false,
                    players: sanitizePlayers(room)
                });

                console.log(`[WORDLECHAIN] Game over in ${room.code}. Winner: ${winner ? winner.nickname : 'none'}`);
                return true;
            }
            return false;
        }
    }

    function handleLeave(playerId, rc, io) {
        if (!rc || !rooms[rc]) return;
        const room = rooms[rc];

        room.players = room.players.filter(p => p.id !== playerId);

        if (room.players.length === 0) {
            clearTurnTimer(room);
            delete rooms[rc];
            console.log(`[WORDLECHAIN] Room ${rc} deleted — no players left`);
            return;
        }

        // Reassign host
        if (playerId === room.host) {
            room.host = room.players[0].id;
            io.to(rc).emit('newHost', {
                hostId: room.host,
                hostNickname: room.players[0].nickname
            });
        }

        // If game is in progress, check if we need to adjust turn
        if (room.gameState.status === 'playing' || room.gameState.status === 'pickingAfterTimeout') {
            const alive = room.players.filter(p => p.alive);
            if (alive.length <= 1) {
                checkGameOver(room, io);
                return;
            }
            // Fix currentPlayerIndex
            room.gameState.currentPlayerIndex = room.gameState.currentPlayerIndex % alive.length;
        }

        io.to(rc).emit('playerLeft', {
            playerId,
            players: sanitizePlayers(room)
        });
    }
}

module.exports = initWordleChain;
