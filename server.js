// Wensenlijst: serves the web app and keeps every event in one JSON file.
// Every API call carries a participant token; the server answers with that participant's view only.
// Clients hear about changes over Server-Sent Events and then fetch their own view again.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OpError, emptyDb, resolve, createEvent, viewEvent, applyOp, migrate } = require('./lib.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Forgiving on purpose: a code typed on a phone keyboard, or pasted into Coolify with quotes or a
// trailing space, should still match. Case, surrounding whitespace and surrounding quotes are ignored.
const normalizeCode = s => String(s || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase();
const AANMAAKCODE = normalizeCode(process.env.AANMAAKCODE);
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'wensen.json');

function load() {
  try { return migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch { return emptyDb(); }
}
let db = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

const listeners = new Set();
function changed() {
  db.version += 1;
  save();
  const msg = `data: ${JSON.stringify({ version: db.version })}\n\n`;
  for (const res of listeners) res.write(msg);
}

function codeOk(given) {
  if (!AANMAAKCODE) return true;
  const a = Buffer.from(normalizeCode(given)), b = Buffer.from(AANMAAKCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A handful of wrong creation codes per address per quarter hour, so the code cannot be guessed.
const attempts = new Map();
function tooManyAttempts(ip) {
  const t = Date.now(), a = attempts.get(ip);
  if (!a || t - a.since > 15 * 60 * 1000) return false;
  return a.count >= 10;
}
function noteFailure(ip) {
  const t = Date.now(), a = attempts.get(ip);
  if (!a || t - a.since > 15 * 60 * 1000) attempts.set(ip, { since: t, count: 1 });
  else a.count++;
}
const clientIp = req => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
    const ext = path.extname(file);
    const cache = ext === '.png' ? 'public, max-age=604800' : 'no-cache';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, ...SECURITY_HEADERS });
    res.end(buf);
  });
}

function stateFor(tokens) {
  const events = [], unknown = [];
  for (const t of tokens) {
    const hit = resolve(db, t);
    if (hit) events.push({ token: t, ...viewEvent(hit.event, hit.participant) });
    else unknown.push(t);
  }
  return { version: db.version, events, unknown };
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Er ging iets mis op de server' });
    else res.end();
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);

  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { needsCode: !!AANMAAKCODE });

  // Carries only a version number, so it needs no token.
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ version: db.version })}\n\n`);
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); listeners.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/state') {
    const body = await readJson(req);
    const tokens = Array.isArray(body && body.tokens) ? body.tokens.filter(t => typeof t === 'string').slice(0, 50) : [];
    return json(res, 200, stateFor(tokens));
  }

  if (req.method === 'POST' && url.pathname === '/api/create') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) return json(res, 429, { error: 'Te veel pogingen, probeer het over een kwartier opnieuw' });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: 'Ongeldig verzoek' });
    if (!codeOk(body.code)) { noteFailure(ip); return json(res, 401, { error: 'Deze aanmaakcode klopt niet' }); }
    try {
      const { token } = createEvent(db, body);
      changed();
      return json(res, 200, { token });
    } catch (e) {
      if (e instanceof OpError) return json(res, e.status, { error: e.message });
      throw e;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/op') {
    const body = await readJson(req);
    if (!body || typeof body.op !== 'object' || body.op === null) return json(res, 400, { error: 'Ongeldig verzoek' });
    const hit = resolve(db, body.token);
    if (!hit) return json(res, 401, { error: 'Deze link werkt niet meer. Vraag de organisator om een nieuwe.' });
    try {
      const result = applyOp(db, hit.event, hit.participant, body.op);
      changed();
      return json(res, 200, { ok: true, result, version: db.version });
    } catch (e) {
      if (e instanceof OpError) return json(res, e.status, { error: e.message });
      throw e;
    }
  }

  json(res, 404, { error: 'Niet gevonden' });
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`Wensenlijst op poort ${PORT}${AANMAAKCODE ? '' : ' (zonder aanmaakcode)'}`));
}
module.exports = { server };
