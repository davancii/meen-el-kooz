const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cardsData = require('./meen_el_kooz_cards.json');
const GAME_CARDS = cardsData.cards;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room state ────────────────────────────────────────────────────────────────
const rooms = {}; // roomCode -> Room

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  rooms[code] = {
    code,
    hostSocketId,
    players: [],          // [{ id, name, score, avatar, isConnected }]
    state: 'lobby',       // lobby | playing | roundActive | voting | roundEnd | gameOver
    round: 0,
    performerIndex: 0,    // which player is performing this round
    roundTimer: null,
    roundDuration: 30,
    challengeCard: '',
    votes: {},            // pendingVote: { targetId, reason, votes: {}, timer }
    laughedThisRound: [], // player IDs who laughed this round
    expressionData: {},   // socketId -> { happy, faceVisible, lastSeen }
  };
  return rooms[code];
}

function getRoom(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === socketId));
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room_state', sanitizeRoom(room));
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      avatar: p.avatar,
      isConnected: p.isConnected,
      isHost: p.id === room.hostSocketId
    })),
    state: room.state,
    round: room.round,
    totalRounds: room.players.length,
    performerIndex: room.performerIndex,
    performerId: room.players[room.performerIndex]?.id,
    performerName: room.players[room.performerIndex]?.name,
    roundDuration: room.roundDuration,
    challengeCard: room.challengeCard,
    laughedThisRound: room.laughedThisRound,
    pendingVote: room.pendingVote ? {
      targetId: room.pendingVote.targetId,
      targetName: room.pendingVote.targetName,
      reason: room.pendingVote.reason,
      votes: room.pendingVote.votes,
      timeLeft: room.pendingVote.timeLeft
    } : null
  };
}

// ─── Challenge cards ───────────────────────────────────────────────────────────
function pickCard() {
  return GAME_CARDS[Math.floor(Math.random() * GAME_CARDS.length)];
}

function pickDuration() {
  return [30, 35, 40, 45][Math.floor(Math.random() * 4)];
}

