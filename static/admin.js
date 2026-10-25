(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const whole = new Intl.NumberFormat('en');
  const NAMES = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', pinterest: 'Pinterest', telegram: 'Telegram', spotify: 'Spotify' };
  const KINDS = { news: 'News', update: 'Update', feature: 'New feature', notice: 'Notice' };
  const kindValue = () => (document.querySelector('input[name=nKind]:checked') || {}).value || 'news';
  let token = '';
  try { token = sessionStorage.getItem('rio_admin') || ''; } catch { /* private mode */ }
  let timer = 0;

  function setMsg(el, text, bad) { el.textContent = text; el.className = 'status' + (bad ? ' error' : ''); }
  async function call(path, method = 'GET', body) {
    const res = await fetch(path, {
      method, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) { const e = new Error((data && data.error) || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }
  const n = (v) => whole.format(v || 0);
  /* bytes -> "1.25 GB" / "340 MB" / "12 KB" (1 GB = 1024 MB) */
  const gb = (b) => {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(b >= 107374182400 ? 1 : 2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  };
  const stat = (num, label, sub) => `<div class="a-stat"><b>${n(num)}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const statText = (text, label, sub) => `<div class="a-stat"><b>${text}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const el = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };

  function render(d) {
    $('aDay').textContent = 'Today: ' + d.today;
    $('warnTemp').hidden = d.persistent;
    $('cards').innerHTML =
      stat(d.downloads_total, 'Downloads', `${n(d.downloads_today)} today`) +
      statText(gb(d.bytes_total), 'Data downloaded', `${gb(d.bytes_today)} today · ${gb(d.bytes_7d)} in 7 days`) +
      stat(d.visits_today, 'Visits today', `${n(d.visits_7d)} in 7 days`) +
      stat(d.new_visitors, 'New visitors', `${n(d.new_web)} web · ${n(d.new_app)} app`) +
      stat(d.installs, 'App installs', `${n(d.installs_today)} today`) +
      statText(d.formats.length ? (d.formats[0].fmt === 'other' ? 'Other' : d.formats[0].fmt.toUpperCase()) : '-', 'Biggest format', d.formats.length ? gb(d.formats[0].bytes) : 'no data yet') +
      stat(d.web_total, 'Web visits (total)') + stat(d.app_total, 'App opens (total)') +
      stat(d.push.subscribers == null ? 0 : d.push.subscribers, 'Notification subscribers', d.push.configured ? 'ready to send' : 'not set up') +
      stat(Object.values(d.platforms).reduce((a, p) => a + p.lookups_fail + p.job_fail, 0), 'Failures', 'lookups + downloads');

    const all = d.web_total + d.app_total;
    $('splitApp').style.width = (all ? Math.round((d.app_total / all) * 100) : 0) + '%';
    $('splitText').textContent = all ? `${Math.round((d.app_total / all) * 100)}% of visits come from the installed app, ${100 - Math.round((d.app_total / all) * 100)}% from the web.` : 'No visits counted yet.';

    $('plats').replaceChildren(...Object.keys(d.platforms).map((k) => {
      const p = d.platforms[k], tr = document.createElement('tr');
      [NAMES[k] || k, n(p.downloads), gb(p.bytes), n(p.lookups_ok), n(p.lookups_fail), n(p.job_fail)].forEach((t) => tr.appendChild(el('td', t)));
      return tr;
    }));

    const fmtTotal = d.formats.reduce((a, f) => a + f.bytes, 0);
    $('fmts').replaceChildren(...(d.formats.length ? d.formats.map((f) => {
      const tr = document.createElement('tr');
      [f.fmt === 'other' ? 'Other' : f.fmt.toUpperCase(), n(f.files), gb(f.bytes), (fmtTotal ? Math.round((f.bytes / fmtTotal) * 100) : 0) + '%', f.files ? gb(f.bytes / f.files) : '-']
        .forEach((t) => tr.appendChild(el('td', t)));
      return tr;
    }) : [(() => { const tr = document.createElement('tr'); const td = el('td', 'No downloads counted yet.'); td.colSpan = 5; tr.appendChild(td); return tr; })()]));

    const max = Math.max(1, ...d.days.map((x) => Math.max(x.downloads, x.web + x.app)));
    const maxB = Math.max(1, ...d.days.map((x) => x.bytes));
    $('chart').replaceChildren(...d.days.map((x) => {
      const col = document.createElement('div'); col.className = 'a-col'; col.title = `${x.day}: ${x.downloads} downloads (${gb(x.bytes)}), ${x.web + x.app} visits`;
      const bars = document.createElement('div'); bars.className = 'a-bars';
      [['b1', x.downloads / max], ['b2', (x.web + x.app) / max], ['b3', x.bytes / maxB]].forEach(([c, v]) => { const i = document.createElement('i'); i.className = c; i.style.height = v * 100 + '%'; bars.appendChild(i); });
      col.append(bars, el('span', x.day.slice(8)));
      return col;
    }));

    $('newsList').replaceChildren(...(d.news.length ? d.news : []).map((it) => {
      const row = document.createElement('div'); row.className = 'a-item';
      const txt = document.createElement('div'); txt.append(el('span', KINDS[it.kind] || 'News', 'a-kind'), el('b', it.title), el('small', it.text || (it.url ? it.url : '')));
      if (it.img) { const th = document.createElement('img'); th.className = 'a-thumb'; th.alt = ''; th.src = '/news-img/' + it.id; txt.append(th); }
      const st = document.createElement('div'); st.className = 'a-stats';
      [`👁 ${n(it.views)} viewed`, `👆 ${n(it.clicks)} tapped the button${it.views ? ' (' + it.ctr + '%)' : ''}`, `🔔 ${n(it.push_opens)} opened from notification`]
        .forEach((t) => st.append(el('span', t)));
      txt.append(st);
      const del = el('button', 'Delete', 'mini'); del.type = 'button';
      del.addEventListener('click', async () => { del.disabled = true; try { await call('/admin/api/news/' + it.id, 'DELETE'); load(); } catch (e) { setMsg($('newsMsg'), e.message, true); del.disabled = false; } });
      row.append(txt, del);
      return row;
    }));

    const last = d.push.last;
    $('pushInfo').textContent = !d.push.configured ? 'Notifications are not set up yet: add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_EMAIL on Render (see README).'
      : `${n(d.push.subscribers)} subscribers.` + (last ? (last.running ? ' Sending...' : ` Last send: ${last.ok} delivered, ${last.fail} failed, ${last.gone} removed (${last.at.replace('T', ' ')} UTC).`) : '');
  }


  /* ---------- end-to-end encryption (keys and passphrase never leave this browser) ---------- */
  const E2E = window.RioE2E, SKEY = 'rio_admin_jwk';
  let e2eRec = null, adminKey = null, e2eLoaded = false, resetting = false;
  async function loadE2E() {
    try { e2eRec = (await call('/admin/api/e2e')).record; } catch { return; }
    e2eLoaded = true;
    if (!e2eRec) adminKey = null;
    else if (!adminKey && E2E && E2E.supported) {
      try {
        const j = JSON.parse(sessionStorage.getItem(SKEY) || 'null');
        if (j && j.pub === e2eRec.pub) adminKey = { priv: await E2E.importPriv(j.jwk), pub: e2eRec.pub };
      } catch { /* locked */ }
    }
    paintE2E();
  }
  function paintE2E() {
    const rec = e2eRec, open = !!adminKey;
    $('e2eSetup').hidden = !(resetting || !rec); $('e2eLock').hidden = !(rec && !open && !resetting);
    $('e2eOpen').hidden = !(rec && open && !resetting); $('e2eReset').hidden = !(rec && !open && !resetting);
    $('e2eInfo').textContent = !E2E || !E2E.supported ? 'This browser cannot do encryption (it needs https). Open the admin page on the https address.'
      : resetting ? 'Choose a new passphrase. Old messages stay scrambled and can no longer be read.'
      : !rec ? 'Not on yet. Choose a passphrase: new messages are then locked in the visitor\'s browser and only you can open them. Write the passphrase down: it cannot be recovered.'
      : open ? 'On. Messages are decrypted here in your browser.' : 'On, but locked. Enter your passphrase to read and answer messages.';
    if (rec && E2E) E2E.fingerprint(rec.pub).then((f) => { $('e2eFp').textContent = f; }).catch(() => {});
  }
  function keepKey(jwk, pub) { try { sessionStorage.setItem(SKEY, JSON.stringify({ jwk, pub })); } catch { /* ignore */ } }
  function forgetKey() { adminKey = null; try { sessionStorage.removeItem(SKEY); } catch { /* ignore */ } }
  async function decryptItems(items) {
    const out = [];
    for (const it of items) {
      const msgs = [];
      for (const m of it.msgs) {
        if (!m.e) { msgs.push(m); continue; }
        let text = '🔒 Locked. Unlock your key above to read this message.';
        if (adminKey) {
          try {
            const proof = it.vpub ? await E2E.verify(m.text, adminKey.priv, it.vpub, m.by === 'admin' ? 'a' : 'u') : 'none';
            if (proof === 'bad') text = '⚠️ This message could not be verified (it may have been changed on the server), so it is hidden.';
            else text = (await E2E.decrypt(m.text, adminKey.priv, adminKey.pub)) + (proof === 'none' ? '  (not verified)' : '');
          } catch { text = '🔒 This message cannot be decrypted (it was made for a different key).'; }
        }
        msgs.push({ ...m, text });
      }
      out.push({ ...it, msgs });
    }
    return out;
  }
  $('e2eSetup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('e2ePass1').value, b = $('e2ePass2').value;
    if (a.length < 12) return setMsg($('e2eMsg'), 'Use at least 12 characters (a few random words is best).', true);
    if (a !== b) return setMsg($('e2eMsg'), 'The two passphrases are not the same.', true);
    $('e2eSetupBtn').disabled = true; setMsg($('e2eMsg'), 'Creating your key...');
    try {
      const { record, jwk } = await E2E.wrapAdminKey(a);
      await call('/admin/api/e2e', 'PUT', { ...record, replace: resetting });
      e2eRec = record; adminKey = { priv: await E2E.importPriv(jwk), pub: record.pub }; keepKey(jwk, record.pub);
      resetting = false; $('e2ePass1').value = ''; $('e2ePass2').value = '';
      setMsg($('e2eMsg'), 'Encryption is on. New messages are now end-to-end encrypted.');
      paintE2E(); repSig = ''; load();
    } catch (err) { setMsg($('e2eMsg'), err.message, true); }
    $('e2eSetupBtn').disabled = false;
  });
  $('e2eLock').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg($('e2eMsg'), 'Unlocking...');
    try {
      const jwk = await E2E.unwrapAdminKey(e2eRec, $('e2ePass').value);
      adminKey = { priv: await E2E.importPriv(jwk), pub: e2eRec.pub }; keepKey(jwk, e2eRec.pub);
      $('e2ePass').value = ''; setMsg($('e2eMsg'), ''); paintE2E(); repSig = ''; load();
    } catch { setMsg($('e2eMsg'), 'Wrong passphrase.', true); }
  });
  $('e2eLockBtn').addEventListener('click', () => { forgetKey(); setMsg($('e2eMsg'), 'Locked.'); paintE2E(); repSig = ''; load(); });
  $('e2eReset').addEventListener('click', () => {
    if (!confirm('Start over with a new key? Every message already sent stays scrambled and can never be read again.')) return;
    resetting = true; paintE2E();
  });

  /* ---------- messages from users ---------- */
  const CATN = { problem: 'Problem', idea: 'Idea', other: 'Other' };
  const openRep = new Set(), drafts = {};
  let repSig = '';
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  async function renderReports(rawItems, force) {
    const sig = JSON.stringify(rawItems) + (adminKey ? '|open' : '|locked');
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#repList') && document.activeElement.tagName === 'TEXTAREA';
    if (!force && (sig === repSig || typing)) return;
    repSig = sig;
    const items = await decryptItems(rawItems);
    const fresh = items.filter((t) => t.new).length;
    $('repBadge').hidden = !fresh; $('repBadge').textContent = fresh + ' new';
    document.title = (fresh ? `(${fresh}) ` : '') + 'Admin | RIO Downloader';
    if (!items.length) { $('repList').replaceChildren(el('p', 'No messages yet.', 'a-muted')); return; }
    $('repList').replaceChildren(...items.map((t) => {
      const box = document.createElement('div'); box.className = 'a-rep' + (t.new ? ' new' : '') + (openRep.has(t.id) ? ' open' : '');
      const head = document.createElement('button'); head.type = 'button'; head.className = 'a-rep-head';
      const top = document.createElement('div'); top.className = 'a-rep-top';
      const lastBy = t.msgs[t.msgs.length - 1].by;
      const tag = el('span', t.status === 'closed' ? 'Closed' : (t.new ? 'New' : (lastBy === 'admin' ? 'Replied' : 'Open')), 'a-tag' + (t.new ? ' on' : ''));
      top.append(el('b', `${CATN[t.cat] || 'Message'} · ${when(t.last)}`), tag);
      head.append(top, el('span', t.msgs[0].text, 'a-rep-prev'));
      const body = document.createElement('div'); body.className = 'a-rep-body';
      t.msgs.forEach((m) => { const b = document.createElement('div'); b.className = 'a-msg ' + m.by; b.append(el('span', m.by === 'admin' ? 'You (admin)' : 'User', 'a-by'), el('p', m.text), el('small', when(m.ts))); body.appendChild(b); });
      const ta = document.createElement('textarea'); ta.rows = 3; ta.maxLength = 1000; ta.placeholder = 'Write your reply (only this user will see it)'; ta.value = drafts[t.id] || '';
      ta.addEventListener('input', () => { drafts[t.id] = ta.value; });
      const send = el('button', 'Send reply', 'primary'); send.type = 'button';
      const close = el('button', t.status === 'closed' ? 'Reopen' : 'Mark as done', 'mini'); close.type = 'button';
      const del = el('button', 'Delete', 'mini'); del.type = 'button';
      const act = async (fn) => { try { await fn(); } catch (e) { setMsg($('repMsg'), e.message, true); } };
      send.addEventListener('click', () => act(async () => {
        if (!ta.value.trim()) return;
        send.disabled = true; setMsg($('repMsg'), 'Sending...');
        let payload = { text: ta.value };
        if (t.vpub) {   // an encrypted conversation: lock the reply for the visitor (and for you, so you can re-read it)
          if (!adminKey) throw new Error('Unlock your key first (above).');
          payload = { text: await E2E.encrypt(ta.value.trim(), [t.vpub, adminKey.pub], { priv: adminKey.priv, peerPub: t.vpub, role: 'a' }), enc: true };
        }
        const r = await call(`/admin/api/reports/${t.id}/reply`, 'POST', payload);
        drafts[t.id] = ''; setMsg($('repMsg'), r.pushed ? 'Reply sent. The user also gets a notification.' : 'Reply sent. The user will see it next time they open the site or app.');
        load();
      }).finally(() => { send.disabled = false; }));
      close.addEventListener('click', () => act(async () => { await call(`/admin/api/reports/${t.id}/status`, 'POST', { status: t.status === 'closed' ? 'open' : 'closed' }); load(); }));
      del.addEventListener('click', () => act(async () => { if (!confirm('Delete this conversation? The user will no longer see it.')) return; await call('/admin/api/reports/' + t.id, 'DELETE'); openRep.delete(t.id); load(); }));
      const acts = document.createElement('div'); acts.className = 'a-rep-actions'; acts.append(send, close, del);
      body.append(ta, acts);
      head.addEventListener('click', () => {
        const o = box.classList.toggle('open');
        if (o) { openRep.add(t.id); if (t.new) { t.new = false; box.classList.remove('new'); call(`/admin/api/reports/${t.id}/read`, 'POST').then(load).catch(() => {}); } } else openRep.delete(t.id);
      });
      box.append(head, body);
      return box;
    }));
  }

  function showLogin(msg) {
    clearInterval(timer);
    $('login').hidden = false; $('dash').hidden = true; $('logout').hidden = true;
    if (msg) setMsg($('loginMsg'), msg, true);
  }
  async function load() {
    try {
      const d = await call('/admin/api/stats');
      $('login').hidden = true; $('dash').hidden = false; $('logout').hidden = false;
      render(d);
      if (!e2eLoaded) await loadE2E();
      try { renderReports((await call('/admin/api/reports')).items); } catch { /* shown on the next refresh */ }
    } catch (e) {
      if (e.status === 401 || e.status === 429) { token = ''; try { sessionStorage.removeItem('rio_admin'); } catch { /* ignore */ } showLogin(e.message); }
      else if (!$('dash').hidden) setMsg($('newsMsg'), e.message, true);
      else showLogin(e.message);
    }
  }
  function start() { load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 15000); }

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('pw').value;
    try { sessionStorage.setItem('rio_admin', token); } catch { /* ignore */ }
    $('pw').value = '';
    setMsg($('loginMsg'), 'Checking...');
    start();
  });
  $('logout').addEventListener('click', () => { forgetKey(); e2eLoaded = false; e2eRec = null; token = ''; try { sessionStorage.removeItem('rio_admin'); } catch { /* ignore */ } showLogin(''); setMsg($('loginMsg'), ''); });

  /* ---------- news picture (shrunk in the browser to about 100 KB) and button colours ---------- */
  let newsImg = '';
  const clearImg = () => { newsImg = ''; $('nImg').value = ''; $('nImgUrl').value = ''; $('nImgView').hidden = true; $('nImgAdd').hidden = false; };
  const showImg = (uri) => {
    newsImg = uri;
    $('nImgThumb').src = uri; $('nImgInfo').textContent = Math.round(uri.length * 0.75 / 1024) + ' KB';
    $('nImgView').hidden = false; $('nImgAdd').hidden = true; setMsg($('newsMsg'), '');
  };
  async function fromLink() {
    const u = $('nImgUrl').value.trim();
    if (!/^https:\/\//i.test(u)) { setMsg($('newsMsg'), 'Paste a picture link that starts with https://', true); $('nImgUrl').focus(); return; }
    $('nImgGo').disabled = true; setMsg($('newsMsg'), 'Downloading and shrinking the picture...');
    try { showImg((await call('/admin/api/news/image-from-link', 'POST', { url: u })).img); }
    catch (err) { setMsg($('newsMsg'), err.message, true); }
    finally { $('nImgGo').disabled = false; }
  }
  async function shrink(file) {
    // read the file as a data: URL (the page's security policy allows data: pictures but blocks blob: ones)
    const src = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('That file could not be read.')); r.readAsDataURL(file); });
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('This browser cannot open that picture type. Use a JPG, PNG or WebP picture, or paste a picture link instead.')); i.src = src; });
    const scale = Math.min(1, 960 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.72, 0.6, 0.48]) {   // lower the quality until it is small enough
      const out = c.toDataURL('image/jpeg', q);
      if (out.length * 0.75 <= 300 * 1024) return out;
    }
    throw new Error('That picture is too detailed. Try a smaller one, or paste a picture link.');
  }
  $('nImgPick').addEventListener('click', () => $('nImg').click());
  $('nImgGo').addEventListener('click', fromLink);
  $('nImgUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fromLink(); } });
  $('nImgClear').addEventListener('click', clearImg);
  $('nImg').addEventListener('change', async () => {
    const f = $('nImg').files[0];
    if (!f) return;
    setMsg($('newsMsg'), 'Preparing the picture...');
    try {
      showImg(await shrink(f));
    } catch (err) { clearImg(); setMsg($('newsMsg'), err.message, true); }
  });
  $('nColors').addEventListener('change', () => { $('nColorBox').hidden = !$('nColors').checked; });
  const colors = () => ($('nColors').checked ? { bg: $('nBg').value, fg: $('nFg').value } : { bg: '', fg: '' });

  $('newsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg($('newsMsg'), 'Publishing...');
    try {
      const r = await call('/admin/api/news', 'POST', { title: $('nTitle').value, text: $('nText').value, url: $('nUrl').value, kind: kindValue(), cta: $('nCta').value, push: $('nPush').checked, img: newsImg, ...colors() });
      setMsg($('newsMsg'), r.pushed ? 'Published. The popup shows to visitors and notifications are being sent.' : (r.push_wanted ? 'Published. Notifications are not set up, so none were sent.' : 'Published. The popup shows to visitors.'));
      $('newsForm').reset(); clearImg(); $('nColorBox').hidden = true; $('nPush').checked = true; load();
    } catch (err) { setMsg($('newsMsg'), err.message, true); }
  });
  $('nPreview').addEventListener('click', () => {
    const title = $('nTitle').value.trim();
    if (!title) { setMsg($('newsMsg'), 'Write a title first to preview it.', true); $('nTitle').focus(); return; }
    setMsg($('newsMsg'), '');
    window.RioNews.show({ title, text: $('nText').value.trim(), url: $('nUrl').value.trim(), cta: $('nCta').value.trim(), kind: kindValue(), img: newsImg, ...colors() }, { preview: true });
  });
  $('pushForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg($('pushMsg'), 'Sending...');
    try {
      await call('/admin/api/push', 'POST', { title: $('pTitle').value, body: $('pBody').value, url: $('pUrl').value });
      setMsg($('pushMsg'), 'Notification is being sent.'); $('pushForm').reset(); setTimeout(load, 4000);
    } catch (err) { setMsg($('pushMsg'), err.message, true); }
  });

  if (token) start(); else showLogin('');
})();
