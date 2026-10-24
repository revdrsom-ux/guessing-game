import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'node:http';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));

// game settings
const PORT = process.env.PORT || 5000;
const ROUND_SECONDS = 60;
const MAX_ATTEMPTS = 3;
const WIN_POINTS = 10;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 20;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// all sessions are kept in memory, the key is the session code
const sessions = new Map();

// if the browser did not send a callback, use an empty one so nothing crashes
function makeReply(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

// input check: must be text, trimmed, and within the length limits
function cleanText(value, min, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < min || text.length > max) return null;
  return text;
}

// used to compare names and answers without caring about capitals or extra spaces
function normalise(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (sessions.has(code));
  return code;
}

// find the session and the player that belong to this socket
function getContext(socket) {
  const session = sessions.get(socket.data.code);
  if (!session) return null;
  const player = session.players.find((p) => p.id === socket.id);
  if (!player) return null;
  return { session, player };
}

// what players are allowed to see (the answer is never included)
function publicState(session) {
  return {
    code: session.code,
    status: session.status,
    masterId: session.masterId,
    hasQuestion: Boolean(session.question),
    question: session.status === 'playing' ? session.question : null,
    minPlayers: MIN_PLAYERS,
    players: session.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
  };
}

function broadcastState(session) {
  io.to(session.code).emit('state', publicState(session));
}

function say(session, text) {
  io.to(session.code).emit('message', { system: true, text });
}

// finish a round. winner is a player, or null if time ran out
function endRound(session, winner) {
  clearTimeout(session.timer);
  session.timer = null;

  if (winner) winner.score += WIN_POINTS;

  io.to(session.code).emit('result', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    answer: session.answer,
    points: winner ? WIN_POINTS : 0,
  });

  session.status = 'lobby';
  session.question = null;
  session.answer = null;
  session.attempts.clear();

  // the next player in the list becomes the game master
  const i = session.players.findIndex((p) => p.id === session.masterId);
  const next = session.players[(i + 1) % session.players.length];
  session.masterId = next.id;
  say(session, `${next.name} is the new game master.`);
  broadcastState(session);
}

// take a player out of their session
function removePlayer(socket) {
  const code = socket.data.code;
  if (!code) return;
  socket.leave(code);
  socket.data.code = null;

  const session = sessions.get(code);
  if (!session) return;

  const index = session.players.findIndex((p) => p.id === socket.id);
  if (index === -1) return;
  const [left] = session.players.splice(index, 1);
  session.attempts.delete(socket.id);

  // nobody left, so delete the session
  if (session.players.length === 0) {
    clearTimeout(session.timer);
    sessions.delete(code);
    return;
  }

  say(session, `${left.name} left the session.`);

  // the game master left, so pass the role on
  if (session.masterId === left.id) {
    const newMaster = session.players[index % session.players.length];
    session.masterId = newMaster.id;
    if (session.status === 'playing') {
      clearTimeout(session.timer);
      session.timer = null;
      io.to(code).emit('result', {
        winnerId: null,
        winnerName: null,
        answer: session.answer,
        points: 0,
        note: 'The game master left, so the game has ended.',
      });
    }
    session.status = 'lobby';
    session.question = null;
    session.answer = null;
    session.attempts.clear();
    say(session, `${newMaster.name} is the new game master.`);
  }

  broadcastState(session);
}

