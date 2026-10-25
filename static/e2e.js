/* End-to-end encryption for the "tell the admin" messages. Runs only in the browser (Web Crypto); the server stores ciphertext.
   Keys: ECDH P-256. Each message gets a random AES-256-GCM key; that key is wrapped separately for every reader
   (the admin and the visitor's own browser) with a key from ECDH + HKDF. The admin's private key is locked with a
   passphrase that never leaves the admin's browser.
   window.RioE2E = { supported, newKeyPair, exportPub, exportPriv, importPriv, encrypt, decrypt, fingerprint,
                     wrapAdminKey, unwrapAdminKey } */
(() => {
  'use strict';
  const subtle = window.crypto && window.crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const INFO = te.encode('rio-e2e-v1');

  const b64 = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

  async function newKeyPair() { return subtle.generateKey(CURVE, true, ['deriveBits']); }
  async function exportPub(key) { return b64(await subtle.exportKey('raw', key)); }
  async function importPub(pub) { return subtle.importKey('raw', unb64(pub), CURVE, true, []); }
  async function exportPriv(key) { return subtle.exportKey('jwk', key); }
  async function importPriv(jwk) { return subtle.importKey('jwk', jwk, CURVE, true, ['deriveBits']); }
  async function rid(pub) { return hex(await subtle.digest('SHA-256', unb64(pub))).slice(0, 12); }

  // Short code both sides can compare ("security code"): SHA-256 of the public key, in groups.
  async function fingerprint(pub) {
    const h = hex(await subtle.digest('SHA-256', unb64(pub))).slice(0, 20).toUpperCase();
    return h.match(/.{4}/g).join(' ');
  }

  async function wrapKey(privKey, pubKey) {
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
    const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO }, hk,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /* Proof of who wrote a message. A secret that only the two ends can compute (their own private key + the other's public key)
     signs the ciphertext, so the server cannot invent or swap messages and show them as "from the admin" / "from you". */
  async function macKey(priv, peerPub) {
    const bits = await subtle.deriveBits({ name: 'ECDH', public: await importPub(peerPub) }, priv, 256);
    const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode('rio-e2e-auth-v1') }, hk,
      { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  }
  const canon = (env, role) => te.encode(role + '|' + JSON.stringify([env.v, env.e, env.i, env.c, env.k]));
  // -> 'ok' (genuine) | 'none' (an older message without proof) | 'bad' (changed or not from that person)
  async function verify(stored, priv, peerPub, role) {
    try {
      const env = JSON.parse(stored);
      if (typeof env.a !== 'string') return 'none';
      const ok = await subtle.verify('HMAC', await macKey(priv, peerPub), unb64(env.a), canon(env, role));
      return ok ? 'ok' : 'bad';
    } catch { return 'bad'; }
  }

  // text + list of reader public keys (base64) [+ {priv, peerPub, role: 'a'|'u'} to sign it]  ->  a string to store on the server
  async function encrypt(text, pubs, auth) {
    const cekRaw = rand(32), iv = rand(12);
    const cek = await subtle.importKey('raw', cekRaw, 'AES-GCM', false, ['encrypt']);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, cek, te.encode(text));
    const eph = await newKeyPair();
    const keys = [];
    for (const pub of [...new Set(pubs.filter(Boolean))]) {
      const wk = await wrapKey(eph.privateKey, await importPub(pub));
      const wiv = rand(12);
      keys.push({ r: await rid(pub), i: b64(wiv), w: b64(await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, wk, cekRaw)) });
    }
    const env = { v: 1, e: await exportPub(eph.publicKey), i: b64(iv), c: b64(ct), k: keys };
    if (auth) env.a = b64(await subtle.sign('HMAC', await macKey(auth.priv, auth.peerPub), canon(env, auth.role)));
    return JSON.stringify(env);
  }

  // stored string + my private key + my public key  ->  the text (throws if it is not for me / was changed)
  async function decrypt(stored, privKey, myPub) {
    const env = JSON.parse(stored);
    if (!env || env.v !== 1) throw new Error('unknown format');
    const mine = await rid(myPub);
    const entry = (env.k || []).find((x) => x.r === mine);
    if (!entry) throw new Error('not for this key');
    const wk = await wrapKey(privKey, await importPub(env.e));
    const cekRaw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(entry.i) }, wk, unb64(entry.w));
    const cek = await subtle.importKey('raw', cekRaw, 'AES-GCM', false, ['decrypt']);
    return td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.i) }, cek, unb64(env.c)));
  }

  /* ---- the admin's key, locked with a passphrase (PBKDF2 -> AES-GCM). The server only ever sees the locked copy. ---- */
  const ITER = 600000;  // slows down anyone who steals the locked copy and tries passphrases
  async function passKey(pass, salt, iterations) {
    const base = await subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iterations || 250000 }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function wrapAdminKey(pass) {
    const pair = await newKeyPair();
    const salt = rand(16), iv = rand(12);
    const jwk = await exportPriv(pair.privateKey);
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(pass, salt, ITER), te.encode(JSON.stringify(jwk)));
    return { record: { pub: await exportPub(pair.publicKey), salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped), n: ITER }, jwk };
  }
  async function unwrapAdminKey(record, pass) {
    const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, await passKey(pass, unb64(record.salt), record.n), unb64(record.wrapped));
    return JSON.parse(td.decode(raw));
  }

  window.RioE2E = { supported: !!subtle, newKeyPair, exportPub, exportPriv, importPriv, encrypt, decrypt, verify, fingerprint, wrapAdminKey, unwrapAdminKey };
})();
