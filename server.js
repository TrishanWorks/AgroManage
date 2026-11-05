'use strict';
// AgroManage server. Zero dependencies. Node 18+.
const http = require('http'), https = require('https'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), UP = path.join(DATA, 'uploads'), DBF = path.join(DATA, 'db.json');
const MAX = +process.env.MAX_MEMBERS || 5, CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY = process.env.ANTHROPIC_API_KEY, MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
fs.mkdirSync(UP, { recursive: true });

let db = { company: { name: 'AgroManage', farm: null }, users: [], sessions: {}, tasks: [], inventory: [], messages: [], events: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch {}
let saving = false, dirty = false;
function save() {
  dirty = true; if (saving) return; saving = true;
  setTimeout(() => { dirty = false; fs.writeFile(DBF + '.tmp', JSON.stringify(db), () => fs.rename(DBF + '.tmp', DBF, () => { saving = false; if (dirty) save(); })); }, 150);
}

const now = () => Date.now(), uid = () => crypto.randomBytes(8).toString('hex');
const conns = new Map(), clients = new Set(), aiRL = {}, authRL = {}, STREAM = Symbol('stream');
const getU = id => db.users.find(u => u.id === id);
const pub = u => ({ id: u.id, name: u.name, role: u.role, status: conns.has(u.id) ? u.status : 'Offline (No Signal)', online: conns.has(u.id), lastSeen: u.lastSeen || null });
const bad = (s, m) => { const e = new Error(m); e.status = s; throw e; };
const out = (res, s, o, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
const dist = (a, b, c, d) => { const r = x => x * Math.PI / 180, q = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * 6371e3 * Math.asin(Math.sqrt(q)); };
const newCode = () => { for (;;) { let s = 'AM-'; for (const x of crypto.randomBytes(6)) s += CODE_CHARS[x % 32]; if (!db.users.some(u => u.code === s)) return s; } };
const normCode = v => { v = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v.startsWith('AM')) v = v.slice(2); return 'AM-' + v; };
db.users.forEach(u => { if (!u.code) { u.code = newCode(); console.log(`Existing account "${u.name}" now signs in with code ${u.code}`); save(); } });
const fmtD = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';

function send(type, data, pred) {
  const m = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!pred || pred(getU(c.uid))) c.res.write(m);
}
const taskPred = t => u => !!u && (u.role === 'owner' || u.id === t.staffId);
const visible = (u, t) => u.role === 'owner' || t.staffId === u.id;
function feed(text, by) { const ev = { id: uid(), text, ts: now(), by }; db.events.push(ev); db.events = db.events.slice(-200); send('feed', ev); save(); }
function upd(t) { send('task', t, taskPred(t)); save(); }

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function limit(ip) { const a = (authRL[ip] = (authRL[ip] || []).filter(x => now() - x < 6e5)); if (a.length >= 30) bad(429, 'Too many attempts. Try again in a few minutes.'); a.push(now()); }
function session(u) { const tok = crypto.randomBytes(32).toString('hex'); db.sessions[tok] = { uid: u.id, exp: now() + 30 * 864e5 }; save(); return tok; }
function stateFor(u) {
  return { me: { ...pub(u), code: u.code }, company: db.company.name, farm: db.company.farm, ai: !!KEY, users: db.users.map(pub),
    tasks: db.tasks.filter(t => visible(u, t)), inventory: db.inventory,
    messages: db.messages.filter(m => !m.taskId || visible(u, db.tasks.find(t => t.id === m.taskId) || {})).slice(-300),
    feed: db.events.slice(-60).reverse() };
}

const R = [];
const route = (m, p, fn, auth = true) => R.push([m, new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, auth]);
const owner = c => { if (c.u.role !== 'owner') bad(403, 'Owner access only'); };
const str = (v, max, name) => { v = String(v ?? '').trim(); if (!v || v.length > max) bad(400, `${name} is required (max ${max} characters)`); return v; };

