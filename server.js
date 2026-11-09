// FAKE-CHECK – tiny server: serves /public and proxies uploads to Sightengine so the API key stays on the server.
// Requires Node 18+. No npm packages.  Run:  SIGHTENGINE_API_USER=xxxx SIGHTENGINE_API_SECRET=yyyy node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

try { // optional .env loader
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
} catch (_) {}

const PORT = process.env.PORT || 3000;
const KEY = process.env.SIGHTENGINE_API_USER && process.env.SIGHTENGINE_API_SECRET;
const MAX = 100 * 1024 * 1024; // 100 MB
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// ---------- Daily limit per visitor (by IP address) ----------
const crypto = require('crypto');
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '5', 10);   // checks per visitor per day
const TZ = process.env.LIMIT_TIMEZONE || 'Asia/Kolkata';            // the day resets at midnight in this zone
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) {}
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
function saveUsage() {
  const t = today();
  for (const k of Object.keys(usage)) if (usage[k].day !== t) delete usage[k];
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) {}
}
function used(id) { const u = usage[id]; return u && u.day === today() ? u.n : 0; }
function bump(id, d) { const t = today(); const u = usage[id] && usage[id].day === t ? usage[id] : (usage[id] = { day: t, n: 0 }); u.n = Math.max(0, u.n + d); saveUsage(); }
// Visitors are identified by a hash of their IP address, so the file holds no readable IPs.
function visitor(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return crypto.createHash('sha256').update('fc|' + ip).digest('hex').slice(0, 24);
}
function me(req, res) { const u = used(visitor(req)); send(res, 200, { used: u, limit: DAILY_LIMIT, left: Math.max(0, DAILY_LIMIT - u) }); }
// Wraps a check: takes one of the day's checks, gives it back if the check fails.
function guarded(handler) {
  return async (req, res) => {
    const id = visitor(req);
    if (used(id) >= DAILY_LIMIT) return send(res, 429, { error: 'You have used all ' + DAILY_LIMIT + ' free checks for today. Come back tomorrow.', code: 'daily' });
    bump(id, 1);
    const orig = res.writeHead; let code = 200;
    res.writeHead = function (c, ...r) { code = c; return orig.call(this, c, ...r); };
    res.on('finish', () => { if (code >= 400) bump(id, -1); });
    return handler(req, res);
  };
}

// Optional password for the whole site: set APP_PASSWORD (any username).
function authed(req, res) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  const h = req.headers.authorization || '';
  const got = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  if (got === pw) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FAKE-CHECK"', 'Content-Type': 'text/plain' });
  res.end('Password required');
  return false;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- Sightengine ----------
const SE_BASE = process.env.SIGHTENGINE_BASE || 'https://api.sightengine.com/1.0';
const SE_IMAGE_MODELS = process.env.SIGHTENGINE_IMAGE_MODELS || 'genai,deepfake'; // AI-generated + face-swap deepfake
const SE_VIDEO_MODELS = process.env.SIGHTENGINE_VIDEO_MODELS || 'genai';
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|wmv)(\?|#|$)/i;

// Turn Sightengine's reply (one image, or a list of video frames) into { aiScore, sources[], frames }.
function summarize(j) {
  const types = [];
  if (j.type) types.push(j.type);
  const frames = j.data && Array.isArray(j.data.frames) ? j.data.frames : [];
  frames.forEach(f => { if (f.type) types.push(f.type); });
  let ai = null, fake = null; const gen = {};
  types.forEach(t => {
    if (typeof t.ai_generated === 'number') ai = Math.max(ai == null ? 0 : ai, t.ai_generated);
    if (typeof t.deepfake === 'number') fake = Math.max(fake == null ? 0 : fake, t.deepfake);
    if (t.ai_generators) for (const k of Object.keys(t.ai_generators)) if (typeof t.ai_generators[k] === 'number') gen[k] = Math.max(gen[k] || 0, t.ai_generators[k]);
  });
  const aiScore = ai == null && fake == null ? null : Math.max(ai || 0, fake || 0);
  const sources = Object.keys(gen).filter(k => gen[k] >= 0.02).sort((x, y) => gen[y] - gen[x]).slice(0, 6).map(k => ({ name: k, score: gen[k] }));
  return { aiScore, sources, frames: frames.length || 1 };
}
async function seCall(path, form, wait) {
  const user = process.env.SIGHTENGINE_API_USER, secret = process.env.SIGHTENGINE_API_SECRET;
  if (!user || !secret) return { code: 500, body: { error: 'SIGHTENGINE_API_USER and SIGHTENGINE_API_SECRET are not set on the server.' } };
  form.append('api_user', user); form.append('api_secret', secret);
  try {
    const r = await fetch(SE_BASE + path, { method: 'POST', body: form, signal: AbortSignal.timeout(wait || 60000) });
    const j = await r.json().catch(() => null);
    if (!j) return { code: 502, body: { error: 'Unexpected response from the detection service.' } };
    if (j.status !== 'success') return { code: 502, body: { error: (j.error && j.error.message) || 'The detection service could not process this file.' } };
    const out = summarize(j);
    if (out.aiScore == null) return { code: 502, body: { error: 'The detection service returned no result for this file.' } };
    return { code: 200, body: out };
  } catch (e) { return { code: 502, body: { error: 'Could not reach the detection service.' } }; }
}

async function detect(req, res) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX) return send(res, 413, { error: 'File too large (100 MB max).' }); chunks.push(c); }
  if (!size) return send(res, 400, { error: 'Empty upload.' });
  const type = req.headers['content-type'] || 'application/octet-stream';
  const name = decodeURIComponent(req.headers['x-filename'] || 'upload');
  if (/^audio\//.test(type)) return send(res, 415, { error: 'Audio files are not supported yet. Upload an image or a video under 1 minute.' });
  const isVideo = /^video\//.test(type) || VIDEO_EXT.test(name);
  const form = new FormData();
  form.append('media', new Blob([Buffer.concat(chunks)], { type }), name);
  form.append('models', isVideo ? SE_VIDEO_MODELS : SE_IMAGE_MODELS);
  const r = await seCall(isVideo ? '/video/check-sync.json' : '/check.json', form, isVideo ? 120000 : 60000);
  send(res, r.code, r.body);
}

async function detectUrl(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let url; try { url = JSON.parse(Buffer.concat(chunks).toString()).url; } catch (_) {}
  if (!/^https?:\/\//i.test(url || '')) return send(res, 400, { error: 'Enter a valid http(s) link.' });
  const isVideo = VIDEO_EXT.test(url);
  const form = new FormData();
  if (isVideo) { form.append('stream_url', url); form.append('models', SE_VIDEO_MODELS); }
  else { form.append('url', url); form.append('models', SE_IMAGE_MODELS); }
  const r = await seCall(isVideo ? '/video/check-sync.json' : '/check.json', form, isVideo ? 120000 : 60000);
  send(res, r.code, r.body);
}

http.createServer((req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (!authed(req, res)) return;
  if (req.method === 'GET' && req.url === '/api/me') return me(req, res);
  if (req.method === 'POST' && req.url === '/api/detect') return guarded(detect)(req, res);
  if (req.method === 'POST' && req.url === '/api/detect-url') return guarded(detectUrl)(req, res);
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(__dirname, 'public', p));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('FAKE-CHECK running on http://localhost:' + PORT + (KEY ? '' : '  (SIGHTENGINE keys missing)')));
