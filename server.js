const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const CLIENT_ROOT = path.join(__dirname, '..');

app.use(express.static(CLIENT_ROOT));

app.get('/', (_req, res) => {
    res.sendFile(path.join(CLIENT_ROOT, 'index.html'));
});

app.get('/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.size });
});

function generateRoomCode() {
    let code = '';
    do {
        code = Array.from({ length: ROOM_CODE_LENGTH }, () => {
            const index = Math.floor(Math.random() * ROOM_CODE_CHARS.length);
            return ROOM_CODE_CHARS[index];
        }).join('');
    } while (rooms.has(code));
    return code;
}

function getRoomBySocket(socket) {
    const code = socket.data.roomCode;
    if (!code) return null;
    return rooms.get(code) ?? null;
}

function cleanupRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.socketIds.forEach((socketId) => {
        const peer = io.sockets.sockets.get(socketId);
        if (peer) {
            peer.leave(code);
            delete peer.data.roomCode;
        }
    });
    rooms.delete(code);
}

function emitRoomEnded(room, leavingSocketId) {
    room.socketIds.forEach((socketId) => {
        if (socketId === leavingSocketId) return;
        io.to(socketId).emit('room-ended', {
            message: 'The other player disconnected. The room has been closed.',
        });
    });
}

io.on('connection', (socket) => {
    socket.on('host-room', () => {
        const existingRoom = getRoomBySocket(socket);
        if (existingRoom) {
            io.to(socket.id).emit('online-error', { message: 'You are already in a room.' });
            return;
        }

        const code = generateRoomCode();
        rooms.set(code, {
            code,
            hostSocketId: socket.id,
            socketIds: [socket.id],
            players: {},
            selectedBuilds: { 1: 'gunner', 2: 'gunner' },
        });

        socket.join(code);
        socket.data.roomCode = code;
        io.to(socket.id).emit('room-hosted', { code });
    });

    socket.on('join-room', ({ code }) => {
        const normalizedCode = String(code || '').trim().toUpperCase();
        const room = rooms.get(normalizedCode);

        if (!/^[A-Z0-9]{6}$/.test(normalizedCode)) {
            io.to(socket.id).emit('online-error', { message: 'Room codes must be 6 characters.' });
            return;
        }
        if (!room) {
            io.to(socket.id).emit('online-error', { message: 'That room code does not exist.' });
            return;
        }
        if (room.socketIds.length >= 2) {
            io.to(socket.id).emit('online-error', { message: 'That room is already full.' });
            return;
        }
        if (room.socketIds.includes(socket.id)) {
            io.to(socket.id).emit('online-error', { message: 'You are already in that room.' });
            return;
        }

        room.socketIds.push(socket.id);
        socket.join(normalizedCode);
        socket.data.roomCode = normalizedCode;
        io.to(socket.id).emit('room-joined', { code: normalizedCode });

        const hostIsPlayer1 = Math.random() < 0.5;
        room.players[room.hostSocketId] = {
            playerId: hostIsPlayer1 ? 1 : 2,
            isHost: true,
        };
        room.players[socket.id] = {
            playerId: hostIsPlayer1 ? 2 : 1,
            isHost: false,
        };

        room.socketIds.forEach((socketId) => {
            const player = room.players[socketId];
            io.to(socketId).emit('game-start', {
                code: normalizedCode,
                playerId: player.playerId,
                isHost: player.isHost,
                selectedBuilds: room.selectedBuilds,
            });
        });
    });

    socket.on('online-build-select', ({ roomCode, playerId, build }) => {
        const room = rooms.get(roomCode);
        if (!room || !room.players[socket.id]) return;
        if (room.players[socket.id].playerId !== playerId) return;
        room.selectedBuilds[playerId] = build;
        io.to(roomCode).emit('online-build-select', { playerId, build });
    });

    socket.on('online-start-round', ({ roomCode, selectedBuilds }) => {
        const room = rooms.get(roomCode);
        if (!room || room.hostSocketId !== socket.id || room.socketIds.length < 2) return;
        room.selectedBuilds = {
            ...room.selectedBuilds,
            ...selectedBuilds,
        };
        io.to(roomCode).emit('online-round-start', {
            selectedBuilds: room.selectedBuilds,
        });
    });

    socket.on('online-return-menu', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room || !room.players[socket.id]) return;
        io.to(roomCode).emit('online-return-menu');
    });

    socket.on('online-input', ({ roomCode, playerId, inputs }) => {
        const room = rooms.get(roomCode);
        if (!room || !room.players[socket.id]) return;
        if (room.players[socket.id].playerId !== playerId) return;
        socket.to(roomCode).emit('online-input', { playerId, inputs });
    });

    socket.on('disconnect', () => {
        const room = getRoomBySocket(socket);
        if (!room) return;
        emitRoomEnded(room, socket.id);
        cleanupRoom(room.code);
    });
});

server.listen(PORT, () => {
    console.log(`Orbit Duel server listening on port ${PORT}`);
});