route('GET', '/api/seats', () => ({ count: db.users.length, max: MAX }), false);
route('POST', '/api/signup', c => {
  limit(c.ip);
  if (db.users.length >= MAX) bad(403, `AgroManage is full (${MAX} of ${MAX} members). Ask the owner to remove someone to free a place.`);
  const name = str(c.b.name, 40, 'Name'), pw = String(c.b.password || '');
  if (pw.length < 6) bad(400, 'Use a password of 6 or more characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: uid(), code: newCode(), name, role: db.users.length ? 'staff' : 'owner', salt, hash: hashPw(pw, salt), status: 'Online (In Field)', lastSeen: null };
  db.users.push(u); const tok = session(u); send('user', pub(u)); feed(`${u.name} joined AgroManage as ${u.role === 'owner' ? 'owner' : 'staff'}`, u.id);
  return { ...stateFor(u), code: u.code, _cookie: tok };
}, false);
route('POST', '/api/login', c => {
  limit(c.ip); const code = normCode(c.b.code), u = db.users.find(x => x.code === code), h = hashPw(String(c.b.password || ''), u ? u.salt : '0'.repeat(32));
  if (!u || !crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'))) bad(401, 'Code or password is incorrect');
  return { ...stateFor(u), _cookie: session(u) };
}, false);
route('POST', '/api/logout', c => { const m = /sid=([a-f0-9]+)/.exec(c.req.headers.cookie || ''); if (m) { delete db.sessions[m[1]]; save(); } return { ok: true, _cookie: '' }; }, false);
route('GET', '/api/state', c => stateFor(c.u));

route('GET', '/api/stream', c => {
  c.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  c.res.write('retry: 3000\n\n');
  const cl = { res: c.res, uid: c.u.id }, u = c.u; clients.add(cl);
  const first = !conns.has(u.id); if (first) conns.set(u.id, new Set()); conns.get(u.id).add(cl);
  if (first) { send('user', pub(u)); if (!u.lastSeen || now() - u.lastSeen > 6e4) feed(`${u.name} is online`, u.id); }
  c.req.on('close', () => {
    clients.delete(cl); const s = conns.get(u.id); if (s) s.delete(cl);
    if (s && !s.size) { conns.delete(u.id); u.lastSeen = now(); send('user', pub(u)); save(); setTimeout(() => { if (!conns.has(u.id)) feed(`${u.name} went offline`, u.id); }, 20000); }
  });
  return STREAM;
});
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

route('POST', '/api/status', c => {
  if (!['Online (In Field)', 'En Route', 'On Break'].includes(c.b.status)) bad(400, 'Unknown status');
  c.u.status = c.b.status; send('user', pub(c.u)); feed(`${c.u.name} is now ${c.b.status}`, c.u.id);
});
route('POST', '/api/users/:id/role', c => {
  owner(c); const u = getU(c.p.id); if (!u) bad(404, 'No such member'); if (!['owner', 'staff'].includes(c.b.role)) bad(400, 'Bad role');
  u.role = c.b.role; send('user', pub(u)); feed(`${c.u.name} made ${u.name} ${u.role === 'owner' ? 'an owner' : 'staff'}`, c.u.id);
});
route('POST', '/api/users/:id/remove', c => {
  owner(c); const u = getU(c.p.id); if (!u) bad(404, 'No such member'); if (u.id === c.u.id) bad(400, 'You cannot remove yourself');
  db.users = db.users.filter(x => x.id !== u.id); for (const k in db.sessions) if (db.sessions[k].uid === u.id) delete db.sessions[k];
  for (const cl of [...clients]) if (cl.uid === u.id) { clients.delete(cl); cl.res.end(); } conns.delete(u.id);
  send('gone', { id: u.id }); feed(`${c.u.name} removed ${u.name} from AgroManage`, c.u.id); save();
});
route('POST', '/api/farm', c => {
  owner(c); const { lat, lng } = c.b, radius = Math.round(+c.b.radius);
  if (![lat, lng].every(Number.isFinite) || !(radius >= 20 && radius <= 20000)) bad(400, 'Location needs coordinates and a radius of 20 to 20000 m');
  db.company.farm = { lat, lng, radius }; send('farm', db.company.farm); feed(`${c.u.name} set the farm location (${radius} m boundary)`, c.u.id);
});
route('POST', '/api/checkin/request', c => {
  owner(c); const u = getU(c.b.userId); if (!u || !conns.has(u.id)) bad(400, 'That member is not online');
  send('checkin', { from: c.u.name }, x => x && x.id === u.id); feed(`${c.u.name} asked ${u.name} to check in`, c.u.id);
});
route('POST', '/api/checkin', c => {
  const { lat, lng, acc, mock } = c.b, fm = db.company.farm;
  const where = Number.isFinite(lat) && Number.isFinite(lng) ? (fm ? `${fmtD(dist(lat, lng, fm.lat, fm.lng))} from the farm centre` : 'location received') : 'no GPS fix';
  feed(`${c.u.name} checked in (${where}${mock ? ', fake GPS suspected' : ''}${acc > 50 ? ', low accuracy' : ''})`, c.u.id);
});

route('POST', '/api/tasks', c => {
  owner(c); const s = getU(c.b.staffId); if (!s) bad(400, 'Choose a team member');
  const dl = +c.b.deadline; if (!Number.isFinite(dl)) bad(400, 'Pick a deadline');
  const t = { id: uid(), title: str(c.b.title, 120, 'Title'), instr: String(c.b.instr || '').slice(0, 1000), plot: String(c.b.plot || 'Unspecified').slice(0, 60), staffId: s.id, deadline: dl, status: 'Assigned', createdAt: now(), evidence: null, urgent: !!c.b.urgent };
  db.tasks.push(t); upd(t); feed(`${c.u.name} assigned "${t.title}" to ${s.name}`, c.u.id); return t;
});
route('POST', '/api/tasks/:id/start', c => {
  const t = db.tasks.find(x => x.id === c.p.id); if (!t || t.staffId !== c.u.id) bad(404, 'Task not found');
  if (t.status === 'Assigned') { t.status = 'Ongoing'; upd(t); feed(`${c.u.name} started "${t.title}"`, c.u.id); }
});
function savePhoto(d) {
  const P = 'data:image/jpeg;base64,'; if (typeof d !== 'string' || !d.startsWith(P)) bad(400, 'Photo must be a JPEG taken in the app');
  const buf = Buffer.from(d.slice(P.length), 'base64'); if (buf.length < 1000 || buf.length > 6e6 || buf[0] !== 0xFF || buf[1] !== 0xD8) bad(400, 'Photo not accepted');
  const hash = crypto.createHash('sha256').update(buf).digest('hex'), name = uid() + '.jpg';
  const dup = db.tasks.some(t => t.evidence && t.evidence.hash === hash) || db.inventory.some(i => i.hash === hash);
  fs.writeFileSync(path.join(UP, name), buf); return { photo: name, hash, bytes: buf.length, dup };
}
function flagsFor(p, b) {
  const f = []; if (p.dup) f.push('Duplicate photo: this exact file was already submitted.');
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) f.push('Missing location: no GPS coordinates were captured.');
  else {
    if (b.mock) f.push('Mock location suspected: a fake GPS app may be running.');
    const fm = db.company.farm; if (fm) { const d = dist(b.lat, b.lng, fm.lat, fm.lng); if (d > fm.radius) f.push(`Out of area: ${fmtD(d)} from the farm (limit ${fm.radius} m).`); }
    if (b.acc > 50) f.push(`Low GPS accuracy: within ${Math.round(b.acc)} m only.`);
  }
  return f;
}
route('POST', '/api/tasks/:id/evidence', c => {
  const t = db.tasks.find(x => x.id === c.p.id); if (!t || t.staffId !== c.u.id) bad(404, 'Task not found');
  if (!['Assigned', 'Ongoing', 'Correction Requested'].includes(t.status)) bad(409, 'This task is not waiting for evidence');
  const p = savePhoto(c.b.image), b = c.b, num = v => Number.isFinite(v) ? v : null;
  t.evidence = { photo: p.photo, hash: p.hash, bytes: p.bytes, lat: num(b.lat), lng: num(b.lng), acc: num(b.acc), mock: !!b.mock, capturedAt: num(b.capturedAt), receivedAt: now(), flags: flagsFor(p, b), ai: { state: 'pending' } };
  t.status = 'Awaiting Review'; upd(t);
  feed(`${c.u.name} submitted evidence for "${t.title}"${t.evidence.flags.length ? ` (${t.evidence.flags.length} flag${t.evidence.flags.length > 1 ? 's' : ''})` : ''}`, c.u.id);
  runAI(t); return { ok: true };
});
route('POST', '/api/tasks/:id/review', c => {
  owner(c); const t = db.tasks.find(x => x.id === c.p.id); if (!t || t.status !== 'Awaiting Review') bad(409, 'Nothing to review');
  if (c.b.decision === 'approve') t.status = 'Approved'; else if (c.b.decision === 'correct') t.status = 'Correction Requested'; else bad(400, 'Bad decision');
  if (c.b.decision === 'correct' && c.b.note) addMsg(c.u, `Correction needed: ${String(c.b.note).slice(0, 500)}`, t.id);
  upd(t); feed(`${c.u.name} ${t.status === 'Approved' ? 'approved' : 'requested a correction on'} "${t.title}"`, c.u.id);
});

const validAI = o => o && VERD.includes(o.verdict) && typeof o.confidence_score === 'number' && o.confidence_score >= 0 && o.confidence_score <= 1 && typeof o.explanation === 'string' && o.explanation.trim() && o.explanation.length <= 300 && Object.keys(o).length === 3;
const VERD = ['Appears Complete', 'Appears Incomplete', 'Insufficient Evidence'];
async function runAI(t) {
  const ev = t.evidence;
  if (!KEY) { ev.ai = { state: 'off' }; return upd(t); }
  const rl = (aiRL[t.staffId] = (aiRL[t.staffId] || []).filter(x => now() - x < 6e5));
  if (rl.length >= 5) { ev.ai = { state: 'limited' }; return upd(t); } rl.push(now());
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300,
        system: 'You review photos of farm work. Reply with ONLY a JSON object with exactly these keys: verdict (one of "Appears Complete", "Appears Incomplete", "Insufficient Evidence"), confidence_score (number from 0 to 1), explanation (one or two sentences, at most 300 characters). No other text.',
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(UP, ev.photo)).toString('base64') } }, { type: 'text', text: `Task: ${t.title}\nInstructions: ${t.instr}\nLocation: ${t.plot}` }] }] }) });
    const j = await r.json(), txt = (j.content || []).map(x => x.text || '').join(''), o = JSON.parse(/\{[\s\S]*\}/.exec(txt)[0]);
    if (!validAI(o)) throw new Error('schema'); ev.ai = { state: 'done', ...o };
  } catch (e) { ev.ai = { state: 'error' }; }
  upd(t);
}

