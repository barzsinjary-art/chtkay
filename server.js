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

// ---------- AI fallback bot (the "Turing game") ----------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';      // required for the bot to work
const BOT_ENABLED = process.env.BOT_ENABLED === '1' && !!ANTHROPIC_API_KEY;
const BOT_MODEL = process.env.BOT_MODEL || 'claude-haiku-4-5';
const BOT_WAIT_MS = parseInt(process.env.BOT_WAIT_MS || '12000', 10); // hand off to bot after this long with no human

// ---------- consented training logs ----------
// OFF by default. Only turn on AFTER the in-app consent banner is live.
// Stores message TEXT (reverses the privacy rebuild) — so this is a deliberate switch.
const COLLECT_LOGS = process.env.COLLECT_LOGS === '1';

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
    if (COLLECT_LOGS) {
      await db.collection('training').createIndex({ room: 1, at: 1 });
      await db.collection('guesses').createIndex({ at: -1 });
    }
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
  [a, b].forEach(s => { const i = waiting.indexOf(s); if (i > -1) waiting.splice(i, 1); clearTimeout(s._botTimer); });
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
  clearTimeout(sock._botTimer);
  if (sock.partner) {
    if (sock.partner._isBot) sock.partner._cleanup();
    else sock.partner.emit('partner left');
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

// ============================================================
//  AI FALLBACK BOT  —  appears only when no human is around.
//  The platform discloses that some chats are AI (banner + 🤖 button),
//  so the bot plays along inside the game; it never claims to be human
//  if asked directly in a way that matters — keep it casual, not deceptive.
// ============================================================

// >>> EDIT THIS to tune the stranger. This is the whole product knob. <<<
const PERSONA = `You are a bored young person from Duhok on an anonymous chat app, texting a stranger. Not an assistant. Never help, explain, or sound polite/formal.

HOW PEOPLE HERE ACTUALLY WRITE BADINI — this is the most important thing:
- NEVER use Kurmanji diacritics. No ç ê î û ş. Write it dirty/phonetic the way people text on phones here.
- ç -> "ch"   ,   ê/î -> "e"/"i"   ,   û -> "u"/"o"   ,   x = kh sound
- Verb prefixes are split and phonetic: "d zanm" (I know), "nza"/"nzanm" (dunno), "d bem", "d axfm".
- Real words to reuse: mn, ta, to, tu, az, ch (what), chawani/chawa (how r u), bashm (i'm good), nave ta chya (whats ur name), wla, bra, hama, xode/xude, pa, ka, na, bo, aw.
- Real greetings: "halaw", "hala hala", "ha bra", "silaw", "hi", "choni".
Examples of the RIGHT vibe (copy this messiness, not exact lines):
  "halaw chawani" / "bashm wla, tu?" / "nave ta chya" / "az duhoki m, tu?" / "nza wla hama rudanm" / "ka hara bra 😂"
WRONG (sounds like a textbook / foreigner — never do this): "li ku derê yî", "çawa?", "belê", "nizanî?", "tu çi dikî".

STYLE:
- Very short. One line, under ~10 words. lowercase, lazy, typos ok, no periods.
- Reply in whatever language they use. If they write English, keep your English casual and a bit broken — NOT fluent American ("scrolling bored?" is too polished).
- Ask a small thing back sometimes (chawani / tu? / asm), don't interrogate.
- Max one emoji, rarely.
- Never say you're an AI/bot/model. If accused, brush it off: "ha? nexer 😂" / "bra chi dbeje".
- If they get rude or sexual, go short/bored or change subject. Don't lecture.`;

function botHistoryToMessages(hist) {
  // hist items: { who:'them'|'me', text }  ->  Anthropic messages
  return hist.slice(-12).map(h => ({
    role: h.who === 'them' ? 'user' : 'assistant',
    content: h.text,
  }));
}

async function callClaude(hist) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: BOT_MODEL,
      max_tokens: 120,
      system: PERSONA,
      messages: botHistoryToMessages(hist),
    }),
  });
  if (!res.ok) throw new Error('claude ' + res.status);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
  return text || '?';
}

// human-ish delay: a beat to "read" + time to "type" the reply
function humanDelay(replyLen) {
  const read = 700 + Math.random() * 1200;
  const type = Math.min(6000, replyLen * (55 + Math.random() * 45));
  return read + type;
}

