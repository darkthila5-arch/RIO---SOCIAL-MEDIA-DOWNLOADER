/* Contact the admin. Anonymous: a message becomes a "ticket" whose secret is kept only in this browser (localStorage), so only
   this browser can read the admin's replies. No account, email or IP address is stored.
   window.RioReport = { open(view), check(force) } */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CATS = { problem: 'Problem', idea: 'Idea', other: 'Other' };
  const MAX = 1000;
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } }
  };
  const tickets = () => store.get('rio_reports', []).filter((t) => t && t.id && t.secret).slice(0, 10);
  const E2E = window.RioE2E;
  const LOCKED = '🔒 This message cannot be opened on this device (the key is kept only in the browser that sent it).';
  const keyCache = {};
  let adminPubCache = { at: 0, pub: '' };
  // the admin's public key ('' = encryption is not switched on yet). Fresh every few minutes.
  async function adminPub() {
    if (Date.now() - adminPubCache.at < 120000) return adminPubCache.pub;
    try {
      const res = await fetch('/api/e2e/pub', { cache: 'no-store' });
      const j = res.ok ? await res.json() : null;
      if (j) adminPubCache = { at: Date.now(), pub: j.pub || '' };
    } catch { /* offline: keep the last known key */ }
    return adminPubCache.pub;
  }
  // replace every encrypted message with its text (decrypted here, in this browser)
  async function plainItems(items) {
    const out = [];
    for (const it of items) {
      const tk = tickets().find((q) => q.id === it.id);
      const msgs = [];
      for (const m of it.msgs) {
        if (!m.e) { msgs.push(m); continue; }
        let text = LOCKED;
        try {
          if (tk && tk.priv && E2E) {
            keyCache[tk.id] = keyCache[tk.id] || await E2E.importPriv(tk.priv);
            // the proof is checked against the admin key saved when this conversation began, never against what the server says now
            const proof = tk.apub ? await E2E.verify(m.text, keyCache[tk.id], tk.apub, m.by === 'admin' ? 'a' : 'u') : 'none';
            if (proof === 'bad') text = '⚠️ This message could not be verified, so it is hidden.';
            else text = (await E2E.decrypt(m.text, keyCache[tk.id], tk.pub)) + (proof === 'none' ? '  (not verified)' : '');
          }
        } catch { /* wrong device or damaged */ }
        msgs.push({ ...m, text });
      }
      out.push({ ...it, msgs });
    }
    return out;
  }
  const saveTickets = (list) => store.set('rio_reports', list.slice(0, 10));
  const seenMap = () => store.get('rio_report_seen', {});
  const adminCount = (t) => t.msgs.filter((m) => m.by === 'admin').length;

  let data = [];           // last status from the server (only this browser's tickets)
  let modal = null;
  let lastCheck = 0;
  let checking = null;

  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    let j = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((j && j.error) || 'Something went wrong. Try again.');
    return j;
  }
  // the browser's push address, only if the visitor turned notifications on (so the reply can come as a notification, to them only)
  async function endpoint() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return '';
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 1500))]);
      const sub = reg && (await reg.pushManager.getSubscription());
      return sub ? sub.endpoint : '';
    } catch { return ''; }
  }

  /* ---------- status / unread ---------- */
  function unreadCount() { const seen = seenMap(); return data.filter((t) => adminCount(t) > (seen[t.id] || 0)).length; }
  function paintEntry() {
    const mine = $('supMine'), dot = $('supDot');
    if (!mine) return;
    mine.hidden = tickets().length === 0;
    const n = unreadCount();
    dot.hidden = n === 0; dot.textContent = n ? String(n) : '';
  }
  function markSeen() {
    const seen = seenMap();
    data.forEach((t) => { seen[t.id] = adminCount(t); });
    store.set('rio_report_seen', seen);
    paintEntry();
  }
  async function check(force) {
    const list = tickets();
    if (!list.length) { data = []; paintEntry(); return; }
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    checking = (async () => {
      try {
        const res = await post('/api/report/status', { tickets: list.map(({ id, secret }) => ({ id, secret })) });
        const gone = res.items.filter((i) => i.gone).map((i) => i.id);
        if (gone.length) saveTickets(tickets().filter((t) => !gone.includes(t.id)));
        const before = unreadCount();
        data = (await plainItems(res.items.filter((i) => !i.gone))).sort((a, b) => (b.msgs[b.msgs.length - 1].ts).localeCompare(a.msgs[a.msgs.length - 1].ts));
        paintEntry();
        const n = unreadCount();
        if (modal) { markSeen(); if (modal.view === 'list') modal.render(); }
        else if (n > before || (force && n > 0 && before === 0)) announce();
      } catch { /* offline or limited: try again later */ }
      finally { checking = null; }
    })();
    return checking;
  }
  function announce() {
    const seen = seenMap();
    const t = data.find((x) => adminCount(x) > (seen[x.id] || 0));
    if (!t || !window.RioNews || window.RioNews.isOpen()) return;
    const reply = [...t.msgs].reverse().find((m) => m.by === 'admin');
    window.RioNews.show({ title: 'The admin replied to you', text: reply ? reply.text.slice(0, 200) : '', kind: 'notice', cta: 'Read reply' }, { action: () => open('list') });
  }

  /* ---------- the window ---------- */
  function closeModal() {
    if (!modal) return;
    const { root, onKey, prev } = modal;
    modal = null;
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('on'); root.classList.add('out');
    const done = () => { root.remove(); document.documentElement.classList.remove('news-lock'); try { prev && prev.focus && prev.focus({ preventScroll: true }); } catch { /* ignore */ } };
    if (reduce) done(); else setTimeout(done, 260);
  }

  function open(view) {
    if (modal) closeModal();
    if (window.RioNews && window.RioNews.isOpen()) window.RioNews.close();
    const root = make('div', 'npop'), card = make('div', 'npop-card rep-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'repTitle');
    const x = make('button', 'npop-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    const title = make('h2', 'rep-title', ''); title.id = 'repTitle';
    const tabs = make('div', 'rep-tabs'); tabs.setAttribute('role', 'tablist');
    const tNew = make('button', 'rep-tab', 'New message'), tMine = make('button', 'rep-tab', 'My messages');
    [tNew, tMine].forEach((b) => { b.type = 'button'; b.setAttribute('role', 'tab'); });
    tabs.append(tNew, tMine);
    const body = make('div', 'rep-body');
    card.append(x, title, tabs, body); root.append(card);

    const m = { root, prev: document.activeElement, view: '', render: () => {}, onKey: null };
    m.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(); return; }
      if (e.key !== 'Tab') return;
      const f = [...card.querySelectorAll('button, textarea, input')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    modal = m;
    document.addEventListener('keydown', m.onKey, true);
    x.addEventListener('click', closeModal);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) closeModal(); });

    function show(v, opts = {}) {
      m.view = v;
      tNew.setAttribute('aria-selected', String(v === 'new')); tMine.setAttribute('aria-selected', String(v === 'list'));
      tMine.hidden = tickets().length === 0;
      tabs.hidden = tMine.hidden;
      title.textContent = v === 'new' ? 'Message the admin' : 'My messages';
      m.render = () => (v === 'new' ? renderNew(body, show) : renderList(body, show, opts));
      m.render();
    }
    tNew.addEventListener('click', () => show('new'));
    tMine.addEventListener('click', () => { show('list'); markSeen(); });

    document.body.append(root);
    document.documentElement.classList.add('news-lock');
    show(view === 'list' && tickets().length ? 'list' : 'new');
    if (m.view === 'list') { markSeen(); check(true); }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.add('on');
      const f = card.querySelector('textarea'); try { (f || x).focus({ preventScroll: true }); } catch { /* ignore */ }
    }));
  }

  function renderNew(body, show) {
    body.replaceChildren();
    const chips = make('div', 'rep-chips'); chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-label', 'What is it about?');
    Object.keys(CATS).forEach((k, i) => {
      const l = make('label', 'chip'), r = make('input'); r.type = 'radio'; r.name = 'repCat'; r.value = k; if (!i) r.checked = true;
      l.append(r, make('span', '', ({ problem: '🛠 ', idea: '💡 ', other: '💬 ' })[k] + CATS[k])); chips.append(l);
    });
    const ta = make('textarea', 'rep-text'); ta.maxLength = MAX; ta.rows = 5; ta.placeholder = 'Tell the admin what happened or what you want. Do not write passwords or private details.';
    ta.setAttribute('aria-label', 'Your message');
    const count = make('small', 'rep-count', '0 / ' + MAX);
    ta.addEventListener('input', () => { count.textContent = ta.value.length + ' / ' + MAX; });
    const note = make('p', 'rep-note', 'Only the admin can read this. The reply appears here on this device (My messages).');
    Promise.all([endpoint(), adminPub()]).then(([ep, ap]) => {
      note.textContent = (ap ? '🔒 End-to-end encrypted: only you and the admin can read this, not even the server. ' : 'Only the admin can read this. ')
        + (ep ? 'You turned notifications on, so you will get a notification when the admin replies.' : 'The reply appears here on this device (My messages).');
    });
    const status = make('p', 'status', ''); status.setAttribute('role', 'status');
    const send = make('button', 'primary', 'Send message'); send.type = 'button';
    send.addEventListener('click', async () => {
      const message = ta.value.trim();
      if (message.length < 3) { status.textContent = 'Write a few words first.'; status.className = 'status error'; ta.focus(); return; }
      send.disabled = true; send.classList.add('busy'); status.textContent = 'Sending...'; status.className = 'status';
      try {
        const cat = (body.querySelector('input[name=repCat]:checked') || {}).value || 'other';
        const ap = await adminPub();
        let r, mine = {};
        if (ap) {
          if (!E2E || !E2E.supported) throw new Error('This browser cannot encrypt messages. Open the site in an up-to-date browser (it must be https).');
          const pair = await E2E.newKeyPair();       // a new key pair for this conversation only
          const pub = await E2E.exportPub(pair.publicKey);
          const sealed = await E2E.encrypt(message, [ap, pub], { priv: pair.privateKey, peerPub: ap, role: 'u' });
          r = await post('/api/report', { message: sealed, enc: true, vpub: pub, cat, endpoint: await endpoint() });
          mine = { priv: await E2E.exportPriv(pair.privateKey), pub, apub: ap };
        } else {
          r = await post('/api/report', { message, cat, endpoint: await endpoint() });
        }
        saveTickets([{ id: r.id, secret: r.secret, ...mine }, ...tickets()]);
        const seen = seenMap(); seen[r.id] = 0; store.set('rio_report_seen', seen);
        lastCheck = 0; await check(true);
        show('list', { open: r.id, sent: true });
      } catch (e) { status.textContent = e.message; status.className = 'status error'; send.disabled = false; send.classList.remove('busy'); }
    });
    body.append(chips, ta, count, note, status, send);
  }

  function renderList(body, show, opts) {
    body.replaceChildren();
    if (opts.sent) body.append(make('p', 'rep-ok', '✓ Sent. The admin will reply here. Come back to this page to read it.'));
    if (!data.length) { body.append(make('p', 'rep-note', tickets().length ? 'Loading...' : 'You have not sent any messages yet.')); return; }
    data.forEach((t, i) => {
      const last = t.msgs[t.msgs.length - 1];
      const waiting = last.by === 'user';
      const box = make('div', 'rep-item'), head = make('button', 'rep-head');
      head.type = 'button';
      const state = t.status === 'closed' ? 'Closed' : (waiting ? 'Waiting for the admin' : 'Admin replied');
      const top = make('span', 'rep-top'); top.append(make('b', '', CATS[t.cat] || 'Message'), make('em', waiting || t.status === 'closed' ? '' : 'on', state));
      head.append(top, make('span', 'rep-prev', t.msgs[0].text), make('small', '', when(last.ts)));
      const thread = make('div', 'rep-thread');
      const tkc = tickets().find((q) => q.id === t.id);
      if (tkc && tkc.apub && E2E) {
        const code = make('p', 'rep-note', '🔒 End-to-end encrypted. Admin security code: ');
        const num = make('b', 'rep-code', '…'); code.append(num);
        E2E.fingerprint(tkc.apub).then((f) => { num.textContent = f; }).catch(() => {});
        thread.append(code);
      }
      t.msgs.forEach((mm) => {
        const b = make('div', 'rep-msg ' + mm.by);
        b.append(make('span', 'rep-by', mm.by === 'admin' ? 'RIO admin' : 'You'), make('p', '', mm.text), make('small', '', when(mm.ts)));
        thread.append(b);
      });
      const ta = make('textarea', 'rep-text'); ta.maxLength = MAX; ta.rows = 2; ta.placeholder = 'Write a reply to the admin'; ta.setAttribute('aria-label', 'Reply to the admin');
      const st = make('p', 'status', ''); st.setAttribute('role', 'status');
      const btn = make('button', 'mini', 'Send reply'); btn.type = 'button';
      btn.addEventListener('click', async () => {
        const message = ta.value.trim();
        if (!message) return;
        btn.disabled = true; st.textContent = 'Sending...'; st.className = 'status';
        try {
          const tk = tickets().find((q) => q.id === t.id);
          let body = { secret: tk && tk.secret, message, endpoint: await endpoint() };
          if (tk && tk.priv) {   // an encrypted conversation: the reply is encrypted too
            const now = await adminPub();
            if (now && tk.apub && now !== tk.apub) throw new Error('The admin\'s security code has changed, so this conversation is closed for your safety. Please send a new message.');
            const ap = tk.apub || now;
            if (!ap) throw new Error('Could not get the encryption key. Try again.');
            keyCache[tk.id] = keyCache[tk.id] || await E2E.importPriv(tk.priv);
            body = { ...body, message: await E2E.encrypt(message, [ap, tk.pub], { priv: keyCache[tk.id], peerPub: ap, role: 'u' }), enc: true };
          }
          await post(`/api/report/${encodeURIComponent(t.id)}/reply`, body);
          lastCheck = 0; await check(true); show('list', { open: t.id });
        } catch (e) { st.textContent = e.message; st.className = 'status error'; btn.disabled = false; }
      });
      thread.append(ta, st, btn);
      const isOpen = opts.open ? opts.open === t.id : i === 0;
      box.classList.toggle('open', isOpen); head.setAttribute('aria-expanded', String(isOpen));
      head.addEventListener('click', () => { const o = box.classList.toggle('open'); head.setAttribute('aria-expanded', String(o)); });
      box.append(head, thread); body.append(box);
    });
  }

  /* ---------- entry points ---------- */
  window.RioReport = { open, check };
  function init() {
    const n = $('supNew'), mine = $('supMine');
    if (n) n.addEventListener('click', () => open('new'));
    if (mine) mine.addEventListener('click', () => open('list'));
    paintEntry();
    let deep = false;
    try {
      const u = new URL(location.href);
      deep = u.searchParams.has('report');
      if (deep) { u.searchParams.delete('report'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
    } catch { /* ignore */ }
    if (deep && tickets().length) setTimeout(() => open('list'), 300);
    else if (tickets().length) setTimeout(() => check(true), 1800);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
