/* News popup window. Used by the site / installed app (app.js) and by the admin page's "Preview popup" button.
   RioNews.show({ id, title, text, url, kind, cta, img, bg, fg }, { preview, onClose })
   img = picture (shown under the title; our own /news-img/... link, or a data: picture in the admin preview); bg / fg = button colour / button text colour (#rrggbb) */
(() => {
  'use strict';
  const KINDS = { news: 'News', update: 'Update', feature: 'New feature', notice: 'Notice' };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let open = null;

  const make = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const safeImg = (u) => (typeof u === 'string' && (/^\/news-img\/[0-9a-f]{8}(\?v=[\w]*)?$/.test(u) || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u)) ? u : '');
  const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '');
  const safeUrl = (u) => (typeof u === 'string' && (/^https:\/\//i.test(u) || (u.startsWith('/') && !u.startsWith('//'))) ? u : '');

  function close(result) {
    if (!open) return;
    const { root, prevFocus, onClose, onKey } = open;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('on');
    root.classList.add('out');
    const done = () => {
      root.remove();
      document.documentElement.classList.remove('news-lock');
      try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      if (onClose) onClose(result);
    };
    if (reduce) done(); else setTimeout(done, 260);
  }

  function show(item, opts = {}) {
    if (!item || !item.title) return null;
    if (open) close('replaced');
    const kind = KINDS[item.kind] ? item.kind : 'news';
    const link = safeUrl(item.url);

    const root = make('div', 'npop');
    const card = make('div', 'npop-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'npopTitle');
    if (item.text) card.setAttribute('aria-describedby', 'npopText');

    const x = make('button', 'npop-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');

    const mark = make('div', 'npop-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(make('span', 'ring r1'), make('span', 'ring r2'));
    const img = make('img', 'npop-ghost');   // the ghost logo is always shown, as before
    img.src = '/static/ghost.png'; img.alt = ''; img.width = 56; img.height = 68;
    mark.append(img);

    const badge = make('span', 'npop-badge');
    badge.append(make('span', 'pulse'), document.createTextNode(KINDS[kind]));
    if (opts.preview) badge.append(document.createTextNode(' · preview'));

    const title = make('h2', 'npop-title', item.title);
    title.id = 'npopTitle';
    const body = [mark, badge, title];
    const pic = safeImg(item.img);
    if (pic) {   // the picture sits under the title; 1:1 stays square, wide ones show as 16:9, anything else is trimmed to fit
      const box = make('div', 'npop-pic');
      box.hidden = true;
      const photo = make('img');
      photo.alt = ''; photo.decoding = 'async';
      photo.addEventListener('load', () => {
        const r = Math.min(16 / 9, Math.max(1, photo.naturalWidth / (photo.naturalHeight || 1)));
        box.style.aspectRatio = String(r);
        box.hidden = false;
      });
      photo.addEventListener('error', () => box.remove());   // a missing picture just disappears
      photo.src = pic;
      box.append(photo);
      body.push(box);
    }
    if (item.text) { const p = make('p', 'npop-text', item.text); p.id = 'npopText'; body.push(p); }

    const actions = make('div', 'npop-actions');
    let main;
    if (opts.action) {   // a button that runs code instead of opening a link (e.g. "Read reply")
      main = make('button', 'primary sheen', (item.cta || '').trim() || 'Open');
      main.type = 'button';
      main.addEventListener('click', () => { close('cta'); opts.action(); });
      const later = make('button', 'npop-later', 'Later');
      later.type = 'button';
      later.addEventListener('click', () => close('later'));
      actions.append(main, later);
    } else if (link) {
      main = make('a', 'primary sheen', (item.cta || '').trim() || 'Open');
      main.href = link;
      if (/^https?:/i.test(link)) { main.target = '_blank'; main.rel = 'noopener noreferrer'; }
      main.addEventListener('click', () => close('cta'));
      const later = make('button', 'npop-later', 'Maybe later');
      later.type = 'button';
      later.addEventListener('click', () => close('later'));
      actions.append(main, later);
    } else {
      main = make('button', 'primary sheen', 'Got it');
      main.type = 'button';
      main.addEventListener('click', () => close('ok'));
      actions.append(main);
    }
    const bg = safeColor(item.bg), fg = safeColor(item.fg);   // the admin's own button colours
    if (bg) { main.style.background = bg; main.style.borderColor = bg; main.style.boxShadow = '0 10px 28px ' + bg + '55'; }
    if (fg) main.style.color = fg;
    card.append(x, ...body, actions);
    root.append(card);

    x.addEventListener('click', () => close('x'));
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close('backdrop'); });

    const prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close('esc'); return; }
      if (e.key !== 'Tab') return;
      const f = [...card.querySelectorAll('a[href], button')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    document.body.append(root);
    document.documentElement.classList.add('news-lock');
    open = { root, prevFocus, onClose: opts.onClose, onKey };
    requestAnimationFrame(() => requestAnimationFrame(() => { root.classList.add('on'); try { main.focus({ preventScroll: true }); } catch { /* ignore */ } }));
    return root;
  }

  window.RioNews = { show, close: () => close('api'), isOpen: () => !!open };
})();
