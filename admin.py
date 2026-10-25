"""Rio Downloader - admin site, anonymous usage counters, news banner and push notifications.

Privacy: only COUNTS are stored (visits, installs, downloads per site, failures). No links, no IP addresses and no
visitor ids are ever saved. A push subscription (the browser's anonymous push address) is stored only when a visitor
taps "Turn on notifications", and can be removed by them at any time.

Storage: Upstash Redis when UPSTASH_REDIS_REST_URL / _TOKEN are set (survives restarts), otherwise a temp file
(Render's free plan wipes it on restart).

Environment: ADMIN_TOKEN (the admin password; without it /admin does not exist), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
VAPID_EMAIL (mailto:you@example.com) for push notifications (make them with make_vapid_keys.py), TZ_OFFSET_MIN (330).
"""
import base64
import hashlib
import io
import ipaddress
import socket
import hmac
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse
from datetime import datetime, timedelta, timezone

import requests
from flask import Response, jsonify, render_template, request

try:
    from PIL import Image, ImageOps
except ImportError:  # picture links then stay switched off
    Image = ImageOps = None
try:
    from pywebpush import WebPushException, webpush
except ImportError:  # notifications then stay switched off
    webpush, WebPushException = None, Exception

log = logging.getLogger("rio.admin")

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
VAPID_PUBLIC = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
VAPID_EMAIL = os.environ.get("VAPID_EMAIL", "mailto:admin@example.com").strip()
try:
    TZ_OFFSET = int(os.environ.get("TZ_OFFSET_MIN", "330"))  # Sri Lanka = UTC+5:30
except ValueError:
    TZ_OFFSET = 330