// ─── Game logic ────────────────────────────────────────────────────────────────
function startRound(room) {
  room.state = 'roundActive';
  room.laughedThisRound = [];
  room.pendingVote = null;
  room.challengeCard = pickCard();
  room.roundDuration = pickDuration();
  room.round++;
  clearTimeout(room.roundTimer);

  broadcastRoomState(room);

  // Start server-side countdown
  let timeLeft = room.roundDuration;
  room.timerInterval = setInterval(() => {
    timeLeft--;
    io.to(room.code).emit('timer_tick', { timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      endRound(room);
    }
  }, 1000);
}

function endRound(room) {
  clearInterval(room.timerInterval);
  room.state = 'roundEnd';

  const performer = room.players[room.performerIndex];

  // Apply scores: performer +1 per laugh, laughers -1
  room.laughedThisRound.forEach(pid => {
    const p = room.players.find(x => x.id === pid);
    if (p) p.score -= 1;
    if (performer && pid !== performer.id) performer.score += 1;
  });

  broadcastRoomState(room);
  io.to(room.code).emit('round_ended', {
    laughedThisRound: room.laughedThisRound,
    performerId: performer?.id,
    performerName: performer?.name
  });
}

function startVote(room, targetId, reason, flaggedBy) {
  if (room.pendingVote) return; // already voting
  if (room.state !== 'roundActive') return;

  const target = room.players.find(p => p.id === targetId);
  if (!target) return;

  // Don't flag performer for laughing
  const performer = room.players[room.performerIndex];
  if (performer?.id === targetId && reason === 'laugh') return;

  // Already laughed this round
  if (room.laughedThisRound.includes(targetId)) return;

  clearInterval(room.timerInterval); // pause round timer

  room.state = 'voting';
  room.pendingVote = {
    targetId,
    targetName: target.name,
    reason,
    flaggedBy,
    votes: {},    // playerId -> 'confirm' | 'dismiss'
    timeLeft: 5
  };

  broadcastRoomState(room);

  // Auto-resolve vote after 5 seconds
  room.voteTimer = setInterval(() => {
    room.pendingVote.timeLeft--;
    io.to(room.code).emit('vote_tick', { timeLeft: room.pendingVote.timeLeft });

    if (room.pendingVote.timeLeft <= 0) {
      clearInterval(room.voteTimer);
      resolveVote(room, false); // time's up = false alarm
    }
  }, 1000);
}

function resolveVote(room, confirmed) {
  clearInterval(room.voteTimer);
  if (!room.pendingVote) return;

  const { targetId, targetName } = room.pendingVote;
  room.pendingVote = null;
  room.state = 'roundActive';

  if (confirmed && !room.laughedThisRound.includes(targetId)) {
    room.laughedThisRound.push(targetId);
    io.to(room.code).emit('laugh_confirmed', { targetId, targetName });
  } else {
    io.to(room.code).emit('false_alarm', { targetId, targetName });
  }

  broadcastRoomState(room);

  // Resume round timer
  let timeLeft = room.roundDuration - room.round; // approximation, server tracks this better
  // Actually restart interval from where we paused
  resumeTimer(room);
}

// Track remaining time more accurately
function resumeTimer(room) {
  // We need to track remaining time — let's store it
  if (room.roundTimeRemaining === undefined || room.roundTimeRemaining <= 0) return;

  room.timerInterval = setInterval(() => {
    room.roundTimeRemaining--;
    io.to(room.code).emit('timer_tick', { timeLeft: room.roundTimeRemaining });
    if (room.roundTimeRemaining <= 0) {
      clearInterval(room.timerInterval);
      endRound(room);
    }
  }, 1000);
}

// Better round start with accurate time tracking
function startRoundV2(room) {
  room.state = 'roundActive';
  room.laughedThisRound = [];
  room.pendingVote = null;
  room.challengeCard = pickCard();
  room.roundDuration = pickDuration();
  room.roundTimeRemaining = room.roundDuration;
  room.round++;
  clearTimeout(room.roundTimer);

  broadcastRoomState(room);

  room.timerInterval = setInterval(() => {
    if (room.state !== 'roundActive') return; // paused during vote
    room.roundTimeRemaining--;
    io.to(room.code).emit('timer_tick', { timeLeft: room.roundTimeRemaining });
    if (room.roundTimeRemaining <= 0) {
      clearInterval(room.timerInterval);
      endRound(room);
    }
  }, 1000);
}

// ─── Socket handlers ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Create room
  socket.on('create_room', ({ name, avatar }) => {
    const room = createRoom(socket.id);
    const player = { id: socket.id, name, avatar, score: 0, isConnected: true };
    room.players.push(player);
    socket.join(room.code);
    socket.emit('room_created', { code: room.code });
    broadcastRoomState(room);
  });

  // Join room
  socket.on('join_room', ({ code, name, avatar }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('error', { msg: 'الغرفة مش موجودة. تحقق من الكود.' });
    if (room.state !== 'lobby') return socket.emit('error', { msg: 'اللعبة بدأت، ما تقدر تنضم الحين.' });
    if (room.players.length >= 8) return socket.emit('error', { msg: 'الغرفة ممتلئة (8 لاعبين كحد أقصى).' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return socket.emit('error', { msg: 'هذا الاسم مستخدم. اختار اسم ثاني.' });
    }

    const player = { id: socket.id, name, avatar, score: 0, isConnected: true };
    room.players.push(player);
    socket.join(code.toUpperCase());
    socket.emit('room_joined', { code: room.code });
    broadcastRoomState(room);
    io.to(room.code).emit('player_joined', { name });
  });

  // Start game (host only)
  socket.on('start_game', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return socket.emit('error', { msg: 'بس الهوست يقدر يبدأ اللعبة.' });
    if (room.players.length < 2) return socket.emit('error', { msg: 'تحتاج لاعبين اثنين على الأقل.' });

    room.state = 'playing';
    room.round = 0;
    room.performerIndex = 0;
    room.players.forEach(p => p.score = 0);

    io.to(room.code).emit('game_started', {});
    setTimeout(() => startRoundV2(room), 1000);
  });

  // Expression data from each client (their own face)
  socket.on('expression_update', ({ happy, faceVisible }) => {
    const room = getRoom(socket.id);
    if (!room || room.state !== 'roundActive') return;

    room.expressionData[socket.id] = { happy, faceVisible, lastSeen: Date.now() };

    // Broadcast expression data to all in room so everyone can see indicators
    io.to(room.code).emit('player_expression', {
      playerId: socket.id,
      happy,
      faceVisible
    });

    const player = getPlayer(room, socket.id);
    const performer = room.players[room.performerIndex];

    // Auto-flag: face not visible
    if (!faceVisible && player && performer?.id !== socket.id) {
      startVote(room, socket.id, `${player.name} غطى وجهه أو بعد عن الكاميرا!`, 'system');
    }

    // Auto-flag: sustained laugh (happy > 0.72)
    if (faceVisible && happy > 0.72 && performer?.id !== socket.id && player) {
      // Track sustained happy
      if (!room.happyTimer) room.happyTimer = {};
      if (!room.happyTimer[socket.id]) {
        room.happyTimer[socket.id] = { start: Date.now(), happy };
      } else {
        const dur = Date.now() - room.happyTimer[socket.id].start;
        if (dur >= 1400) {
          room.happyTimer[socket.id] = null;
          startVote(room, socket.id, `${player.name} يبدو إنه ضحك!`, 'face-api');
        }
      }
    } else {
      if (!room.happyTimer) room.happyTimer = {};
      room.happyTimer[socket.id] = null;
    }
  });

  // Manual flag (button tap by any player)
  socket.on('flag_laugh', ({ targetId }) => {
    const room = getRoom(socket.id);
    if (!room || room.state !== 'roundActive') return;
    const flagger = getPlayer(room, socket.id);
    const target = getPlayer(room, targetId);
    if (!target || !flagger) return;
    startVote(room, targetId, `${flagger.name} بلّغ إن ${target.name} ضحك!`, socket.id);
  });

  // Cast vote
  socket.on('cast_vote', ({ confirm }) => {
    const room = getRoom(socket.id);
    if (!room || !room.pendingVote || room.state !== 'voting') return;

    room.pendingVote.votes[socket.id] = confirm ? 'confirm' : 'dismiss';

    // Count votes: majority of non-target players decides
    const voters = room.players.filter(p => p.id !== room.pendingVote.targetId);
    const confirms = Object.values(room.pendingVote.votes).filter(v => v === 'confirm').length;
    const dismisses = Object.values(room.pendingVote.votes).filter(v => v === 'dismiss').length;
    const majority = Math.ceil(voters.length / 2);

    broadcastRoomState(room);

    if (confirms >= majority) {
      clearInterval(room.voteTimer);
      resolveVote(room, true);
    } else if (dismisses >= majority) {
      clearInterval(room.voteTimer);
      resolveVote(room, false);
    }
  });

  // Next round (host only)
  socket.on('next_round', () => {
    const room = getRoom(socket.id);
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.state !== 'roundEnd') return;

    room.performerIndex++;

    // Check if game over
    if (room.performerIndex >= room.players.length) {
      room.state = 'gameOver';
      const sorted = [...room.players].sort((a, b) => a.score - b.score);
      const kooz = sorted[0];
      io.to(room.code).emit('game_over', {
        players: sorted.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar })),
        koozId: kooz.id,
        koozName: kooz.name
      });
      broadcastRoomState(room);
    } else {
      startRoundV2(room);
    }
  });

  // Play again (host only)
  socket.on('play_again', () => {
    const room = getRoom(socket.id);
    if (!room || room.hostSocketId !== socket.id) return;
    room.state = 'lobby';
    room.round = 0;
    room.performerIndex = 0;
    room.laughedThisRound = [];
    room.pendingVote = null;
    room.expressionData = {};
    room.happyTimer = {};
    room.players.forEach(p => p.score = 0);
    broadcastRoomState(room);
    io.to(room.code).emit('lobby_reset', {});
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    if (player) {
      player.isConnected = false;
      io.to(room.code).emit('player_disconnected', { name: player.name, id: socket.id });
    }

    // If host left and game in lobby, transfer host
    if (room.hostSocketId === socket.id && room.state === 'lobby') {
      const next = room.players.find(p => p.id !== socket.id && p.isConnected);
      if (next) {
        room.hostSocketId = next.id;
        io.to(room.code).emit('host_changed', { newHostId: next.id, newHostName: next.name });
      }
    }

    // Clean empty rooms
    if (room.players.every(p => !p.isConnected)) {
      clearInterval(room.timerInterval);
      clearInterval(room.voteTimer);
      delete rooms[room.code];
    } else {
      broadcastRoomState(room);
    }

    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎭 Meen El Kooz server running on http://localhost:${PORT}\n`);
});
