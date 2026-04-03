const { getRandomWord } = require('./words');

// Rooms storage
const rooms = {};

// Generate unique room code
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

// Select secret word based on room configuration (classic mode only)
function selectSecretWord(wordLength, language) {
    const word = getRandomWord(wordLength, language || 'it');
    console.log(`[IMPICCATO] Selected word (length ${wordLength}, lang ${language || 'it'}): ${word}`);
    return word;
}

// Return a flat 50 points for winning the round, regardless of word length.
function calculateScore() {
    return 50;
}

function initImpiccato(ioMain) {
    const io = ioMain.of('/impiccato');

    console.log("[IMPICCATO] Module initialized on namespace /impiccato");

    io.on('connection', (socket) => {
        console.log(`[IMPICCATO] New connection: ${socket.id}`);

        // Create Room
        socket.on('createRoom', ({ nickname, wordLength, language, gameMode }) => {
            const roomCode = generateRoomCode();
            const mode = gameMode || 'classic'; // 'classic' or 'playerWord'

            rooms[roomCode] = {
                code: roomCode,
                host: socket.id,
                players: [{
                    id: socket.id,
                    nickname: nickname || 'Host',
                    score: 0
                }],
                config: {
                    wordLength: wordLength || 5,
                    language: language || 'it',
                    gameMode: mode
                },
                gameState: {
                    status: 'lobby', // lobby, choosingWord, playing, ended
                    secretWord: null,
                    hint: '',
                    wordCreatorId: null,
                    wordCreatorNickname: null,
                    creatorIndex: -1,
                    revealedLetters: {},
                    guessedLetters: [],
                    turnIndex: 0,
                    currentPlayerId: null,
                    timer: null,
                    timeLeft: 30,
                    roundId: 0
                }
            };

            socket.join(roomCode);
            socket.roomId = roomCode;

            socket.emit('roomCreated', { roomCode, wordLength, gameMode: mode });
            console.log(`[IMPICCATO] Room created: ${roomCode} by ${nickname} (mode: ${mode})`);
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

                    if (room.gameState.currentPlayerId === oldId) {
                        room.gameState.currentPlayerId = socket.id;
                    }

                    if (room.gameState.wordCreatorId === oldId) {
                        room.gameState.wordCreatorId = socket.id;
                    }

                    socket.join(roomCode);
                    socket.roomId = roomCode;

                    console.log(`[IMPICCATO] ${nickname} reconnected to ${roomCode}`);

                    io.to(roomCode).emit('playerReconnected', {
                        oldId,
                        newId: socket.id,
                        nickname: existingPlayer.nickname,
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                    });

                    const gsForClient = { ...room.gameState, timer: null };
                    // In playerWord mode, don't leak the secret word to non-creators
                    if (room.config.gameMode === 'playerWord' && room.gameState.wordCreatorId !== socket.id) {
                        gsForClient.secretWord = null;
                    }

                    socket.emit('reconnectSuccess', {
                        roomCode,
                        config: room.config,
                        isHost: room.host === socket.id,
                        gameState: gsForClient,
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
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
                disconnected: false
            };

            room.players.push(newPlayer);
            socket.join(roomCode);
            socket.roomId = roomCode;

            console.log(`[IMPICCATO] ${nickname} joined ${roomCode}`);

            if (room.gameState.status === 'playing' || room.gameState.status === 'choosingWord') {
                const gsForClient = { ...room.gameState, timer: null };
                if (room.config.gameMode === 'playerWord') {
                    gsForClient.secretWord = null;
                }
                socket.emit('reconnectSuccess', {
                    roomCode,
                    config: room.config,
                    isHost: false,
                    gameState: gsForClient,
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                });
            } else {
                socket.emit('playerJoined', {
                    roomCode: roomCode,
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
                });
            }

            socket.to(roomCode).emit('playerJoined', {
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected }))
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

            // Clean up existing timer
            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
            }

            const activePlayers = room.players
                .map((p, i) => ({ ...p, index: i }))
                .filter(p => !p.disconnected);

            if (room.config.gameMode === 'playerWord') {
                // =========================================
                // PLAYER-WORD MODE: select a word creator
                // =========================================
                if (activePlayers.length < 2) {
                    io.to(roomCode).emit('error', 'Servono almeno 2 giocatori per questa modalità');
                    return;
                }

                let creatorIdx;
                if (room.gameState.creatorIndex === -1) {
                    const pick = activePlayers[Math.floor(Math.random() * activePlayers.length)];
                    creatorIdx = pick.index;
                } else {
                    const totalPlayers = room.players.length;
                    let nextIdx = (room.gameState.creatorIndex + 1) % totalPlayers;
                    let attempts = 0;
                    while (room.players[nextIdx].disconnected && attempts < totalPlayers) {
                        nextIdx = (nextIdx + 1) % totalPlayers;
                        attempts++;
                    }
                    creatorIdx = nextIdx;
                }

                const creator = room.players[creatorIdx];
                room.gameState.creatorIndex = creatorIdx;
                room.gameState.wordCreatorId = creator.id;
                room.gameState.wordCreatorNickname = creator.nickname;
                room.gameState.status = 'choosingWord';
                room.gameState.secretWord = null;
                room.gameState.hint = '';
                room.gameState.revealedLetters = {};
                room.gameState.guessedLetters = [];
                room.gameState.roundId = (room.gameState.roundId || 0) + 1;

                console.log(`[IMPICCATO] Round ${room.gameState.roundId} (playerWord): ${creator.nickname} is choosing the word`);

                io.to(roomCode).emit('wordChooserSelected', {
                    chooserId: creator.id,
                    chooserNickname: creator.nickname,
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
                });

            } else {
                // =========================================
                // CLASSIC MODE: system picks the word
                // =========================================
                const secretWord = selectSecretWord(room.config.wordLength, room.config.language);

                if (!secretWord) {
                    io.to(roomCode).emit('error', 'Impossibile trovare una parola');
                    return;
                }

                room.gameState.status = 'playing';
                room.gameState.secretWord = secretWord;
                room.gameState.revealedLetters = {};
                room.gameState.guessedLetters = [];
                room.gameState.wordCreatorId = null;
                room.gameState.wordCreatorNickname = null;
                room.gameState.hint = '';
                room.gameState.roundId = (room.gameState.roundId || 0) + 1;

                const pick = activePlayers[Math.floor(Math.random() * activePlayers.length)];
                room.gameState.turnIndex = pick.index;
                room.gameState.currentPlayerId = pick.id;
                room.gameState.timeLeft = 30;

                console.log(`[IMPICCATO] Round ${room.gameState.roundId} (classic) started. Word: ${secretWord}. First turn: ${pick.nickname}`);

                io.to(roomCode).emit('gameStarted', {
                    wordLength: room.config.wordLength,
                    language: room.config.language || 'it',
                    gameMode: 'classic',
                    hint: '',
                    wordCreatorId: null,
                    wordCreatorNickname: null,
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
                });

                notifyTurn(room);
            }
        }

        // Creator submits secret word + hint (playerWord mode only)
        socket.on('submitSecretWord', ({ word, hint }) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];

            if (!room || room.gameState.status !== 'choosingWord') return;
            if (room.config.gameMode !== 'playerWord') return;
            if (room.gameState.wordCreatorId !== socket.id) {
                return socket.emit('error', 'Non sei il creatore della parola!');
            }

            const cleanWord = (word || '').trim().toUpperCase();
            if (cleanWord.length < 4 || cleanWord.length > 10) {
                return socket.emit('error', 'La parola deve essere lunga da 4 a 10 lettere!');
            }
            if (!/^[A-ZÀÈÉÌÍÒÓÙÚ]+$/i.test(cleanWord)) {
                return socket.emit('error', 'La parola può contenere solo lettere!');
            }

            const cleanHint = (hint || '').trim();

            room.gameState.secretWord = cleanWord;
            room.gameState.hint = cleanHint;
            room.gameState.status = 'playing';
            room.gameState.timeLeft = 30;

            // Pick first turn among active NON-creator players
            const activePlayers = room.players
                .map((p, i) => ({ ...p, index: i }))
                .filter(p => !p.disconnected && p.id !== room.gameState.wordCreatorId);

            if (activePlayers.length === 0) {
                io.to(roomCode).emit('error', 'Non ci sono giocatori disponibili per giocare');
                return;
            }

            const firstPlayer = activePlayers[0];
            room.gameState.turnIndex = firstPlayer.index;
            room.gameState.currentPlayerId = firstPlayer.id;

            console.log(`[IMPICCATO] Word set: ${cleanWord} (hint: ${cleanHint}). First turn: ${firstPlayer.nickname}`);

            io.to(roomCode).emit('gameStarted', {
                wordLength: cleanWord.length,
                language: room.config.language || 'it',
                gameMode: 'playerWord',
                hint: cleanHint,
                wordCreatorId: room.gameState.wordCreatorId,
                wordCreatorNickname: room.gameState.wordCreatorNickname,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
            });

            notifyTurn(room);
        });

        // Creator updates hint in real-time (playerWord mode only)
        socket.on('updateHint', (newHint) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];

            if (!room || room.gameState.status !== 'playing') return;
            if (room.config.gameMode !== 'playerWord') return;
            if (room.gameState.wordCreatorId !== socket.id) return;

            room.gameState.hint = (newHint || '').trim();
            console.log(`[IMPICCATO] Hint updated: ${room.gameState.hint}`);

            io.to(roomCode).emit('hintUpdated', { hint: room.gameState.hint });
        });

        // Creator reveals a helper letter (playerWord mode only)
        socket.on('revealHelperLetter', (position) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];

            if (!room || room.gameState.status !== 'playing') return;
            if (room.config.gameMode !== 'playerWord') return;
            if (room.gameState.wordCreatorId !== socket.id) return;

            const secretWord = room.gameState.secretWord;
            const pos = parseInt(position);

            if (isNaN(pos) || pos < 0 || pos >= secretWord.length) return;
            if (room.gameState.revealedLetters[pos]) return;

            const letter = secretWord[pos];
            room.gameState.revealedLetters[pos] = letter;

            // Reveal all occurrences of this letter
            const positions = [];
            for (let i = 0; i < secretWord.length; i++) {
                if (secretWord[i] === letter && !room.gameState.revealedLetters[i]) {
                    room.gameState.revealedLetters[i] = letter;
                }
                if (secretWord[i] === letter) {
                    positions.push(i);
                }
            }

            console.log(`[IMPICCATO] Creator revealed helper letter ${letter} at positions ${positions}`);

            io.to(roomCode).emit('helperLetterRevealed', {
                letter: letter,
                positions: positions,
                revealedLetters: room.gameState.revealedLetters
            });

            // Check if word is complete
            if (Object.keys(room.gameState.revealedLetters).length === secretWord.length) {
                console.log(`[IMPICCATO] Word completed via helper letters`);
                room.gameState.status = 'ended';
                if (room.gameState.timer) {
                    clearInterval(room.gameState.timer);
                    room.gameState.timer = null;
                }
                io.to(room.code).emit('roundEnded', {
                    winnerId: null,
                    winnerNickname: 'Nessuno',
                    winnerScore: 0,
                    secretWord: room.gameState.secretWord,
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
                });
            }
        });

        function notifyTurn(room) {
            if (!room || !room.players || room.players.length === 0) {
                console.log(`[IMPICCATO] Cannot notify turn - invalid room state`);
                return;
            }

            const currentPlayerId = room.gameState.currentPlayerId;
            if (!currentPlayerId) {
                console.log(`[IMPICCATO] Cannot notify turn - no current player ID`);
                return;
            }

            const currentPlayer = room.players.find(p => p.id === currentPlayerId);
            io.to(room.code).emit('turnUpdate', {
                playerId: currentPlayerId,
                playerNickname: currentPlayer ? currentPlayer.nickname : 'Avversario',
                timeLeft: 30
            });

            // Clean up existing timer
            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
            }

            let seconds = 30;
            const roomCode = room.code;
            const activeRoundId = room.gameState.roundId;
            const timerId = setInterval(() => {
                if (!rooms[roomCode]) {
                    clearInterval(timerId);
                    return;
                }

                const currentRoom = rooms[roomCode];
                if (currentRoom.gameState.roundId !== activeRoundId || currentRoom.gameState.timer !== timerId) {
                    clearInterval(timerId);
                    return;
                }

                seconds--;
                currentRoom.gameState.timeLeft = seconds;
                io.to(roomCode).emit('timerTick', { timeLeft: seconds });

                if (seconds <= 0) {
                    clearInterval(timerId);
                    currentRoom.gameState.timer = null;
                    console.log(`[IMPICCATO] Timer expired in ${roomCode} (round ${activeRoundId}), passing turn`);
                    handlePassTurn(currentRoom);
                }
            }, 1000);
            room.gameState.timer = timerId;
        }

        function handlePassTurn(room) {
            if (!room || !room.gameState) return;

            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
            }

            if (room.gameState.status !== 'playing') return;
            if (!room.players || room.players.length === 0) return;

            const totalPlayers = room.players.length;
            const isPlayerWordMode = room.config.gameMode === 'playerWord';
            let attempts = 0;

            do {
                room.gameState.turnIndex = (room.gameState.turnIndex + 1) % totalPlayers;
                attempts++;
            } while (
                (room.players[room.gameState.turnIndex].disconnected ||
                    (isPlayerWordMode && room.players[room.gameState.turnIndex].id === room.gameState.wordCreatorId)) &&
                attempts < totalPlayers
            );

            const nextPlayer = room.players[room.gameState.turnIndex];
            if (nextPlayer.disconnected || (isPlayerWordMode && nextPlayer.id === room.gameState.wordCreatorId)) {
                console.log(`[IMPICCATO] No eligible players for turn in ${room.code}`);
                return;
            }

            room.gameState.currentPlayerId = nextPlayer.id;
            console.log(`[IMPICCATO] Turn passed to ${nextPlayer.nickname}`);
            notifyTurn(room);
        }

        // Submit Letter
        socket.on('submitLetter', (letter) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];

            if (!room || room.gameState.status !== 'playing') return;

            const isPlayerWordMode = room.config.gameMode === 'playerWord';

            // Creator cannot submit letters in playerWord mode
            if (isPlayerWordMode && room.gameState.wordCreatorId === socket.id) {
                return socket.emit('error', 'Il creatore della parola non può inserire lettere!');
            }

            // Validate turn
            if (room.gameState.currentPlayerId !== socket.id) {
                return socket.emit('error', 'Non è il tuo turno!');
            }

            const upperLetter = letter.toUpperCase();

            // Check if already revealed
            const isRevealed = Object.values(room.gameState.revealedLetters).includes(upperLetter);
            if (isRevealed) {
                return socket.emit('letterResult', {
                    success: false,
                    message: 'Lettera già trovata!',
                    private: true
                });
            }

            if (!room.gameState.guessedLetters.includes(upperLetter)) {
                room.gameState.guessedLetters.push(upperLetter);
            }

            const secretWord = room.gameState.secretWord;
            const positions = [];

            for (let i = 0; i < secretWord.length; i++) {
                if (secretWord[i] === upperLetter) {
                    positions.push(i);
                    room.gameState.revealedLetters[i] = upperLetter;
                }
            }

            if (positions.length > 0) {
                // CORRECT
                const guesser = room.players.find(p => p.id === socket.id);
                const pointsForLetter = positions.length * 10;
                if (guesser) guesser.score += pointsForLetter;

                io.to(roomCode).emit('letterResult', {
                    success: true,
                    letter: upperLetter,
                    positions: positions,
                    revealedLetters: room.gameState.revealedLetters,
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
                });

                if (Object.keys(room.gameState.revealedLetters).length === secretWord.length) {
                    handleWin(room, socket.id);
                } else {
                    // Both modes: correct letter → same player keeps turn, restart timer
                    if (room.gameState.timer) {
                        clearInterval(room.gameState.timer);
                        room.gameState.timer = null;
                    }
                    notifyTurn(room);
                }
            } else {
                // INCORRECT
                socket.emit('letterResult', {
                    success: false,
                    letter: upperLetter,
                    message: 'Lettera assente nella parola',
                    private: true
                });

                socket.to(roomCode).emit('opponentGuessed', {
                    playerId: socket.id,
                    wasCorrect: false
                });

                // Both modes: wrong letter → pass turn
                handlePassTurn(room);
            }
        });

        function handleWin(room, winnerId) {
            if (room.gameState.timer) {
                clearInterval(room.gameState.timer);
                room.gameState.timer = null;
            }

            room.gameState.status = 'ended';

            const winner = room.players.find(p => p.id === winnerId);
            const pointsEarned = calculateScore();
            if (winner) winner.score += pointsEarned;

            io.to(room.code).emit('roundEnded', {
                winnerId,
                winnerNickname: winner ? winner.nickname : 'Unknown',
                winnerScore: pointsEarned,
                secretWord: room.gameState.secretWord,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
            });

            console.log(`[IMPICCATO] Round ended in ${room.code}. Winner: ${winnerId}, Points: ${pointsEarned}`);
        }

        // Next Round / Rematch
        socket.on('nextRound', (configUpdate) => {
            const roomCode = socket.roomId;
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;

            if (configUpdate && configUpdate.wordLength) {
                room.config.wordLength = configUpdate.wordLength;
            }
            if (configUpdate && configUpdate.language) {
                room.config.language = configUpdate.language;
            }

            startRound(roomCode);
        });

        // Disconnect
        socket.on('disconnect', () => {
            console.log(`[IMPICCATO] Disconnect: ${socket.id}`);

            if (socket.roomId && rooms[socket.roomId]) {
                const room = rooms[socket.roomId];
                const player = room.players.find(p => p.id === socket.id);

                if (player) {
                    player.disconnected = true;
                    player.disconnectTimeout = setTimeout(() => {
                        if (rooms[socket.roomId]) {
                            handleLeave(socket.id, socket.roomId);
                        }
                    }, 60000);

                    io.to(socket.roomId).emit('playerDisconnected', {
                        playerId: socket.id,
                        nickname: player.nickname
                    });

                    // If creator disconnects during choosingWord, restart round
                    if (room.config.gameMode === 'playerWord' &&
                        room.gameState.status === 'choosingWord' &&
                        room.gameState.wordCreatorId === socket.id) {
                        console.log(`[IMPICCATO] Creator ${player.nickname} disconnected during word choice, restarting round`);
                        startRound(room.code);
                        return;
                    }

                    // If it's their turn, pass immediately
                    if (room.gameState && room.gameState.status === 'playing' && room.gameState.currentPlayerId === socket.id) {
                        console.log(`[IMPICCATO] ${player.nickname} disconnected during their turn, passing turn...`);
                        handlePassTurn(room);
                    }
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

            if (room.gameState && room.gameState.currentPlayerId === playerId) {
                if (room.gameState.timer) {
                    clearInterval(room.gameState.timer);
                    room.gameState.timer = null;
                }
            }

            room.players = room.players.filter(p => p.id !== playerId);

            // Recalculate indices
            if (room.gameState && room.gameState.currentPlayerId) {
                const newIdx = room.players.findIndex(p => p.id === room.gameState.currentPlayerId);
                if (newIdx !== -1) room.gameState.turnIndex = newIdx;
            }
            if (room.gameState && room.gameState.wordCreatorId) {
                const newCreatorIdx = room.players.findIndex(p => p.id === room.gameState.wordCreatorId);
                if (newCreatorIdx !== -1) room.gameState.creatorIndex = newCreatorIdx;
            }

            io.to(room.code).emit('playerLeft', {
                playerId: playerId,
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, disconnected: p.disconnected })),
                secretWord: room.gameState ? room.gameState.secretWord : null
            });

            if (room.players.length === 0) {
                if (room.gameState && room.gameState.timer) {
                    clearInterval(room.gameState.timer);
                    room.gameState.timer = null;
                }
                delete rooms[roomCode];
                console.log(`[IMPICCATO] Room ${roomCode} deleted - no players left`);
            } else if (playerId === room.host) {
                room.host = room.players[0].id;
                io.to(room.code).emit('newHost', { hostId: room.host });

                if (room.gameState && room.gameState.status === 'playing' && room.gameState.currentPlayerId === playerId) {
                    handlePassTurn(room);
                }
            } else if (room.gameState && room.gameState.status === 'playing' && room.gameState.currentPlayerId === playerId) {
                handlePassTurn(room);
            }

            // If creator left during choosingWord, restart round
            if (room.config.gameMode === 'playerWord' &&
                room.gameState && room.gameState.status === 'choosingWord' &&
                room.gameState.wordCreatorId === playerId &&
                room.players.length >= 2) {
                console.log(`[IMPICCATO] Creator left during word choice, restarting round`);
                startRound(roomCode);
            }
        }
    });
}

module.exports = initImpiccato;