UPSTASH_URL = (os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""
USE_UPSTASH = bool(UPSTASH_URL and UPSTASH_TOKEN)
FILE = os.environ.get("ADMIN_FILE", os.path.join(tempfile.gettempdir(), "rio_admin.json"))
PLATFORMS = ("youtube", "instagram", "facebook", "tiktok", "pinterest", "telegram", "spotify")
STATS_KEY, PUSH_KEY, NEWS_KEY, REPORTS_KEY, E2E_KEY = "rio_admin_stats", "rio_admin_push", "rio_admin_news", "rio_admin_reports", "rio_admin_e2e"
NEWSIMG_KEY = "rio_admin_newsimg"          # news pictures (kept apart from the news list so that list stays small)
MAX_NEWS_IMG = 350 * 1024                  # bytes; the admin page shrinks pictures to ~100 KB before sending
NEWS_IMG_TYPES = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png"}
MAX_SUBS = 50000
MAX_REPORTS, MAX_MSGS, REPORT_KINDS = 500, 30, ("problem", "idea", "other")
try:
    REPORT_LIMIT_HOUR = int(os.environ.get("REPORT_LIMIT_HOUR", "5"))  # new messages one visitor may send per hour
except ValueError:
    REPORT_LIMIT_HOUR = 5
NEWS_KINDS = ("news", "update", "feature", "notice")

_lock = threading.Lock()
_mem = {"stats": {}, "push": {}, "news": [], "reports": {}, "e2e": {}, "newsimg": {}}
_rep_lock = threading.Lock()
_rep_hits = {}  # ip -> times of new reports (memory only, to stop floods)
_last_push = {}


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
def _up(*cmd):
    r = requests.post(UPSTASH_URL, headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"}, json=list(cmd), timeout=6)
    r.raise_for_status()
    return r.json().get("result")


def _load_file():
    try:
        with open(FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        for k in _mem:
            if k in data:
                _mem[k] = data[k]
    except (OSError, ValueError):
        pass


def _save_file():
    try:
        tmp = FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_mem, fh)
        os.replace(tmp, FILE)
    except OSError as exc:
        log.warning("could not save the admin file: %s", exc)


if not USE_UPSTASH:
    _load_file()


def today(offset_days=0):
    return (datetime.now(timezone.utc) + timedelta(minutes=TZ_OFFSET, days=offset_days)).strftime("%Y-%m-%d")


def incr(*fields):
    """Add 1 to each counter. Runs in the background so a download never waits for it."""
    def work():
        try:
            if USE_UPSTASH:
                for f in fields:
                    _up("HINCRBY", STATS_KEY, f, 1)
            else:
                with _lock:
                    for f in fields:
                        _mem["stats"][f] = int(_mem["stats"].get(f, 0)) + 1
                    _save_file()
        except Exception as exc:  # noqa: BLE001 - statistics must never break the site
            log.warning("could not count %s: %s", fields, exc)
    threading.Thread(target=work, daemon=True).start()


def incr_by(amounts):
    """Add the given amounts ({field: number}) to the counters, in the background."""
    amounts = {f: int(a) for f, a in amounts.items() if int(a) > 0}
    if not amounts:
        return

    def work():
        try:
            if USE_UPSTASH:
                for f, a in amounts.items():
                    _up("HINCRBY", STATS_KEY, f, a)
            else:
                with _lock:
                    for f, a in amounts.items():
                        _mem["stats"][f] = int(_mem["stats"].get(f, 0)) + a
                    _save_file()
        except Exception as exc:  # noqa: BLE001 - statistics must never break the site
            log.warning("could not count %s: %s", list(amounts), exc)
    threading.Thread(target=work, daemon=True).start()


KNOWN_FORMATS = ("mp4", "mkv", "webm", "mov", "mp3", "m4a", "jpg", "png", "webp", "txt")


def format_of(name):
    """File format of a download, from its file name (mp4, mp3, jpg, txt ...). Anything odd becomes 'other'."""
    ext = os.path.splitext(name or "")[1].lower().lstrip(".")
    if ext == "jpeg":
        ext = "jpg"
    return ext if ext in KNOWN_FORMATS else "other"


def record_bytes(platform, fmt, nbytes):
    """Count the data really sent to a visitor: total, per day, per site and per format (bytes, plus files per format)."""
    nbytes = int(nbytes or 0)
    if nbytes <= 0:
        return
    fmt = fmt if fmt in KNOWN_FORMATS else "other"
    fields = {"by:total": nbytes, f"by:d:{today()}": nbytes, f"by:f:{fmt}": nbytes}
    if platform in PLATFORMS:
        fields[f"by:p:{platform}"] = nbytes
    incr_by(fields)
    incr(f"fc:f:{fmt}")


def stats_all():
    if USE_UPSTASH:
        flat = _up("HGETALL", STATS_KEY) or []
        return {flat[i]: int(flat[i + 1]) for i in range(0, len(flat) - 1, 2)}
    with _lock:
        return {k: int(v) for k, v in _mem["stats"].items()}


def push_all():
    if USE_UPSTASH:
        flat = _up("HGETALL", PUSH_KEY) or []
        return {flat[i]: json.loads(flat[i + 1]) for i in range(0, len(flat) - 1, 2)}
    with _lock:
        return dict(_mem["push"])


def push_put(key, sub):
    if USE_UPSTASH:
        _up("HSET", PUSH_KEY, key, json.dumps(sub))
    else:
        with _lock:
            _mem["push"][key] = sub
            _save_file()


def push_del(key):
    if USE_UPSTASH:
        _up("HDEL", PUSH_KEY, key)
    else:
        with _lock:
            _mem["push"].pop(key, None)
            _save_file()


def news_get():
    if USE_UPSTASH:
        raw = _up("GET", NEWS_KEY)
        return json.loads(raw) if raw else []
    with _lock:
        return list(_mem["news"])


def news_set(items):
    if USE_UPSTASH:
        _up("SET", NEWS_KEY, json.dumps(items))
    else:
        with _lock:
            _mem["news"] = items
            _save_file()


def newsimg_get(nid):
    if USE_UPSTASH:
        raw = _up("HGET", NEWSIMG_KEY, nid)
        return json.loads(raw) if raw else None
    with _lock:
        return _mem["newsimg"].get(nid)


def newsimg_put(nid, rec):
    if USE_UPSTASH:
        _up("HSET", NEWSIMG_KEY, nid, json.dumps(rec))
    else:
        with _lock:
            _mem["newsimg"][nid] = rec
            _save_file()


def newsimg_del(nid):
    if USE_UPSTASH:
        _up("HDEL", NEWSIMG_KEY, nid)
    else:
        with _lock:
            _mem["newsimg"].pop(nid, None)
            _save_file()


def _img_from_data_url(value):
    """'data:image/jpeg;base64,....' -> {'mime', 'b64'} after checking the real bytes (not just the label). '' if not valid."""
    if not isinstance(value, str) or not value.startswith("data:image/") or "," not in value:
        return None
    try:
        raw = base64.b64decode(value.split(",", 1)[1], validate=True)
    except ValueError:
        return None
    if not 100 < len(raw) <= MAX_NEWS_IMG:
        return None
    mime = next((m for sig, m in NEWS_IMG_TYPES.items() if raw.startswith(sig)), None)
    if not mime and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        mime = "image/webp"
    return {"mime": mime, "b64": base64.b64encode(raw).decode()} if mime else None


def _public_host(host):
    """True only if the host name resolves to public internet addresses (never the server's own network)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


def fetch_picture(url):
    """Download a picture from a link and turn it into a small JPEG data URL (max 960 px, about 300 KB or less)."""
    if Image is None:
        raise ValueError("Picture links are not available on the server (Pillow is missing).")
    url, raw = _safe_link(url), b""
    if not url.startswith("https://"):
        raise ValueError("Paste a picture link that starts with https://")
    for _ in range(4):   # follow a few redirects, checking every stop
        host = urlparse(url).hostname or ""
        if not _public_host(host):
            raise ValueError("That link cannot be used.")
        try:
            with requests.get(url, stream=True, timeout=10, allow_redirects=False,
                              headers={"User-Agent": "Mozilla/5.0 (compatible; RioNewsImage/1.0)", "Accept": "image/*"}) as r:
                if r.is_redirect or r.status_code in (301, 302, 303, 307, 308):
                    url = urljoin(url, r.headers.get("Location", ""))
                    if not url.startswith("https://"):
                        raise ValueError("That link cannot be used.")
                    continue
                if r.status_code != 200:
                    raise ValueError(f"The picture could not be opened (error {r.status_code}).")
                for chunk in r.iter_content(65536):
                    raw += chunk
                    if len(raw) > 12 * 1024 * 1024:
                        raise ValueError("That picture file is too big (over 12 MB).")
            break
        except requests.RequestException:
            raise ValueError("The picture could not be downloaded from that link.")
    else:
        raise ValueError("That link redirects too many times.")
    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
        im.load()
    except Exception:  # noqa: BLE001
        raise ValueError("That link is not a picture (use a link that opens the picture itself, ending in .jpg / .png / .webp).")
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        flat = Image.new("RGB", im.size, (255, 255, 255))
        flat.paste(im, mask=im.split()[-1])
        im = flat
    else:
        im = im.convert("RGB")
    im.thumbnail((960, 960))
    for q in (85, 72, 60, 48, 38):
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=q, optimize=True)
        if buf.tell() <= 300 * 1024:
            return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(), buf.tell()
    raise ValueError("That picture is too detailed to shrink. Try another one.")


def _color(value):
    """A button colour such as #ff3366, or '' (= the site's own colour)."""
    return value.strip().lower() if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value.strip()) else ""


def push_get(key):
    if USE_UPSTASH:
        raw = _up("HGET", PUSH_KEY, key)
        return json.loads(raw) if raw else None
    with _lock:
        return _mem["push"].get(key)


# ---- reports (anonymous tickets: a message, the admin's replies, and a hashed secret that only the sender's browser knows)
def rep_all():
    if USE_UPSTASH:
        flat = _up("HGETALL", REPORTS_KEY) or []
        return {flat[i]: json.loads(flat[i + 1]) for i in range(0, len(flat) - 1, 2)}
    with _lock:
        return dict(_mem["reports"])


def rep_get(rid):
    if USE_UPSTASH:
        raw = _up("HGET", REPORTS_KEY, rid)
        return json.loads(raw) if raw else None
    with _lock:
        t = _mem["reports"].get(rid)
        return json.loads(json.dumps(t)) if t else None


def rep_put(rid, ticket):
    if USE_UPSTASH:
        _up("HSET", REPORTS_KEY, rid, json.dumps(ticket))
    else:
        with _lock:
            _mem["reports"][rid] = ticket
            _save_file()


def rep_del(rid):
    if USE_UPSTASH:
        _up("HDEL", REPORTS_KEY, rid)
    else:
        with _lock:
            _mem["reports"].pop(rid, None)
            _save_file()


# ---- end-to-end encryption: the server keeps only the admin's PUBLIC key and a copy of the private key that is locked
# with a passphrase only the admin knows. Messages are encrypted in the browsers; the server stores ciphertext.
def e2e_get():
    if USE_UPSTASH:
        raw = _up("GET", E2E_KEY)
        return json.loads(raw) if raw else {}
    with _lock:
        return dict(_mem.get("e2e") or {})


def e2e_set(rec):
    if USE_UPSTASH:
        _up("SET", E2E_KEY, json.dumps(rec))
    else:
        with _lock:
            _mem["e2e"] = rec
            _save_file()


_B64 = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def _b64(value, lo, hi):
    return value if isinstance(value, str) and lo <= len(value) <= hi and _B64.match(value) else ""


def _pub(value):
    """An uncompressed P-256 public key in base64 (65 bytes = 88 characters)."""
    return value if _b64(value, 88, 88) and value.startswith("B") else ""


def _env(value):
    """An encrypted message (the JSON produced by static/e2e.js). The server cannot read it, only check its shape."""
    if not isinstance(value, str) or not 40 < len(value) <= 8000:
        return ""
    try:
        d = json.loads(value)
    except ValueError:
        return ""
    ok = (isinstance(d, dict) and d.get("v") == 1 and all(isinstance(d.get(x), str) for x in "eica")
          and isinstance(d.get("k"), list) and 1 <= len(d["k"]) <= 3
          and all(isinstance(k, dict) and all(isinstance(k.get(x), str) for x in "riw") for k in d["k"]))
    return value if ok else ""


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_news_cache = (0.0, [])


def news_public():
    global _news_cache
    if time.time() - _news_cache[0] > 30:
        try:
            _news_cache = (time.time(), news_get()[:3])
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read the news: %s", exc)
            _news_cache = (time.time(), _news_cache[1])
    out = []
    for n in _news_cache[1]:
        item = {k: n.get(k, "") for k in ("id", "title", "text", "url", "kind", "cta", "ts", "bg", "fg")}
        item["img"] = f"/news-img/{n['id']}?v={re.sub(r'\D', '', n.get('ts', ''))[-10:]}" if n.get("img") else ""
        out.append(item)
    return out


def news_with_stats(items, s):
    """The admin's news list, each item with its own anonymous counters (views, button taps, opened from a notification)."""
    out = []
    for n in items:
        nid = n.get("id", "")
        views, clicks = int(s.get(f"nw:{nid}:view", 0)), int(s.get(f"nw:{nid}:click", 0))
        out.append({**n, "views": views, "clicks": clicks, "push_opens": int(s.get(f"nw:{nid}:push", 0)),
                    "ctr": round(clicks * 100 / views) if views else 0, "img": bool(n.get("img"))})
    return out


# ---------------------------------------------------------------------------
# Push notifications
# ---------------------------------------------------------------------------
def push_ready():
    return bool(webpush and VAPID_PUBLIC and VAPID_PRIVATE)


def _send_all(payload):
    subs = push_all()
    counts = {"ok": 0, "fail": 0, "gone": 0}

    def one(item):
        key, sub = item
        try:
            webpush(subscription_info=sub, data=payload, vapid_private_key=VAPID_PRIVATE,
                    vapid_claims={"sub": VAPID_EMAIL}, ttl=86400, timeout=10)
            return key, "ok"
        except WebPushException as exc:
            code = getattr(getattr(exc, "response", None), "status_code", None)
            return key, "gone" if code in (404, 410) else "fail"
        except Exception:  # noqa: BLE001
            return key, "fail"

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(one, subs.items()))
    for key, res in results:
        counts[res] += 1
        if res == "gone":  # the visitor removed the permission or uninstalled
            try:
                push_del(key)
            except Exception:  # noqa: BLE001
                pass
    _last_push.update(counts, at=datetime.now(timezone.utc).isoformat(timespec="seconds"), total=len(subs), running=False)