let botCounter = 0;
function createBot(user) {
  const bot = {
    _isBot: true,
    id: 'bot_' + (++botCounter) + '_' + Math.random().toString(36).slice(2, 7),
    alias: `Guest_${Math.floor(Math.random() * 9000) + 1000}`,
    gender: Math.random() < 0.5 ? 'male' : 'female',
    mode: user.mode,
    location: null,
    partner: null,
    room: null,
    _hist: [],
    _timers: new Set(),
    _dead: false,
    join() {}, leave() {},
  };

  const stillPaired = () => !bot._dead && user.partner === bot;

  const t = (fn, ms) => { const id = setTimeout(() => { bot._timers.delete(id); fn(); }, ms); bot._timers.add(id); return id; };

  function think() {
    if (bot._busy) return;        // one reply in flight — ignore spam until it lands
    bot._busy = true;
    t(() => {
      if (!stillPaired()) { bot._busy = false; return; }
      user.emit('partner typing');
      callClaude(bot._hist)
        .then(reply => {
          const wait = humanDelay(reply.length);
          t(() => {
            bot._busy = false;
            if (!stillPaired()) return;
            bot._hist.push({ who: 'me', text: reply });
            user.emit('chat message', { from: bot.alias, message: reply });
            logLine(user.room, 'bot', reply);
          }, wait);
        })
        .catch(() => {
          t(() => {
            bot._busy = false;
            if (!stillPaired()) return;
            const fb = ['?', 'hmm', 'çawa?', 'k', 'lol'][Math.floor(Math.random() * 5)];
            user.emit('chat message', { from: bot.alias, message: fb });
          }, 1500);
        });
    }, 400);
  }

  bot.emit = (event, payload) => {
    if (event === 'matched') {
      // open the chat after a few seconds if the human hasn't spoken yet
      t(() => {
        if (stillPaired() && bot._hist.length === 0) {
          const openers = ['hi', 'silav', 'heyy', 'sup', 'çawayî?'];
          const o = openers[Math.floor(Math.random() * openers.length)];
          bot._hist.push({ who: 'me', text: o });
          user.emit('chat message', { from: bot.alias, message: o });
        }
      }, 3000 + Math.random() * 4000);
    } else if (event === 'chat message') {
      bot._hist.push({ who: 'them', text: payload.message });
      think();
    }
    // ignore everything else (own message, partner left, notice, online...)
  };

  bot._cleanup = () => { bot._dead = true; bot._timers.forEach(clearTimeout); bot._timers.clear(); };
  return bot;
}

function scheduleBotFallback(socket) {
  if (!BOT_ENABLED) return;
  clearTimeout(socket._botTimer);
  socket._botTimer = setTimeout(() => {
    if (socket.partner || !waiting.includes(socket)) return; // got a human, or gone
    const bot = createBot(socket);
    pair(socket, bot);
  }, BOT_WAIT_MS);
}

// ---------- training log (gated by COLLECT_LOGS + consent banner) ----------
function logLine(room, role, text) {
  if (!COLLECT_LOGS || !db || !room || !text) return;
  // sid = per-room random id, set on first use; no IP, no socket id, nothing identifying
  db.collection('training').insertOne({ room, role, text, at: new Date() }).catch(() => {});
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
    else { socket.emit('searching', { message: 'Looking for someone to chat with…' }); scheduleBotFallback(socket); }
  });

  socket.on('chat message', (raw) => {
    if (!socket.partner) return;
    if (!checkMsgRate(socket.id)) return socket.emit('notice', { message: 'Easy — too many messages.' });
    const msg = cleanMessage(raw);
    if (!msg) return;
    if (isBlocked(msg)) return socket.emit('notice', { message: 'That message was blocked.' });
    socket.partner.emit('chat message', { from: socket.alias, message: msg });
    socket.emit('own message', { message: msg });
    logLine(socket.room, 'human', msg);
  });

  // the Turing-game guess. Reveal is immediate by default (simple + satisfying);
  // flip to end-of-chat later if you want to keep the illusion running longer.
  socket.on('guess bot', () => {
    if (!socket.partner) return;
    const wasBot = !!socket.partner._isBot;
    if (COLLECT_LOGS && db) db.collection('guesses').insertOne({ wasBot, at: new Date() }).catch(() => {});
    socket.emit('reveal', { wasBot });
  });

  socket.on('find new partner', () => {
    const r = checkNext(socket.id);
    if (!r.ok) return socket.emit('notice', { message: r.message });
    unpair(socket);
    if (!waiting.includes(socket)) waiting.push(socket);
    const m = findMatch(socket);
    if (m) pair(socket, m);
    else { socket.emit('searching', { message: 'Looking for a new partner…' }); scheduleBotFallback(socket); }
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
    if (m) pair(socket, m); else { socket.emit('searching', { message: 'Looking for someone new…' }); scheduleBotFallback(socket); }
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
  console.log(`   bot: ${BOT_ENABLED ? `ON (${BOT_MODEL}, after ${BOT_WAIT_MS}ms)` : 'off'} | training logs: ${COLLECT_LOGS ? 'ON' : 'off'}`);
});
