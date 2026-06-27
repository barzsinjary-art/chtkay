/**
 * chtkay — anonymous 1-on-1 random chat (refined rebuild)
 *
 * Key changes from the old version:
 *  - All secrets come from environment variables (.env). Nothing hard-coded.
 *  - Private message TEXT is no longer stored. Only anonymous counters/reports.
 *  - Honest online count by default (set ONLINE_BOOST only if you really want it).
 *  - 18+ confirmation is required before matching.
 *  - Added a "report" event and light contact-info scrubbing.
 *  - Kept the good parts: random matching, local/global, rate limits, next cooldown.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');

let MongoClient = null;
try { MongoClient = require('mongodb').MongoClient; } catch (_) { /* mongo optional */ }

const app = express();
const server = http.createServer(app);

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || '';          // optional
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';     // required to view /admin/stats
const ONLINE_BOOST = parseInt(process.env.ONLINE_BOOST || '0', 10); // keep 0 for honesty

const CONFIG = {
  MAX_MESSAGE_LENGTH: 500,
  RATE_LIMIT_MESSAGES: 50,
  RATE_LIMIT_WINDOW: 60_000,
  NEXT_LIMIT: 10,
  NEXT_WINDOW: 60_000,
  NEXT_COOLDOWN: 15 * 60_000,
  // minimal, sane block list — extend as you moderate
  BANNED_WORDS: ['script', 'javascript', 'onerror', 'onload', 'iframe', '<svg'],
  GENDER_EMOJIS: { male: '👨', female: '👩', unspecified: '👤' },
};

// ---------- middleware ----------
app.use(helmet({ contentSecurityPolicy: false })); // CSP off so inline UI + socket.io work; tighten later if you externalize assets
app.use(compression());
app.use(express.json({ limit: '16kb' }));
app.use(express.static('public', { maxAge: '1h', etag: true }));

// simple per-IP HTTP rate limit
const httpHits = new Map();
const HTTP_LIMIT = 120, HTTP_WINDOW = 5 * 60_000;
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = httpHits.get(ip);
  if (!rec || now - rec.start > HTTP_WINDOW) {
    httpHits.set(ip, { count: 1, start: now });
  } else if (++rec.count > HTTP_LIMIT) {
    return res.status(429).send('Too many requests. Slow down.');
  }
  if (Math.random() < 0.005) {
    for (const [k, v] of httpHits) if (now - v.start > HTTP_WINDOW * 2) httpHits.delete(k);
  }
  next();
});

// ---------- socket.io ----------
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  cors: { origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST'] },
});

// ---------- state ----------
const waiting = [];
let online = 0;
const sessions = new Map();
const rooms = new Map();

// ---------- optional mongo (counters & reports only — never message text) ----------
let db = null;
async function connectMongo() {
  if (!MONGO_URI || !MongoClient) {
    console.log('ℹ️  Running without MongoDB (no analytics persistence).');
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
    await client.connect();
    db = client.db('chtkay');
    await db.collection('reports').createIndex({ at: -1 });
    await db.collection('ad_clicks').createIndex({ at: -1 });
    console.log('✅ MongoDB connected (reports + ad clicks only).');
  } catch (e) {
    console.log('❌ MongoDB failed, continuing without it:', e.message);
    db = null;
  }
}
connectMongo();

// ---------- helpers ----------
const displayOnline = () => Math.max(0, online) + (ONLINE_BOOST > 0 ? ONLINE_BOOST : 0);

function isNearby(a, b, maxKm = 50) {
  if (!a || !b) return false;
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) <= maxKm;
}

// light safety scrub: strip tags, collapse long digit runs (discourage sharing phone numbers)
function cleanMessage(raw) {
  let m = String(raw).trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
  m = m.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  m = m.replace(/(?:\d[\s-]?){7,}/g, '•••••');
  return m;
}
function isBlocked(m) {
  const low = m.toLowerCase();
  return CONFIG.BANNED_WORDS.some(w => low.includes(w));
}

// ---------- next-button cooldown ----------
const nextClicks = new Map();
function checkNext(id) {
  const now = Date.now();
  let u = nextClicks.get(id);
  if (!u) { u = { clicks: [], cooling: false, since: 0 }; nextClicks.set(id, u); }
  if (u.cooling) {
    const left = CONFIG.NEXT_COOLDOWN - (now - u.since);
    if (left > 0) return { ok: false, message: `Slow down — wait ${Math.ceil(left / 60000)} min before skipping again.` };
    u.cooling = false; u.clicks = [];
  }
  u.clicks = u.clicks.filter(t => t > now - CONFIG.NEXT_WINDOW);
  if (u.clicks.length >= CONFIG.NEXT_LIMIT) {
    u.cooling = true; u.since = now; u.clicks = [];
    return { ok: false, message: 'Too many skips. Take a 15-minute break.' };
  }
  u.clicks.push(now);
  return { ok: true };
}

// ---------- message rate limit ----------
const msgTimes = new Map();
function checkMsgRate(id) {
  const now = Date.now();
  const arr = msgTimes.get(id) || [];
  while (arr.length && arr[0] < now - CONFIG.RATE_LIMIT_WINDOW) arr.shift();
  if (arr.length >= CONFIG.RATE_LIMIT_MESSAGES) { msgTimes.set(id, arr); return false; }
  arr.push(now); msgTimes.set(id, arr); return true;
}