def send_push(title, body, url):
    if not push_ready():
        return False
    _last_push.update(running=True)
    payload = json.dumps({"title": title, "body": body, "url": url or "/"})
    threading.Thread(target=_send_all, args=(payload,), daemon=True).start()
    return True


def send_push_one(key, payload):
    """A notification for ONE subscriber only (the person who wrote a report)."""
    if not push_ready() or not key:
        return False
    try:
        sub = push_get(key)
    except Exception:  # noqa: BLE001
        return False
    if not sub:
        return False

    def work():
        try:
            webpush(subscription_info=sub, data=payload, vapid_private_key=VAPID_PRIVATE,
                    vapid_claims={"sub": VAPID_EMAIL}, ttl=86400, timeout=10)
        except WebPushException as exc:
            if getattr(getattr(exc, "response", None), "status_code", None) in (404, 410):
                try:
                    push_del(key)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=work, daemon=True).start()
    return True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
def _clip(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ""


def _safe_link(value):
    value = _clip(value, 300)
    return value if value.startswith(("https://", "/")) and not value.startswith("//") else ""


def register(app, error, client_ip, rate_limited, asset_v):
    fails = {}  # ip -> [count, first time]; only kept in memory, only for wrong passwords

    def authed():
        if not ADMIN_TOKEN:
            return False
        ip, now = client_ip(), time.time()
        count, first = fails.get(ip, [0, now])
        if now - first > 600:
            count, first = 0, now
        if count >= 8:
            return None  # locked for a while
        token = request.headers.get("Authorization", "")[7:].strip() if request.headers.get("Authorization", "").startswith("Bearer ") else ""
        if token and hmac.compare_digest(hashlib.sha256(token.encode()).digest(), hashlib.sha256(ADMIN_TOKEN.encode()).digest()):
            fails.pop(ip, None)
            return True
        fails[ip] = [count + 1, first]
        if len(fails) > 2000:
            fails.clear()
        time.sleep(0.6)
        return False

    def guard():
        """None when the admin is allowed in, else the error reply."""
        if not ADMIN_TOKEN:
            return error("Not found.", 404)
        ok = authed()
        if ok is None:
            return error("Too many wrong passwords. Wait ten minutes.", 429)
        return None if ok else error("Wrong password.", 401)

    @app.get("/admin")
    def admin_page():
        if not ADMIN_TOKEN:
            return Response("Not found", status=404, mimetype="text/plain")
        resp = Response(render_template("admin.html", v=asset_v), mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Robots-Tag"] = "noindex, nofollow"
        return resp

    @app.get("/admin/api/stats")
    def admin_stats():
        denied = guard()
        if denied:
            return denied
        s = stats_all()
        g = lambda k: s.get(k, 0)  # noqa: E731
        t = today()
        days = []
        for i in range(13, -1, -1):
            d = today(-i)
            days.append({"day": d, "downloads": g(f"dl:d:{d}"), "web": g(f"v:web:{d}"), "app": g(f"v:app:{d}"),
                         "bytes": g(f"by:d:{d}")})
        last7 = days[-7:]
        web_total = sum(v for k, v in s.items() if k.startswith("v:web:"))
        app_total = sum(v for k, v in s.items() if k.startswith("v:app:"))
        fmts = sorted(({"fmt": k[5:], "bytes": v, "files": g(f"fc:f:{k[5:]}")} for k, v in s.items() if k.startswith("by:f:")),
                      key=lambda x: x["bytes"], reverse=True)
        try:
            subs = len(push_all())
        except Exception:  # noqa: BLE001
            subs = None
        try:
            reports_new = sum(1 for t in rep_all().values() if t.get("new"))
        except Exception:  # noqa: BLE001
            reports_new = 0
        return jsonify({
            "today": t,
            "downloads_total": g("dl:total"), "downloads_today": g(f"dl:d:{t}"),
            "bytes_total": g("by:total"), "bytes_today": g(f"by:d:{t}"), "bytes_7d": sum(d["bytes"] for d in last7),
            "formats": fmts,
            "visits_today": g(f"v:web:{t}") + g(f"v:app:{t}"), "web_today": g(f"v:web:{t}"), "app_today": g(f"v:app:{t}"),
            "visits_7d": sum(d["web"] + d["app"] for d in last7),
            "web_total": web_total, "app_total": app_total,
            "new_visitors": g("uv:total"), "new_web": g("uv:web"), "new_app": g("uv:app"),
            "installs": g("install:total"), "installs_today": g(f"install:d:{t}"),
            "platforms": {p: {"downloads": g(f"dl:p:{p}"), "lookups_ok": g(f"lk:ok:{p}"), "lookups_fail": g(f"lk:fail:{p}"),
                              "job_fail": g(f"jf:{p}"), "bytes": g(f"by:p:{p}")} for p in PLATFORMS},
            "days": days,
            "push": {"configured": push_ready(), "subscribers": subs, "last": _last_push or None},
            "news": news_with_stats(news_get(), s),
            "reports_new": reports_new,
            "persistent": USE_UPSTASH,
        })

    @app.post("/admin/api/news")
    def admin_news_add():
        denied = guard()
        if denied:
            return denied
        data = request.get_json(silent=True) or {}
        title, text, url = _clip(data.get("title"), 80), _clip(data.get("text"), 280), _safe_link(data.get("url"))
        kind = data.get("kind") if data.get("kind") in NEWS_KINDS else "news"
        cta = _clip(data.get("cta"), 24)
        bg, fg = _color(data.get("bg")), _color(data.get("fg"))
        if not title:
            return error("Write a title.", 400)
        img = None
        if data.get("img"):
            img = _img_from_data_url(data.get("img"))
            if not img:
                return error("That picture could not be used. Use a JPG, PNG or WebP picture.", 400)
        nid = secrets.token_hex(4)
        if img:
            newsimg_put(nid, img)
        items = news_get()
        items.insert(0, {"id": nid, "title": title, "text": text, "url": url, "kind": kind, "cta": cta,
                         "bg": bg, "fg": fg, "img": bool(img),
                         "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        dropped = items[10:]
        news_set(items[:10])
        for old in dropped:      # news that falls off the list takes its picture with it
            if old.get("img"):
                try:
                    newsimg_del(old["id"])
                except Exception:  # noqa: BLE001
                    pass
        global _news_cache
        _news_cache = (0.0, [])
        # The notification opens the site on this news item, so the popup shows even for a visitor who tapped it
        # from the notification bar (the popup's own button then opens the news link, if there is one).
        pushed = bool(data.get("push")) and send_push(title, text or "Tap to read the news.", f"/?news={nid}")
        return jsonify({"ok": True, "id": nid, "pushed": pushed, "push_wanted": bool(data.get("push"))})

    @app.post("/admin/api/news/image-from-link")
    def admin_news_image_from_link():
        """Takes a picture link, downloads it on the server, shrinks it and returns it so the admin can preview it."""
        denied = guard()
        if denied:
            return denied
        data = request.get_json(silent=True) or {}
        try:
            uri, size = fetch_picture(data.get("url"))
        except ValueError as exc:
            return error(str(exc), 400)
        return jsonify({"ok": True, "img": uri, "bytes": size})

    @app.delete("/admin/api/news/<nid>")
    def admin_news_delete(nid):
        denied = guard()
        if denied:
            return denied
        news_set([n for n in news_get() if n.get("id") != nid])
        try:
            newsimg_del(nid)
        except Exception:  # noqa: BLE001
            pass
        global _news_cache
        _news_cache = (0.0, [])
        return jsonify({"ok": True})

    @app.post("/admin/api/push")
    def admin_push():
        denied = guard()
        if denied:
            return denied
        data = request.get_json(silent=True) or {}
        title, body, url = _clip(data.get("title"), 80), _clip(data.get("body"), 200), _safe_link(data.get("url"))
        if not title:
            return error("Write a title.", 400)
        if not push_ready():
            return error("Notifications are not set up on the server yet (VAPID keys and pywebpush are missing).", 501)
        send_push(title, body, url)
        return jsonify({"ok": True})


    # ---- reports: admin side -------------------------------------------------------------------
    def _summary(t):
        msgs = t.get("msgs", [])
        return {"id": t["id"], "cat": t.get("cat", "other"), "status": t.get("status", "open"), "ts": t.get("ts", ""),
                "new": bool(t.get("new")), "push": bool(t.get("pk")), "vpub": t.get("vpub", ""), "msgs": msgs, "last": msgs[-1]["ts"] if msgs else t.get("ts", "")}

    @app.get("/admin/api/reports")
    def admin_reports():
        denied = guard()
        if denied:
            return denied
        items = sorted((_summary(t) for t in rep_all().values()), key=lambda x: x["last"], reverse=True)
        return jsonify({"items": items[:200]})

    def _admin_ticket(rid):
        t = rep_get(rid)
        return t

    @app.post("/admin/api/reports/<rid>/reply")
    def admin_report_reply(rid):
        denied = guard()
        if denied:
            return denied
        body = request.get_json(silent=True) or {}
        enc = body.get("enc") is True
        text = _env(body.get("text")) if enc else _clip(body.get("text"), 1000)
        if not text:
            return error("Write a reply.", 400)
        with _rep_lock:
            t = _admin_ticket(rid)
            if not t:
                return error("That report no longer exists.", 404)
            if t.get("vpub") and not enc:
                return error("This conversation is encrypted. Unlock your key first.", 400)
            t["msgs"].append({"by": "admin", "text": text, "ts": _now_iso(), **({"e": 1} if enc else {})})
            t["new"] = False
            rep_put(rid, t)
        # an encrypted reply never puts its text in the notification (the push service could read it)
        pushed = send_push_one(t.get("pk"), json.dumps({"title": "Reply from RIO admin", "body": "You have a new reply. Tap to read it." if enc else text[:140],
                                                         "url": f"/?report={rid}", "report": True}))
        return jsonify({"ok": True, "pushed": pushed})

    @app.post("/admin/api/reports/<rid>/read")
    def admin_report_read(rid):
        denied = guard()
        if denied:
            return denied
        with _rep_lock:
            t = _admin_ticket(rid)
            if t and t.get("new"):
                t["new"] = False
                rep_put(rid, t)
        return jsonify({"ok": True})

    @app.post("/admin/api/reports/<rid>/status")
    def admin_report_status(rid):
        denied = guard()
        if denied:
            return denied
        status = (request.get_json(silent=True) or {}).get("status")
        if status not in ("open", "closed"):
            return error("Unknown status.", 400)
        with _rep_lock:
            t = _admin_ticket(rid)
            if not t:
                return error("That report no longer exists.", 404)
            t["status"] = status
            rep_put(rid, t)
        return jsonify({"ok": True})

    @app.delete("/admin/api/reports/<rid>")
    def admin_report_delete(rid):
        denied = guard()
        if denied:
            return denied
        with _rep_lock:
            rep_del(rid)
        return jsonify({"ok": True})

    # ---- reports: visitor side (anonymous; a ticket is proven by its secret, which only that browser has) ----
    def _owned(rid, secret):
        t = rep_get(rid) if isinstance(rid, str) and 0 < len(rid) <= 32 else None
        if t and isinstance(secret, str) and hmac.compare_digest(t.get("sh", ""), _sha(secret)):
            return t
        return None

    def _public(t):
        return {"id": t["id"], "cat": t.get("cat", "other"), "status": t.get("status", "open"), "ts": t.get("ts", ""),
                "msgs": [{"by": m["by"], "text": m["text"], "ts": m["ts"], "e": m.get("e", 0)} for m in t.get("msgs", [])]}

    @app.post("/api/report")
    def api_report_new():
        if rate_limited():
            return error("Too many requests.", 429)
        data = request.get_json(silent=True) or {}
        cat = data.get("cat") if data.get("cat") in REPORT_KINDS else "other"
        enc = data.get("enc") is True
        vpub = ""
        if enc:
            text, vpub = _env(data.get("message")), _pub(data.get("vpub"))
            if not text or not vpub:
                return error("That message could not be read. Reload the page and try again.", 400)
        else:
            text = _clip(data.get("message"), 1000)
            if len(text) < 3:
                return error("Write a few words about the problem.", 400)
            if e2e_get().get("pub"):  # once encryption is on, plain messages are refused (no silent downgrade)
                return error("Please reload the page: messages are now end-to-end encrypted.", 400)
        ip, now = client_ip(), time.time()
        hits = [x for x in _rep_hits.get(ip, []) if now - x < 3600]
        if len(hits) >= REPORT_LIMIT_HOUR:
            return error("You have sent a few messages already. Please wait a while before sending more.", 429)
        _rep_hits[ip] = hits + [now]
        if len(_rep_hits) > 2000:
            _rep_hits.clear()
        endpoint = data.get("endpoint")
        pk = hashlib.sha1(endpoint.encode()).hexdigest()[:24] if isinstance(endpoint, str) and endpoint.startswith("https://") and len(endpoint) < 600 else ""
        with _rep_lock:
            allr = rep_all()
            if len(allr) >= MAX_REPORTS:
                closed = sorted((t for t in allr.values() if t.get("status") == "closed"), key=lambda t: t.get("ts", ""))
                if not closed:
                    return error("Messages are full right now. Please try again later.", 503)
                rep_del(closed[0]["id"])
            rid, secret = secrets.token_hex(6), secrets.token_urlsafe(18)
            ts = _now_iso()
            rep_put(rid, {"id": rid, "sh": _sha(secret), "ts": ts, "cat": cat, "status": "open", "new": True, "pk": pk,
                          "msgs": [{"by": "user", "text": text, "ts": ts, **({"e": 1} if enc else {})}],
                          **({"vpub": vpub} if vpub else {})})
        return jsonify({"ok": True, "id": rid, "secret": secret})

    @app.post("/api/report/status")
    def api_report_status():
        if rate_limited():
            return error("Too many requests.", 429)
        out = []
        for ref in ((request.get_json(silent=True) or {}).get("tickets") or [])[:10]:
            if not isinstance(ref, dict):
                continue
            t = _owned(ref.get("id"), ref.get("secret"))
            out.append(_public(t) if t else {"id": str(ref.get("id"))[:32], "gone": True})
        resp = jsonify({"items": out})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.post("/api/report/<rid>/reply")
    def api_report_reply(rid):
        if rate_limited():
            return error("Too many requests.", 429)
        data = request.get_json(silent=True) or {}
        enc = data.get("enc") is True
        text = _env(data.get("message")) if enc else _clip(data.get("message"), 1000)
        if not text:
            return error("Write a message.", 400)
        with _rep_lock:
            t = _owned(rid, data.get("secret"))
            if not t:
                return error("That conversation was not found.", 404)
            if t.get("vpub") and not enc:
                return error("Please reload the page: this conversation is end-to-end encrypted.", 400)
            if sum(1 for m in t["msgs"] if m["by"] == "user") >= MAX_MSGS:
                return error("This conversation is full. Please send a new message instead.", 429)
            t["msgs"].append({"by": "user", "text": text, "ts": _now_iso(), **({"e": 1} if enc else {})})
            t["new"], t["status"] = True, "open"
            endpoint = data.get("endpoint")
            if isinstance(endpoint, str) and endpoint.startswith("https://") and len(endpoint) < 600:
                t["pk"] = hashlib.sha1(endpoint.encode()).hexdigest()[:24]
            rep_put(rid, t)
        return jsonify({"ok": True, "item": _public(t)})

    # ---- encryption keys -----------------------------------------------------------------------
    @app.get("/admin/api/e2e")
    def admin_e2e_get():
        denied = guard()
        if denied:
            return denied
        return jsonify({"record": e2e_get() or None})

    @app.put("/admin/api/e2e")
    def admin_e2e_put():
        denied = guard()
        if denied:
            return denied
        d = request.get_json(silent=True) or {}
        rec = {"pub": _pub(d.get("pub")), "salt": _b64(d.get("salt"), 16, 64), "iv": _b64(d.get("iv"), 8, 32),
               "wrapped": _b64(d.get("wrapped"), 40, 3000)}
        n = d.get("n")
        if not all(rec.values()) or not (isinstance(n, int) and not isinstance(n, bool) and 100000 <= n <= 2000000):
            return error("That key was not understood.", 400)
        rec["n"] = n
        if e2e_get().get("pub") and d.get("replace") is not True:
            return error("A key already exists. Unlock it instead, or choose to replace it.", 409)
        e2e_set(rec)
        return jsonify({"ok": True})

    @app.get("/api/e2e/pub")
    def api_e2e_pub():
        if rate_limited():
            return error("Too many requests.", 429)
        try:
            pub = e2e_get().get("pub", "")
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read the public key: %s", exc)
            return error("Try again in a moment.", 503)
        resp = jsonify({"pub": pub})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    # ---- public, anonymous ---------------------------------------------------------------------
    @app.post("/api/event")
    def api_event():
        if rate_limited():
            return error("Too many requests.", 429)
        data = request.get_json(silent=True) or {}
        kind, mode, day = data.get("t"), data.get("m"), today()
        if kind == "visit" and mode in ("web", "app"):
            fields = [f"v:{mode}:{day}"]
            if data.get("new") is True:
                fields += ["uv:total", f"uv:{mode}"]
            incr(*fields)
        elif kind == "install":
            incr("install:total", f"install:d:{day}")
        else:
            return error("Unknown event.", 400)
        return jsonify({"ok": True})

    @app.get("/api/news")
    def api_news():
        resp = jsonify({"items": news_public()})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/news-img/<nid>")
    def news_image(nid):
        if not re.fullmatch(r"[0-9a-f]{8}", nid):
            return Response("Not found", status=404, mimetype="text/plain")
        try:
            rec = newsimg_get(nid)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read a news picture: %s", exc)
            return Response("Try again in a moment.", status=503, mimetype="text/plain")
        if not rec:
            return Response("Not found", status=404, mimetype="text/plain")
        resp = Response(base64.b64decode(rec["b64"]), mimetype=rec["mime"])
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    @app.post("/api/news/<nid>/event")
    def api_news_event(nid):
        """Anonymous per-news counters: view (popup shown), click (its button tapped), push (opened from a notification).
        The browser sends each one once per news item; nothing about the visitor is stored."""
        if rate_limited():
            return error("Too many requests.", 429)
        kind = (request.get_json(silent=True) or {}).get("t")
        if kind not in ("view", "click", "push") or nid not in {n["id"] for n in news_public()}:
            return error("Unknown event.", 400)
        incr(f"nw:{nid}:{kind}")
        return jsonify({"ok": True})

    @app.get("/api/push/key")
    def api_push_key():
        return jsonify({"key": VAPID_PUBLIC if push_ready() else ""})

    @app.post("/api/push/subscribe")
    def api_push_subscribe():
        if rate_limited():
            return error("Too many requests.", 429)
        if not push_ready():
            return error("Notifications are not available.", 501)
        sub = (request.get_json(silent=True) or {}).get("subscription") or {}
        endpoint, keys = sub.get("endpoint"), sub.get("keys") or {}
        if not (isinstance(endpoint, str) and endpoint.startswith("https://") and len(endpoint) < 600
                and isinstance(keys.get("p256dh"), str) and isinstance(keys.get("auth"), str)
                and len(keys["p256dh"]) < 200 and len(keys["auth"]) < 100):
            return error("That subscription was not understood.", 400)
        if len(push_all()) >= MAX_SUBS:
            return error("Notifications are full right now.", 503)
        push_put(hashlib.sha1(endpoint.encode()).hexdigest()[:24],
                 {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}})
        return jsonify({"ok": True})

    @app.post("/api/push/unsubscribe")
    def api_push_unsubscribe():
        if rate_limited():
            return error("Too many requests.", 429)
        endpoint = (request.get_json(silent=True) or {}).get("endpoint")
        if isinstance(endpoint, str) and endpoint:
            push_del(hashlib.sha1(endpoint.encode()).hexdigest()[:24])
        return jsonify({"ok": True})
