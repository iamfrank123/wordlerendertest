const { SECRET_WORDS_IT, SECRET_WORDS_EN } = require('./constants');
const SERVER_TRANSLATIONS = require('./server_translations');

function t(key, lang = 'it', params = {}) {
    const dict = SERVER_TRANSLATIONS[lang] || SERVER_TRANSLATIONS['it'];
    let text = dict[key] || key;
    for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
    }
    return text;
}

module.exports = function (socket, io, allVsAllRooms, isValidWord) {
    // --- ALL VERSUS ALL MODE LOGIC ---

    socket.on('createRoomAllVsAll', (data) => {
        const nickname = (typeof data === 'object' && data.nickname) ? data.nickname : data;
        const language = (typeof data === 'object' && data.language) ? data.language : 'it';

        let roomId;
        do {
            roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        } while (allVsAllRooms[roomId]);

        const list = language === 'en' ? SECRET_WORDS_EN : SECRET_WORDS_IT;
        const secretWord = list[Math.floor(Math.random() * list.length)];

        allVsAllRooms[roomId] = {
            id: roomId,
            players: [], // { id, nickname, dots: 0, foundIndices: Set(), isHost }
            secretWord: secretWord,
            status: 'waiting', // waiting, playing, finished
            language: language
        };

        console.log(`[ALL VS ALL] Created Room ${roomId} (${language}). Secret Word: ${secretWord}`);

        const player = {
            id: socket.id,
            nickname: nickname,
            dots: 0,
            foundIndices: new Set(),
            isHost: true
        };

        allVsAllRooms[roomId].players.push(player);
        socket.join(roomId);

        socket.emit('roomCreated', { roomId, hostNickname: nickname });
    });

    socket.on('joinRoomAllVsAll', (data) => {
        const { roomId, nickname } = data;
        const room = allVsAllRooms[roomId];

        if (room && room.status === 'waiting' && room.players.length < 10) { // Max 10 players
            const player = {
                id: socket.id,
                nickname: nickname,
                dots: 0,
                foundIndices: new Set(),
                isHost: false
            };

            room.players.push(player);
            socket.join(roomId);

            socket.emit('joinedRoom', {
                roomId,
                players: room.players.map(p => ({ nickname: p.nickname, isHost: p.isHost, dots: p.dots }))
            });

            io.to(roomId).emit('playerJoined', room.players.map(p => ({ nickname: p.nickname, isHost: p.isHost, dots: p.dots })));
        } else {
            // Can't translate easily if no room, but we can default IT
            const lang = room ? room.language : 'it';
            socket.emit('error', t('ava_room_full', lang));
        }
    });

    socket.on('startAllVsAll', (roomId) => {
        const room = allVsAllRooms[roomId];
        if (!room) return;

        // Reset state if restarting
        room.status = 'playing';
        const list = room.language === 'en' ? SECRET_WORDS_EN : SECRET_WORDS_IT;
        room.secretWord = list[Math.floor(Math.random() * list.length)]; // Generate NEW word

        console.log(`[ALL VS ALL] Room ${roomId} Started. Secret Word: ${room.secretWord}`);

        room.players.forEach(p => {
            p.dots = 0;
            p.foundIndices = new Set();
        });

        io.to(roomId).emit('gameStarted', {
            players: room.players.map(p => ({ id: p.id, nickname: p.nickname, dots: 0 }))
        });
    });

    socket.on('submitAllVsAll', (data) => {
        const { roomId, guess } = data;
        const room = allVsAllRooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const word = guess.toUpperCase();

        if (!isValidWord(word, room.language)) { // Uses central dictionary + linguistic pattern logic
            socket.emit('guessResult', { valid: false });
            return;
        }

        const secret = room.secretWord;
        const feedback = Array(5).fill('not-in-word');
        const secretArr = secret.split('');
        const guessArr = word.split('');

        // 1. Check Greens
        guessArr.forEach((char, i) => {
            if (char === secretArr[i]) {
                feedback[i] = 'correct-position';
                player.foundIndices.add(i); // MARK PROGRESS
                secretArr[i] = null;
                guessArr[i] = null;
            }
        });

        // 2. Check Yellows
        guessArr.forEach((char, i) => {
            if (char && secretArr.includes(char)) {
                feedback[i] = 'wrong-position';
                secretArr[secretArr.indexOf(char)] = null;
            }
        });

        player.dots = player.foundIndices.size;

        // Send individual feedback
        socket.emit('guessResult', {
            valid: true,
            word: word,
            feedback: feedback,
            rowIndex: 0 // Client handles increment
        });

        // Broadcast standings update
        io.to(roomId).emit('standingsUpdate', room.players.map(p => ({ id: p.id, nickname: p.nickname, dots: p.dots })));

        // Win Condition
        if (player.dots === 5) {
            room.status = 'finished';
            io.to(roomId).emit('gameWon', { winnerNickname: player.nickname, secretWord: secret });
        }
    });
};