io.on('connection', (socket) => {
  console.log('A player is connected');

  // start a new session, the creator is the game master
  socket.on('session:create', (payload, ack) => {
    const reply = makeReply(ack);
    if (socket.data.code) return reply({ ok: false, error: 'You are already in a session.' });

    const name = cleanText(payload?.name, 1, 20);
    if (!name) return reply({ ok: false, error: 'Your name must be 1 to 20 characters.' });

    const code = makeCode();
    const session = {
      code,
      players: [{ id: socket.id, name, score: 0 }],
      masterId: socket.id,
      status: 'lobby',
      question: null,
      answer: null,
      attempts: new Map(),
      timer: null,
    };
    sessions.set(code, session);
    socket.join(code);
    socket.data.code = code;

    say(session, `${name} created the session and is the game master. Share the code ${code} with your friends.`);
    broadcastState(session);
    reply({ ok: true });
  });

  // join a session that has not started playing
  socket.on('session:join', (payload, ack) => {
    const reply = makeReply(ack);
    if (socket.data.code) return reply({ ok: false, error: 'You are already in a session.' });

    const name = cleanText(payload?.name, 1, 20);
    if (!name) return reply({ ok: false, error: 'Your name must be 1 to 20 characters.' });

    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{5}$/.test(code)) return reply({ ok: false, error: 'Enter a valid 5 character session code.' });

    const session = sessions.get(code);
    if (!session) return reply({ ok: false, error: 'No session found with that code.' });
    if (session.status === 'playing') return reply({ ok: false, error: 'A game is already in progress. Please wait for it to finish.' });
    if (session.players.length >= MAX_PLAYERS) return reply({ ok: false, error: 'This session is full.' });
    if (session.players.some((p) => normalise(p.name) === normalise(name))) {
      return reply({ ok: false, error: 'Someone in this session already uses that name.' });
    }

    session.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);
    socket.data.code = code;

    say(session, `${name} joined the session.`);
    broadcastState(session);
    reply({ ok: true });
  });

  // normal chat message
  socket.on('chat:send', (payload, ack) => {
    const reply = makeReply(ack);
    const ctx = getContext(socket);
    if (!ctx) return reply({ ok: false, error: 'You are not in a session.' });

    const text = cleanText(payload?.text, 1, 300);
    if (!text) return reply({ ok: false, error: 'A message must be 1 to 300 characters.' });

    io.to(ctx.session.code).emit('message', { from: ctx.player.name, fromId: socket.id, text });
    reply({ ok: true });
  });

  // the game master sets the question and the answer
  socket.on('game:setQuestion', (payload, ack) => {
    const reply = makeReply(ack);
    const ctx = getContext(socket);
    if (!ctx) return reply({ ok: false, error: 'You are not in a session.' });
    const { session } = ctx;

    if (session.masterId !== socket.id) return reply({ ok: false, error: 'Only the game master can do that.' });
    if (session.status === 'playing') return reply({ ok: false, error: 'A game is already in progress.' });

    const question = cleanText(payload?.question, 3, 200);
    const answer = cleanText(payload?.answer, 1, 100);
    if (!question) return reply({ ok: false, error: 'The question must be 3 to 200 characters.' });
    if (!answer) return reply({ ok: false, error: 'The answer must be 1 to 100 characters.' });

    session.question = question;
    session.answer = answer;
    say(session, 'The game master has set a question.');
    broadcastState(session);
    reply({ ok: true });
  });

  // the game master starts the round
  socket.on('game:start', (payload, ack) => {
    const reply = makeReply(ack);
    const ctx = getContext(socket);
    if (!ctx) return reply({ ok: false, error: 'You are not in a session.' });
    const { session } = ctx;

    if (session.masterId !== socket.id) return reply({ ok: false, error: 'Only the game master can start the game.' });
    if (session.status === 'playing') return reply({ ok: false, error: 'The game has already started.' });
    if (!session.question) return reply({ ok: false, error: 'Save a question and an answer first.' });
    if (session.players.length < MIN_PLAYERS) {
      return reply({ ok: false, error: `At least ${MIN_PLAYERS} players are needed. There are ${session.players.length} now.` });
    }

    session.status = 'playing';
    session.attempts = new Map();
    for (const p of session.players) {
      if (p.id !== session.masterId) session.attempts.set(p.id, MAX_ATTEMPTS);
    }

    // if nobody wins, the round ends when the time runs out
    session.timer = setTimeout(() => {
      if (session.status === 'playing') endRound(session, null);
    }, ROUND_SECONDS * 1000);

    io.to(session.code).emit('started', { seconds: ROUND_SECONDS, attempts: MAX_ATTEMPTS });
    say(session, `The game has started. You have ${ROUND_SECONDS} seconds and ${MAX_ATTEMPTS} attempts each.`);
    broadcastState(session);
    reply({ ok: true });
  });

  // a player makes a guess
  socket.on('game:guess', (payload, ack) => {
    const reply = makeReply(ack);
    const ctx = getContext(socket);
    if (!ctx) return reply({ ok: false, error: 'You are not in a session.' });
    const { session, player } = ctx;

    if (session.status !== 'playing') return reply({ ok: false, error: 'There is no game running right now.' });
    if (session.masterId === socket.id) return reply({ ok: false, error: 'The game master cannot guess.' });

    const left = session.attempts.get(socket.id) ?? 0;
    if (left <= 0) return reply({ ok: false, error: 'You have used all your attempts.' });

    const guess = cleanText(payload?.text, 1, 100);
    if (!guess) return reply({ ok: false, error: 'A guess must be 1 to 100 characters.' });

    session.attempts.set(socket.id, left - 1);
    io.to(session.code).emit('message', { from: player.name, fromId: socket.id, text: guess, guess: true });

    if (normalise(guess) === normalise(session.answer)) {
      endRound(session, player);
      return reply({ ok: true, correct: true });
    }
    reply({ ok: true, correct: false, attemptsLeft: left - 1 });
  });

  socket.on('session:leave', (payload, ack) => {
    removePlayer(socket);
    makeReply(ack)({ ok: true });
  });

  socket.on('disconnect', () => {
    removePlayer(socket);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Your httpServer is running at http://localhost:${PORT}`);
});