// ---------- matching ----------
function findMatch(sock) {
  if (sock.partner) return null;
  if (sock.mode === 'local' && sock.location) {
    const local = waiting.find(w => w.id !== sock.id && !w.partner &&
      w.mode === 'local' && w.location && isNearby(sock.location, w.location));
    if (local) return local;
  }
  return waiting.find(w => w.id !== sock.id && !w.partner) || null;
}

function pair(a, b) {
  [a, b].forEach(s => { const i = waiting.indexOf(s); if (i > -1) waiting.splice(i, 1); });
  a.partner = b; b.partner = a;
  const room = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  rooms.set(room, [a.id, b.id]);
  a.room = b.room = room;
  a.join(room); b.join(room);
  const note = (self, other) => self.emit('matched', {
    status: 'connected',
    partnerName: other.alias,
    genderEmoji: CONFIG.GENDER_EMOJIS[other.gender] || '👤',
    message: `You're connected with ${other.alias}. Say hi 👋`,
  });
  note(a, b); note(b, a);
}

function unpair(sock) {
  if (sock.partner) {
    sock.partner.emit('partner left');
    sock.partner.partner = null;
    sock.partner = null;
  }
  if (sock.room) {
    sock.leave(sock.room);
    const r = rooms.get(sock.room);
    if (r) { const i = r.indexOf(sock.id); if (i > -1) r.splice(i, 1); if (!r.length) rooms.delete(sock.room); }
    sock.room = null;
  }
}

// ---------- routes ----------
app.get('/health', (req, res) => res.json({
  status: 'ok', online: displayOnline(), waiting: waiting.length,
  rooms: rooms.size, mongo: !!db, time: new Date().toISOString(),
}));

app.get('/admin/stats', async (req, res) => {
  if (!ADMIN_SECRET || req.query.secret !== ADMIN_SECRET) return res.status(401).send('Unauthorized');
  const reports = db ? await db.collection('reports').countDocuments() : 0;
  res.json({ online: displayOnline(), waiting: waiting.length, rooms: rooms.size, reports });
});

// ---------- socket events ----------
io.on('connection', (socket) => {
  online++;
  io.emit('online', displayOnline());
  sessions.set(socket.id, { joinedAt: Date.now() });

  socket.on('join chat', (data = {}) => {
    if (!data.ageConfirmed) {
      socket.emit('blocked', { message: 'You must confirm you are 18 or older to chat.' });
      return;
    }
    socket.alias = `Guest_${Math.floor(Math.random() * 9000) + 1000}`;
    socket.mode = data.mode === 'local' ? 'local' : 'global';
    socket.location = data.location || null;
    socket.gender = ['male', 'female'].includes(data.gender) ? data.gender : 'unspecified';
    if (!waiting.includes(socket)) waiting.push(socket);
    const m = findMatch(socket);
    if (m) pair(socket, m);
    else socket.emit('searching', { message: 'Looking for someone to chat with…' });
  });

  socket.on('chat message', (raw) => {
    if (!socket.partner) return;
    if (!checkMsgRate(socket.id)) return socket.emit('notice', { message: 'Easy — too many messages.' });
    const msg = cleanMessage(raw);
    if (!msg) return;
    if (isBlocked(msg)) return socket.emit('notice', { message: 'That message was blocked.' });
    socket.partner.emit('chat message', { from: socket.alias, message: msg });
    socket.emit('own message', { message: msg });
  });

  socket.on('find new partner', () => {
    const r = checkNext(socket.id);
    if (!r.ok) return socket.emit('notice', { message: r.message });
    unpair(socket);
    if (!waiting.includes(socket)) waiting.push(socket);
    const m = findMatch(socket);
    if (m) pair(socket, m);
    else socket.emit('searching', { message: 'Looking for a new partner…' });
  });

  socket.on('report', async () => {
    if (db && socket.room) {
      try { await db.collection('reports').insertOne({ room: socket.room, at: new Date() }); } catch (_) {}
    }
    if (socket.partner) socket.partner.emit('notice', { message: 'You were reported. Be respectful.' });
    socket.emit('notice', { message: 'Reported. Finding you someone new.' });
    unpair(socket);
    if (!waiting.includes(socket)) waiting.push(socket);
    const m = findMatch(socket);
    if (m) pair(socket, m); else socket.emit('searching', { message: 'Looking for someone new…' });
  });

  socket.on('ad click', async (business) => {
    if (db) { try { await db.collection('ad_clicks').insertOne({ business: String(business).slice(0, 40), at: new Date() }); } catch (_) {} }
  });

  socket.on('leave chat', () => {
    unpair(socket);
    const i = waiting.indexOf(socket); if (i > -1) waiting.splice(i, 1);
  });

  socket.on('disconnect', () => {
    online--;
    io.emit('online', displayOnline());
    unpair(socket);
    const i = waiting.indexOf(socket); if (i > -1) waiting.splice(i, 1);
    sessions.delete(socket.id);
    nextClicks.delete(socket.id);
    msgTimes.delete(socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 chtkay running on :${PORT}`);
  console.log(`   online boost: ${ONLINE_BOOST} | mongo: ${MONGO_URI ? 'configured' : 'off'}`);
});
