// Hollow Hours server: static game, WebSocket rooms, Google sign-in / guests, owner login monitor.
//
// Environment (all optional; without GOOGLE_CLIENT_ID the game runs with guests only):
//   GOOGLE_CLIENT_ID      OAuth "Web application" client ID (the same one Moonlit Werewolf uses is fine:
//                         add this site's URL to its Authorised JavaScript origins)
//   GOOGLE_CLIENT_SECRET  + GOOGLE_REFRESH_TOKEN  the owner connection, to keep the login record in a Google Sheet
//                         in the owner's Drive (scope drive.file). Without them the record is kept in memory only.
//   OWNER_EMAILS          comma-separated Google emails that may open /admin (the login monitor)
//   SESSION_SECRET        any long random string, so sign-ins survive a restart
//   ALLOW_GUESTS          "0" to require Google sign-in (default: guests allowed)
'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');

const PORT = +process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REFRESH = process.env.GOOGLE_REFRESH_TOKEN || '';
const OWNERS = (process.env.OWNER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ALLOW_GUESTS = process.env.ALLOW_GUESTS !== '0';
const SESSION_DAYS = 30;
const verifier = CLIENT_ID ? new OAuth2Client(CLIENT_ID) : null;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const isOwner = email => !!email && OWNERS.includes(String(email).toLowerCase());

// ── signed session cookie ──
function sign(obj) { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); }
function unsign(tok) {
  if (typeof tok !== 'string' || !tok.includes('.')) return null;
  const [b, mac] = tok.split('.'), want = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (!mac || mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
function cookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
const userOf = req => unsign(cookies(req).hh);
function setSession(res, user) {
  const tok = sign({ ...user, exp: Date.now() + SESSION_DAYS * 864e5 });
  res.setHeader('Set-Cookie', `hh=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.RENDER ? '; Secure' : ''}`);
}
const ipOf = req => clip((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress, 64);

// ── login record (memory + optional Google Sheet in the owner's Drive) ──
const LOG_KEEP = 2000, REVISIT_GAP = 30 * 60e3;
const HEADER = ['Time (UTC)', 'Event', 'Name', 'Email', 'Method', 'Room', 'Duration (min)', 'Device', 'IP'];
const log = [];                    // newest last: { at, ev, name, email, kind, room, mins, ua, ip }
const queue = [];                  // rows waiting to be appended to the sheet
const lastSeen = new Map();
const sheet = { status: CLIENT_ID && CLIENT_SECRET && REFRESH ? 'connecting' : 'memory', id: '', url: '', error: '' };
let owner = null;
function record(e) {
  e.at = e.at || Date.now(); log.push(e); if (log.length > LOG_KEEP) log.splice(0, log.length - LOG_KEEP);
  if (sheet.status !== 'memory') queue.push(e);
}
const rowOf = e => [new Date(e.at).toISOString().replace('T', ' ').slice(0, 19), e.ev, e.name, e.email || '', e.kind, e.room || '', e.mins ?? '', e.ua || '', e.ip || ''];
async function gapi(url, init = {}) {
  const { token } = await owner.getAccessToken();
  const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function connectSheet() {
  owner = new OAuth2Client(CLIENT_ID, CLIENT_SECRET); owner.setCredentials({ refresh_token: REFRESH });
  const q = encodeURIComponent("appProperties has { key='hollowhours' and value='logins' } and trashed = false");
  const f = await gapi(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
  sheet.id = f.files?.[0]?.id || '';
  if (!sheet.id) {
    sheet.id = (await gapi('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', body: JSON.stringify({ name: 'Hollow Hours — login record', mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: { hollowhours: 'logins' } }) })).id;
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/A1:I1?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [HEADER] }) });
  }
  sheet.url = `https://docs.google.com/spreadsheets/d/${sheet.id}`;
  // bring back the recent history so the monitor survives restarts
  const v = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/A2:I`);
  const rows = (v.values || []).slice(-LOG_KEEP), old = rows.map(r => ({ at: Date.parse(r[0] + 'Z') || 0, ev: r[1], name: r[2], email: r[3], kind: r[4], room: r[5], mins: r[6] === '' || r[6] === undefined ? undefined : +r[6], ua: r[7], ip: r[8] }));
  log.unshift(...old); if (log.length > LOG_KEEP) log.splice(0, log.length - LOG_KEEP);
  sheet.status = 'sheet'; console.log('[log] connected to sheet', sheet.id, 'with', old.length, 'earlier rows');
}
async function flush() {
  if (sheet.status !== 'sheet' || !queue.length) return;
  const batch = queue.splice(0, 500);
  try { await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/A:I:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values: batch.map(rowOf) }) }); sheet.error = ''; }
  catch (e) { sheet.error = e.message; console.error('[log] append failed:', e.message); queue.unshift(...batch); }
}
if (sheet.status === 'connecting') connectSheet().catch(e => { sheet.status = 'error'; sheet.error = e.message; console.error('[log] cannot open the sheet:', e.message); });
setInterval(() => flush().catch(() => {}), 20e3).unref();
const device = ua => { ua = String(ua || ''); const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other'; const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''; return (os + ' ' + br).trim(); };

// ── http ──
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/config', (req, res) => res.json({ clientId: CLIENT_ID, guests: ALLOW_GUESTS, user: publicUser(userOf(req)) }));
function publicUser(u) { return u ? { name: u.name, email: u.email || '', kind: u.kind, picture: u.picture || '', owner: isOwner(u.email) } : null; }
app.post('/api/login/google', async (req, res) => {
  if (!verifier) return res.status(400).json({ error: 'Google sign-in is not set up on this server.' });
  try {
    const t = await verifier.verifyIdToken({ idToken: String(req.body.credential || ''), audience: CLIENT_ID }), p = t.getPayload();
    if (!p || !p.email_verified) throw new Error('unverified');
    const user = { id: 'g' + p.sub, kind: 'google', email: p.email, name: clip(p.given_name || p.name || p.email.split('@')[0], 14), picture: p.picture || '' };
    setSession(res, user); record({ ev: 'login', name: user.name, email: user.email, kind: 'google', ua: device(req.headers['user-agent']), ip: ipOf(req) });
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(401).json({ error: 'Google sign-in failed. Try again.' }); }
});
app.post('/api/login/guest', (req, res) => {
  if (!ALLOW_GUESTS) return res.status(403).json({ error: 'Guest play is switched off. Sign in with Google.' });
  const name = clip(req.body.name, 14) || 'Guest' + Math.floor(100 + Math.random() * 900);
  const user = { id: 'u' + crypto.randomBytes(8).toString('hex'), kind: 'guest', email: '', name };
  setSession(res, user); record({ ev: 'login', name, email: '', kind: 'guest', ua: device(req.headers['user-agent']), ip: ipOf(req) });
  res.json({ user: publicUser(user) });
});
app.post('/api/logout', (req, res) => { const u = userOf(req); if (u) record({ ev: 'logout', name: u.name, email: u.email, kind: u.kind }); res.setHeader('Set-Cookie', 'hh=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.post('/api/name', (req, res) => { const u = userOf(req); if (!u) return res.status(401).end(); const name = clip(req.body.name, 14); if (name) { u.name = name; setSession(res, u); } res.json({ user: publicUser(u) }); });

// owner monitor
app.get('/api/admin', (req, res) => {
  const u = userOf(req); if (!u || !isOwner(u.email)) return res.status(403).json({ error: 'owners only' });
  const now = Date.now(), online = [...clients.values()].map(c => ({ name: c.presenceName || c.user.name, email: c.user.email, kind: c.user.kind, room: c.room, since: c.since, ua: c.ua, ip: c.ip, playing: c.playing }));
  const day = now - 864e5, week = now - 7 * 864e5, logins = log.filter(e => e.ev === 'login');
  const uniq = (arr) => new Set(arr.map(e => e.email || e.name)).size;
  res.json({ now, online, rooms: [...channels.keys()].filter(k => k).map(k => ({ code: k.replace(/^hh-/, ''), players: channels.get(k).size })),
    stats: { today: logins.filter(e => e.at > day).length, todayPlayers: uniq(logins.filter(e => e.at > day)), week: logins.filter(e => e.at > week).length, weekPlayers: uniq(logins.filter(e => e.at > week)), google: logins.filter(e => e.kind === 'google').length, guest: logins.filter(e => e.kind === 'guest').length },
    log: log.slice(-400).reverse(), sheet: { status: sheet.status, url: sheet.url, error: sheet.error, pending: queue.length }, guests: ALLOW_GUESTS });
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));

// ── rooms over WebSocket: presence channels with the same shape the game already uses ──
// client → { t:'join'|'leave', ch } | { t:'p', ch, d }      server → { t:'hello', id } | { t:'p', ch, id, d } | { t:'gone', ch, id } | { t:'snap', ch, peers:[{id,d}] }
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const channels = new Map();        // ch → Map(clientId → presence)
const clients = new Map();         // clientId → { ws, user, chans:Set, room, since, ... }
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function cast(ch, o, except) { const m = channels.get(ch); if (!m) return; const s = JSON.stringify(o); for (const id of m.keys()) { const c = clients.get(id); if (c && id !== except && c.ws.readyState === 1) c.ws.send(s); } }
function leave(c, ch) {
  const m = channels.get(ch); if (!m || !m.has(c.id)) return; m.delete(c.id); c.chans.delete(ch); if (!m.size && ch) channels.delete(ch);
  cast(ch, { t: 'gone', ch, id: c.id });
  if (ch && ch === c.roomCh) { record({ ev: 'left room', name: c.presenceName || c.user.name, email: c.user.email, kind: c.user.kind, room: c.room, mins: Math.round((Date.now() - c.roomSince) / 6e3) / 10 }); c.room = ''; c.roomCh = ''; }
}
wss.on('connection', (ws, req) => {
  const user = userOf(req); if (!user) { ws.close(4001, 'sign in first'); return; }
  const id = crypto.randomBytes(6).toString('hex'), c = { id, ws, user, chans: new Set(), room: '', roomCh: '', since: Date.now(), ua: device(req.headers['user-agent']), ip: ipOf(req), presenceName: '', playing: false, alive: true };
  clients.set(id, c); send(ws, { t: 'hello', id });
  const prev = lastSeen.get(user.id); if (!prev || Date.now() - prev > REVISIT_GAP) record({ ev: 'visit', name: user.name, email: user.email, kind: user.kind, ua: c.ua, ip: c.ip }); lastSeen.set(user.id, Date.now());
  let budget = 60; const refill = setInterval(() => { budget = Math.min(60, budget + 30); }, 1000);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', raw => {
    if (--budget < 0) return; let m; try { m = JSON.parse(raw); } catch { return; }
    const ch = typeof m.ch === 'string' ? m.ch.slice(0, 40) : null; if (ch === null) return;
    if (m.t === 'join') {
      if (c.chans.size >= 3 && !c.chans.has(ch)) return;
      if (!channels.has(ch)) channels.set(ch, new Map()); const map = channels.get(ch);
      if (ch && map.size >= 12 && !map.has(id)) { send(ws, { t: 'full', ch }); return; }
      map.set(id, null); c.chans.add(ch);
      send(ws, { t: 'snap', ch, peers: [...map].map(([pid, d]) => ({ id: pid, d })) });
      if (ch) { c.room = ch.replace(/^hh-/, ''); c.roomCh = ch; c.roomSince = Date.now(); record({ ev: 'joined room', name: user.name, email: user.email, kind: user.kind, room: c.room }); }
    } else if (m.t === 'leave') leave(c, ch);
    else if (m.t === 'p' && c.chans.has(ch)) {
      const d = m.d && typeof m.d === 'object' ? m.d : null; channels.get(ch).set(id, d);
      if (ch && d) { if (typeof d.n === 'string') c.presenceName = clip(d.n, 14); c.playing = !!(d.cfg && d.cfg.ph === 1); }
      cast(ch, { t: 'p', ch, id, d }, id);
    }
  });
  ws.on('close', () => { clearInterval(refill); for (const ch of [...c.chans]) leave(c, ch); clients.delete(id); lastSeen.set(user.id, Date.now()); });
});
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch {} } }, 25e3).unref();

server.listen(PORT, () => console.log(`Hollow Hours on :${PORT} — Google sign-in ${CLIENT_ID ? 'on' : 'off'}, guests ${ALLOW_GUESTS ? 'on' : 'off'}, owners: ${OWNERS.length}, record: ${sheet.status}`));
module.exports = { server };