function addMsg(u, text, taskId) {
  const m = { id: uid(), uid: u.id, name: u.name, text, ts: now(), taskId: taskId || null };
  db.messages.push(m); db.messages = db.messages.slice(-1000); save();
  const t = taskId && db.tasks.find(x => x.id === taskId); send('msg', m, t ? taskPred(t) : null); return m;
}
route('POST', '/api/messages', c => {
  const text = str(c.b.text, 1000, 'Message'), t = c.b.taskId && db.tasks.find(x => x.id === c.b.taskId);
  if (c.b.taskId && (!t || !visible(c.u, t))) bad(404, 'Task not found'); addMsg(c.u, text, t && t.id);
});

route('POST', '/api/inventory', c => { owner(c); const i = { id: uid(), name: str(c.b.name, 60, 'Item name'), status: 'Restocked', photo: null, hash: null }; db.inventory.push(i); send('inv', i); feed(`${c.u.name} added stock item "${i.name}"`, c.u.id); save(); return i; });
route('POST', '/api/inventory/:id/status', c => {
  owner(c); const i = db.inventory.find(x => x.id === c.p.id); if (!i || !['Empty', 'Ordered', 'Restocked'].includes(c.b.status)) bad(400, 'Bad request');
  i.status = c.b.status; send('inv', i); feed(`${i.name} marked ${i.status}`, c.u.id); save();
});
route('POST', '/api/inventory/:id/flag', c => {
  const i = db.inventory.find(x => x.id === c.p.id); if (!i) bad(404, 'Item not found');
  if (c.b.image) { const p = savePhoto(c.b.image); i.photo = p.photo; i.hash = p.hash; }
  i.status = 'Low'; send('inv', i); feed(`${c.u.name} flagged "${i.name}" as low${c.b.image ? ' with a photo' : ''}`, c.u.id); save();
});
route('GET', '/photo/:n', c => {
  if (!/^[a-f0-9]+\.jpg$/.test(c.p.n) || !fs.existsSync(path.join(UP, c.p.n))) bad(404, 'Not found');
  c.res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000' }); fs.createReadStream(path.join(UP, c.p.n)).pipe(c.res); return STREAM;
});

