// Hollow Hours on its own server: sign-in gate + a room connector with the same interface the game uses inside Claude
// (window.claude.use('room') → channel with peers(), presence(), onPeers(), join(), leave()).
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let me = null, ws = null, myId = null, ready, setReady, cfg = null, retry = 0;
  ready = new Promise(r => { setReady = r; });
  const chans = new Map();              // name → channel
  const css = `
#gate{position:fixed;inset:0;z-index:50;display:flex;overflow-y:auto;background:#0d0c12}
#gate .gcol{margin:auto;width:100%;max-width:420px;padding:24px 18px;display:flex;flex-direction:column;gap:14px}
#gate h1{font-family:var(--display);font-weight:400;margin:0;font-size:clamp(46px,15vw,76px);line-height:.9;letter-spacing:.02em}
#gate h1 em{font-style:normal;color:var(--ember)}
#gate p{margin:0;line-height:1.4;color:var(--dim)}
#gate .or{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px;letter-spacing:.12em;text-transform:uppercase}
#gate .or:before,#gate .or:after{content:'';flex:1;height:1px;background:var(--line)}
#gate input{flex:1;min-width:0;background:var(--panel);border:1px solid var(--line);padding:12px;font-size:17px;font-weight:600;border-radius:0;color:var(--bone)}
#gate .err{color:var(--oxblood);font-weight:600;min-height:1.2em}
#gbtn{min-height:44px;display:flex;justify-content:center}
#who{position:fixed;right:10px;top:10px;z-index:30;display:flex;gap:6px;align-items:center;font-size:13px;font-weight:700;letter-spacing:.04em}
#who img{width:26px;height:26px;border-radius:50%}
#who a,#who button{border:1px solid var(--line);background:var(--panel);padding:6px 9px;color:var(--bone);text-decoration:none;text-transform:uppercase;font-size:11px;letter-spacing:.08em;cursor:pointer}`;
  function gate(msg) {
    if (!$('gateCss')) { const s = document.createElement('style'); s.id = 'gateCss'; s.textContent = css; document.head.append(s); }
    let g = $('gate'); if (g) g.remove();
    g = document.createElement('section'); g.id = 'gate'; g.setAttribute('role', 'dialog'); g.setAttribute('aria-modal', 'true'); g.setAttribute('aria-labelledby', 'gateTitle');
    g.innerHTML = `<div class="gcol"><h1 id="gateTitle">Hollow <em>Hours</em></h1><p>Sign in to play. Your name shows to the other players in your room.</p>
      ${cfg.clientId ? '<div id="gbtn"></div>' : ''}
      ${cfg.clientId && cfg.guests ? '<div class="or">or</div>' : ''}
      ${cfg.guests ? '<div style="display:flex;gap:8px"><input id="guestName" maxlength="14" placeholder="Guest name" aria-label="Guest name" autocomplete="off" spellcheck="false"><button class="ghost" id="guestBtn" type="button">Play as guest</button></div>' : ''}
      <p class="err" id="gateErr" role="alert"></p></div>`;
    document.body.append(g); $('gateErr').textContent = msg || '';
    if (cfg.guests) { $('guestBtn').onclick = guest; $('guestName').onkeydown = e => { if (e.key === 'Enter') guest(); }; }
    if (cfg.clientId) loadGis().then(() => {
      google.accounts.id.initialize({ client_id: cfg.clientId, callback: r => login('/api/login/google', { credential: r.credential }) });
      google.accounts.id.renderButton($('gbtn'), { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'signin_with', width: 300 });
    }).catch(() => { $('gateErr').textContent = 'Google sign-in could not load here.' + (cfg.guests ? ' You can still play as a guest.' : ''); });
  }
  function loadGis() { return window.google?.accounts?.id ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = res; s.onerror = rej; document.head.append(s); }); }
  function guest() { login('/api/login/guest', { name: $('guestName').value }); }
  async function login(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Sign-in failed.');
      signedIn(j.user);
    } catch (e) { if ($('gateErr')) $('gateErr').textContent = e.message; }
  }
  function signedIn(user) {
    me = user; const g = $('gate'); if (g) g.remove();
    const n = $('nameIn'); if (n && (!n.value || /^Wanderer\d*$/.test(n.value))) { n.value = user.name; n.dispatchEvent(new Event('change')); }
    badge(); connect();
  }
  function badge() {
    let w = $('who'); if (!w) { w = document.createElement('div'); w.id = 'who'; document.body.append(w); }
    w.textContent = '';
    if (me.picture) { const i = document.createElement('img'); i.src = me.picture; i.alt = ''; i.referrerPolicy = 'no-referrer'; w.append(i); }
    const n = document.createElement('span'); n.textContent = me.name + (me.kind === 'guest' ? ' (guest)' : ''); w.append(n);
    if (me.owner) { const a = document.createElement('a'); a.href = '/admin'; a.target = '_blank'; a.textContent = 'Monitor'; w.append(a); }
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Sign out';
    b.onclick = async () => { await fetch('/api/logout', { method: 'POST' }); try { google.accounts.id.disableAutoSelect(); } catch (e) {} location.reload(); };
    w.append(b);
    const tick = () => { const home = $('home'); w.hidden = !home || home.hidden; }; tick(); setInterval(tick, 300);
  }

  // ── socket ──
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hello') { myId = m.id; retry = 0; lobby.rejoin(); setReady(); return; }
      const c = chans.get(m.ch); if (!c) return;
      if (m.t === 'snap') { c.map.clear(); for (const p of m.peers) c.map.set(p.id, p.d); c.map.set(myId, c.mine); if (c.mine) c.push(); c.ok(true); }
      else if (m.t === 'p') { c.map.set(m.id, m.d); c.fire(); }
      else if (m.t === 'gone') { c.map.delete(m.id); c.fire(); }
      else if (m.t === 'full') c.ok(false);
    };
    ws.onclose = ev => {
      myId = null;
      for (const c of chans.values()) if (c.name) c.lose();
      if (ev.code === 4001) { gate('Your sign-in expired. Please sign in again.'); return; }
      setTimeout(connect, Math.min(8000, 800 * 2 ** retry++));
    };
  }
  const raw = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  function channel(name) {
    const c = {
      name, map: new Map(), mine: null, subs: new Set(), lost: new Set(), ok: () => {},
      peers() { return [...c.map].map(([id, d]) => ({ peer: id, kind: 'viewer', isMe: id === myId, sameTab: id === myId, presence: d })); },
      presence(d) { c.mine = d; if (myId) c.map.set(myId, d); c.push(); return Promise.resolve(); },
      push() { raw({ t: 'p', ch: name, d: c.mine }); },
      onPeers(cb, onLost) { c.subs.add(cb); if (onLost) c.lost.add(onLost); return () => { c.subs.delete(cb); if (onLost) c.lost.delete(onLost); }; },
      fire() { for (const f of c.subs) try { f(c.peers()); } catch (e) {} },
      lose() { chans.delete(name); const l = [...c.lost]; c.lost.clear(); for (const f of l) try { f(); } catch (e) {} },
      rejoin() { return new Promise(res => { c.ok = res; raw({ t: 'join', ch: name }); }); },
      async join(room) {
        if (!myId) throw new Error('offline');
        const r = channel(room); chans.set(room, r);
        if (!await r.rejoin()) { chans.delete(room); throw new Error('room full'); }
        return r;
      },
      async leave() { raw({ t: 'leave', ch: name }); chans.delete(name); c.lost.clear(); c.subs.clear(); }
    };
    return c;
  }
  const lobby = channel(''); chans.set('', lobby);

  window.claude = { use: async kind => { if (kind !== 'room') return null; await ready; return lobby; } };
  fetch('/api/config').then(r => r.json()).then(j => { cfg = j; if (j.user) signedIn(j.user); else gate(); })
    .catch(() => { cfg = { clientId: '', guests: true }; gate('The server could not be reached. Refresh to try again.'); });
})();
