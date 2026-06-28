'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const rm         = require('./src/roomManager');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// Grace period timers: socketId -> setTimeout handle
// When a player disconnects we wait 60s before removing them,
// so a tab refresh or brief network drop reconnects seamlessly.
const disconnectTimers = new Map();
const GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// UptimeRobot ping endpoint
app.get('/ping', (_, res) => res.send('ok'));

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // ── LOBBY ─────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name }, cb) => {
    if (!name?.trim()) return cb({ error: 'Name required.' });
    const { room, player } = rm.createRoom(name.trim(), socket.id);
    socket.join(room.code);
    socket.data = { playerId: player.id, roomCode: room.code };
    cb({ code: room.code, playerId: player.id, state: rm.publicState(room, player.id) });
  });

  socket.on('join_room', ({ code, name }, cb) => {
    if (!name?.trim() || !code?.trim()) return cb({ error: 'Name and code required.' });
    const result = rm.joinRoom(code.trim(), name.trim(), socket.id);
    if (result.error) return cb({ error: result.error });
    const { room, player, rejoined } = result;
    socket.join(room.code);
    socket.data = { playerId: player.id, roomCode: room.code };

    // Notify everyone in the room that a new player joined
    // Use io.to() directly to guarantee all sockets in the room get the update
    io.to(room.code).emit('room_update', rm.publicState(room, null));
    io.to(room.code).emit('game_notice', { msg: `${player.name} joined the room.` });
    // Also send personalised state_update to each existing player
    _broadcastState(room);
    cb({ code: room.code, playerId: player.id, state: rm.publicState(room, player.id) });
  });

  socket.on('start_game', (_, cb) => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode || !playerId) return cb?.({ error: 'Not in a room.' });
    const room = rm.getRoom(roomCode);
    if (!room) return cb?.({ error: 'Room not found.' });
    if (room.host !== playerId) {
      // Host check failed — try finding player by socket as fallback
      const p = room.players.find(p => p.socketId === socket.id);
      if (!p || room.host !== p.id) return cb?.({ error: 'Only the host can start.' });
    }
    if (room.players.length < 2) return cb?.({ error: 'Need at least 2 players to start.' });
    const res = rm.startGame(roomCode);
    if (res.error) return cb?.({ error: res.error });
    _broadcastState(res.room);
    cb?.({ ok: true });
  });

  // ── GAMEPLAY ───────────────────────────────────────────────────────────────
  socket.on('play_card', ({ cardUid, targetId, extra }, cb) => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode) return cb?.({ error: 'Not in a room.' });
    const res = rm.playCard(roomCode, playerId, cardUid, targetId, extra || {});
    if (res.error) return cb?.({ error: res.error });

    const { room, result } = res;

    // Broadcast notification to ALL players (log entry on every screen)
    if (result.broadcast) {
      io.to(room.code).emit('game_notice', result.broadcast);
    }
    // Personal notice to the target only (e.g. Bard target told they were peeked)
    if (result.targetNotify) {
      const tp = room.players.find(p => p.id === result.targetNotify.playerId);
      if (tp) {
        const tsocket = [...io.sockets.sockets.values()].find(s => s.id === tp.socketId);
        if (tsocket) tsocket.emit('personal_notice', { msg: result.targetNotify.msg });
      }
    }
    // Private modal only for actor (Bard peek)
    if (result.modalFor && result.modalFor === playerId) {
      socket.emit('private_modal', result.modalData);
    }
    // Two-player modal (Smaug result, Legolas/Tauriel comparison)
    if (Array.isArray(result.modalFor)) {
      result.modalFor.forEach(pid => {
        const p = room.players.find(p => p.id === pid);
        if (!p) return;
        const psocket = [...io.sockets.sockets.values()].find(s => s.id === p.socketId);
        if (psocket) psocket.emit('show_modal', result.modalData);
      });
    }

    if (result.roundEnd) {
      const reveal = rm.revealState(room);
      io.to(room.code).emit('round_end', { state: reveal, winner: result.winner });
    } else {
      _broadcastState(room);
    }
    cb?.({ ok: true });
  });

  socket.on('next_round', (_, cb) => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode) return cb?.({ error: 'Not in a room.' });
    const room = rm.getRoom(roomCode);
    if (!room || room.host !== playerId) return cb?.({ error: 'Only the host can start next round.' });
    const res = rm.nextRound(roomCode);
    if (res.error) return cb?.({ error: res.error });
    _broadcastState(res.room);
    cb?.({ ok: true });
  });

  // ── CHAT ──────────────────────────────────────────────────────────────────
  socket.on('chat', ({ message }) => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode || !message?.trim()) return;
    const entry = rm.addChat(roomCode, playerId, message.trim());
    if (entry) io.to(roomCode).emit('chat_msg', entry);
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { playerId, roomCode } = socket.data || {};
    if (!playerId || !roomCode) return;

    const room = rm.getRoom(roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    // Notify others they dropped but don't remove yet
    io.to(roomCode).emit('game_notice', { msg: `${player.name} disconnected — their spot is held for 24 hours.` });

    // Start grace period timer
    const timer = setTimeout(() => {
      disconnectTimers.delete(playerId);
      const info = rm.removePlayer(socket.id);
      if (info) {
        const { code, room: r } = info;
        if (r) {
          io.to(code).emit('game_notice', { msg: `${player.name} was removed after disconnecting.` });
          _broadcastState(r);
        }
      }
    }, GRACE_MS);
    disconnectTimers.set(playerId, timer);
  });

  // ── QUIT ─────────────────────────────────────────────────────────────────────
  socket.on('quit', () => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode) return;
    // Cancel any grace timer — this is intentional
    if (disconnectTimers.has(playerId)) {
      clearTimeout(disconnectTimers.get(playerId));
      disconnectTimers.delete(playerId);
    }
    const room = rm.getRoom(roomCode);
    if (room) {
      const p = room.players.find(p => p.id === playerId);
      const name = p ? p.name : 'A player';
      // Notify everyone else to return to lobby
      io.to(roomCode).emit('room_dissolved', { reason: `${name} quit the game. The room has been closed.` });
    }
    rm.removePlayer(socket.id);
    socket.leave(roomCode);
    socket.data = {};
  });

  // ── REJOIN (socket drop reconnect) ───────────────────────────────────────────
  // Called when socket drops and reconnects — identifies player by name
  socket.on('rejoin_room', ({ code, name }, cb) => {
    if (!code || !name) return;
    const room = rm.getRoom(code.toUpperCase());
    if (!room) {
      socket.emit('rejoin_result', { error: 'Room no longer exists.' });
      return;
    }
    const player = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!player) {
      socket.emit('rejoin_result', { error: 'Player not found in room.' });
      return;
    }
    // Cancel grace period timer if running
    if (disconnectTimers.has(player.id)) {
      clearTimeout(disconnectTimers.get(player.id));
      disconnectTimers.delete(player.id);
    }
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data = { playerId: player.id, roomCode: room.code };
    io.to(room.code).emit('game_notice', { msg: `${player.name} reconnected.` });
    const state = room.phase === 'round_end' ? rm.revealState(room) : rm.publicState(room, player.id);
    socket.emit('rejoin_result', { code: room.code, playerId: player.id, name: player.name, state });
    _broadcastState(room);
  });

  // ── REQUEST STATE (reconnect / refresh) ───────────────────────────────────
  socket.on('request_state', ({ code, playerId }, cb) => {
    // Cancel any pending grace-period removal for this player
    if (disconnectTimers.has(playerId)) {
      clearTimeout(disconnectTimers.get(playerId));
      disconnectTimers.delete(playerId);
    }

    const res = rm.reconnect(code, playerId, socket.id);
    if (!res) return cb?.({ error: 'Could not reconnect.' });
    const { room, player } = res;
    socket.join(room.code);
    socket.data = { playerId: player.id, roomCode: room.code };

    // Tell everyone they're back
    io.to(room.code).emit('game_notice', { msg: `${player.name} reconnected.` });

    if (room.phase === 'round_end') {
      cb?.({ state: rm.revealState(room) });
    } else {
      cb?.({ state: rm.publicState(room, player.id) });
    }
    _broadcastState(room);
  });

  function _broadcastState(room) {
    // Send personalised state_update to each player (hides others' hands)
    room.players.forEach(p => {
      const playerSocket = [...io.sockets.sockets.values()].find(s => s.id === p.socketId);
      if (playerSocket) {
        playerSocket.emit('state_update', rm.publicState(room, p.id));
      }
    });
    // Broadcast room_update to ALL in the socket room (waiting room refresh)
    // Uses null so no hand is marked isMe — client uses S.playerId to identify self
    io.to(room.code).emit('room_update', rm.publicState(room, null));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HLL running on port ${PORT}`));