const IMGRE = /\.(jpe?g|png|webp|gif|avif)/i, PUB = path.join(__dirname, 'public'), imgDirs = [path.join(PUB, 'img'), PUB, __dirname, path.join(__dirname, 'img'), path.join(__dirname, 'images'), path.join(__dirname, 'assets')];
function findFile(name) { for (const d of imgDirs) { const fp = path.join(d, name); if (path.dirname(fp) === d && IMGRE.test(name) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp; } return null; }
function imageIndex() {
  const out = {};
  for (const d of imgDirs) { let ns = []; try { ns = fs.readdirSync(d); } catch {}
    for (const n of ns) { if (!IMGRE.test(n)) continue; const k = n.toLowerCase().replace(/\.(jpe?g|png|webp|gif|avif)/g, '').replace(/[^a-z0-9]/g, ''); if (/^(agro[1-7]|t[1-3])$/.test(k) && !out[k]) out[k] = '/img/' + encodeURIComponent(n); } }
  return out;
}
const sniff = b => b[0] === 0xFF && b[1] === 0xD8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.slice(0, 4).toString() === 'RIFF' ? 'image/webp' : b.slice(0, 3).toString() === 'GIF' ? 'image/gif' : b.slice(4, 12).toString().includes('avif') ? 'image/avif' : 'application/octet-stream';
route('GET', '/api/images', () => imageIndex(), false);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const STATIC_OK = /^\/[A-Za-z0-9_-]+\.(js|svg|webmanifest|ico|png|txt)$/;
const body = req => new Promise((ok, no) => { let n = 0, b = []; req.on('data', c => { n += c.length; if (n > 12e6) { no(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); } else b.push(c); }); req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b)) : {}); } catch { no(Object.assign(new Error('Bad JSON'), { status: 400 })); } }); });
const handler = async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('permissions-policy', 'camera=(self), geolocation=(self)');
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))); }
    if (p === '/healthz') return out(res, 200, { ok: true });
    if (req.method === 'GET' && STATIC_OK.test(p)) {
      const fp = path.join(PUB, p.slice(1));
      if (fs.existsSync(fp)) { res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-cache' }); return fs.createReadStream(fp).pipe(res); }
    }
    if (req.method === 'GET' && p === '/site.json') {
      const fp = path.join(PUB, 'site.json'); if (!fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); return fs.createReadStream(fp).pipe(res);
    }
    if (req.method === 'GET' && p.startsWith('/img/')) {
      let name = ''; try { name = decodeURIComponent(p.slice(5)); } catch {}
      const fp = name && findFile(name); if (!fp) { res.writeHead(404); return res.end(); }
      const hb = Buffer.alloc(16), fd = fs.openSync(fp, 'r'); fs.readSync(fd, hb, 0, 16, 0); fs.closeSync(fd);
      res.writeHead(200, { 'content-type': sniff(hb), 'cache-control': 'public, max-age=300' }); return fs.createReadStream(fp).pipe(res);
    }
    for (const [m, re, fn, auth] of R) {
      if (m !== req.method) continue; const mm = re.exec(p); if (!mm) continue;
      const sid = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ''), s = sid && db.sessions[sid[1]], u = s && s.exp > now() ? getU(s.uid) : null;
      if (auth && !u) return out(res, 401, { error: 'Sign in required' });
      const b = req.method === 'POST' ? await body(req) : {};
      const r = await fn({ req, res, u, b, p: mm.groups || {}, ip: req.socket.remoteAddress }); if (r === STREAM) return;
      let h = {}; if (r && r._cookie !== undefined) { const sec = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''; h['set-cookie'] = `sid=${r._cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${r._cookie ? 2592000 : 0}${sec}`; delete r._cookie; }
      return out(res, 200, r || { ok: true }, h);
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    out(res, 404, { error: 'Not found' });
  } catch (e) { out(res, e.status || 500, { error: e.status ? e.message : 'Server error' }); if (!e.status) console.error(e); }
};
const server = process.env.SSL_KEY && process.env.SSL_CERT ? https.createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, handler) : http.createServer(handler);
server.listen(PORT, () => {
  const proto = process.env.SSL_KEY ? 'https' : 'http';
  console.log(`AgroManage running\n  This computer: ${proto}://localhost:${PORT}`);
  for (const l of Object.values(os.networkInterfaces()).flat()) if (l.family === 'IPv4' && !l.internal) console.log(`  Same network: ${proto}://${l.address}:${PORT}`);
  const ix = imageIndex(), want = ['agro1', 'agro2', 'agro3', 'agro4', 'agro5', 'agro6', 'agro7', 't1', 't2', 't3'], miss = want.filter(k => !ix[k]);
  console.log(`  Pictures: ${want.length - miss.length} of ${want.length} found${miss.length ? ` (missing ${miss.join(', ')}; put them in public/img)` : ''}`);
  console.log(KEY ? '  AI review: on' : '  AI review: off (set ANTHROPIC_API_KEY to enable)');
});
