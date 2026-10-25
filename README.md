# RIO × SOCIAL MEDIA DOWNLOADER (YouTube + Instagram + Facebook + TikTok + Pinterest + Telegram + Spotify)

One Flask site. Paste a link from **YouTube, Instagram, Facebook, TikTok, Pinterest, a public Telegram post or a Spotify song**; the site works out which one it is, then you
save the video (with or without the Rio ghost watermark), an MP3, the original file, the cover image or a details TXT.
Theme: black and white until a link is pasted. As soon as a link is recognised the whole page fades to that platform's colours (YouTube red, Instagram pink, Facebook blue, TikTok cyan, Pinterest red, Telegram blue, Spotify green on black) and the matching pill lights up. The neutral colours are `:root` and the platform ones are `:root[data-site="..."]`, both at the top of `static/style.css`; `static/app.js` (`markSite`) sets `data-site`.

## Installable app (PWA)

The site can be installed on phones and desktops: Android Chrome shows an **Install app** button on the page (iPhone: Share > Add to Home Screen).
Once installed on Android, **Share > RIO Downloader** from the YouTube / TikTok / Instagram app opens the link here and looks it up at once.
Files: `/manifest.webmanifest` and `/sw.js` (routes in `app.py`, worker in `templates/sw.js`), icons in `static/icons/`.
The service worker only caches the page shell; lookups, downloads and the counter always go to the server. It needs HTTPS (Render gives that).

The big **download counter** is the same number as the header pill (`/api/stats`). Without Upstash it is kept in a temp file, which Render's
free plan wipes on restart: set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to keep it for good.

## Link preview (WhatsApp, Telegram, Facebook, X ...)
Pasting the site link in a chat shows a card with the ghost logo, the title and the description (`static/og-image.png`, 1200x630, and the Open Graph
tags in `templates/index.html`). The address in the tags is read from the request; to pin it set `SITE_URL` (for example `https://your-site.onrender.com`).
Apps remember a preview for a while: a link that was shared before the update can keep its old card for days (WhatsApp: it refreshes by itself).

## Admin site (`/admin`), news and notifications

`/admin` shows anonymous totals (downloads per site, GB downloaded per site and per file format (MP4, MP3, JPG ...), visits from the web vs the installed app, installs, new visitors, failures, a 14-day chart),
lets you publish a **news banner** and send **push notifications** (update available, new feature, ...).
It does not exist (404) until you set `ADMIN_TOKEN`.

| Name | Meaning |
|---|---|
| `ADMIN_TOKEN` | The admin password. Use a long random one. Wrong passwords lock an address out for 10 minutes. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Keeps the admin numbers, news and notification subscribers for good. Without them everything is in a temp file that Render wipes on restart. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` | For push notifications. Make the two keys once with `python make_vapid_keys.py` (needs `pip install cryptography`); `VAPID_EMAIL` is `mailto:you@example.com`. Without them the "Turn on notifications" card stays hidden. |
| `REPORT_LIMIT_HOUR` | New messages one visitor may send per hour (default 5). |
| `TZ_OFFSET_MIN` | Minutes added to UTC for the daily numbers (default 330 = Sri Lanka). |

**Privacy:** only counts are stored (plus the text of messages people choose to send you through the *tell the admin* card, with no email or IP). No links, no IP addresses, no visitor ids. Visits are counted by the browser once a day (`/api/event`);

**End-to-end encrypted messages.** In `/admin` > *Messages from users* > *End-to-end encryption*, choose a passphrase once. From then on every new
message (and every reply) is encrypted in the browser (ECDH P-256 + AES-256-GCM, Web Crypto) before it is sent; the server and the database only store
scrambled text, and the push notification for a reply never contains its text. The admin's private key is locked with your passphrase in your browser;
the server keeps only that locked copy and the public key. Each visitor conversation gets its own key pair, kept in that visitor's browser, so a visitor
who clears their browser data can no longer read their thread. **Write the passphrase down: it cannot be recovered**, and *Start over* makes old messages
unreadable. The admin and the visitor can compare the *security code* shown on both sides. Not hidden by design: the category, the time and the size of a
message. Honest limit: as with any website, a server that is hacked could serve changed page code; the security code check reduces that risk.
Every message is also signed with a secret that only the visitor's and the admin's keys can make, so a changed or forged message (for example one that
pretends to be the admin) is hidden with a warning, and a visitor only trusts the admin key it saw when the conversation began. The passphrase lock uses
600,000 PBKDF2 rounds; use 12+ characters. The site also sends HSTS, a Permissions-Policy and `no-store` on message and key responses.
Messages sent before encryption was switched on stay readable as plain text; messages from the first encrypted version show "(not verified)".
every link is replaced by `<link>` in the server logs. A notification subscription (the browser's anonymous push address) is saved only when a visitor taps
"Turn on notifications" and is deleted when they turn it off. (Render itself may still keep its own request logs with addresses; that is outside this app.)
iPhone only supports notifications for an app added to the Home Screen.

## News popup and messages from users

* **News popup.** In `/admin` > *Send news* pick a type, write a title and message, optionally a link and button text, and publish. Everyone who opens the
  website or the installed app sees it once as a popup window (static/popup.js). *Preview popup* shows how it will look. If *Also send as a notification* is
  ticked, people who turned notifications on get it too, and tapping it opens the popup. One popup per visit (the newest), news older than 30 days is not shown.
* **Contact the admin.** The site has a *Problem or idea? Tell the admin* card (static/report.js). A message becomes an anonymous ticket: the browser keeps a
  random secret for it (localStorage), the server keeps only the secret's hash. The messages appear in `/admin` > *Messages from users*; your reply is shown
  **only to the browser that wrote the message** (*My messages*, plus a popup when they come back), and as a notification to that one person if they turned
  notifications on. Nobody else can read it. No account, email or IP address is stored (only what the user typed). One visitor may start
  `REPORT_LIMIT_HOUR` (default 5) new messages per hour. If a visitor clears their browser data they lose access to their thread (the admin still has it).
  Keep an eye on what people type: tell them not to write private details (the form says so).

## Folder layout (Flask needs exactly this)

```
app.py
requirements.txt
render.yaml
templates/index.html
templates/admin.html     <- admin page
admin.py                 <- admin routes, counters, news, push
make_vapid_keys.py
static/admin.js, static/admin.css
static/popup.js          <- news popup window (site + admin preview)
static/report.js         <- "tell the admin" window on the site
static/app.js
static/style.css
static/watermark.png     <- ghost logo burned into videos
static/ghost.png         <- logo in the header / hero
static/favicon.png
static/icons/*.png       <- app icons (PWA)
templates/sw.js          <- service worker
```

## Run locally

```bash
pip install -r requirements.txt
pip install deno         # JavaScript runtime that yt-dlp needs for YouTube (or have Node.js installed)
python app.py            # http://localhost:5000
```

## Deploy on Render

Push this folder to GitHub, create a **Web Service** from the repo (render.yaml is picked up).

* Build command: `pip install -r requirements.txt && (pip install deno || echo "deno wheel not installed")`
* Start command: `gunicorn app:app --workers 1 --threads 16 --timeout 120 --worker-tmp-dir /dev/shm`
* Health check path: `/healthz`

## Links that work

| Site | Links |
|---|---|
| YouTube | `youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/shorts/...` |
| Instagram | `instagram.com/reel/...`, `/p/...` (video posts), `/tv/...`, `instagr.am/...` |
| Facebook | `facebook.com/watch/?v=...`, `/reel/...`, `/<page>/videos/...`, `/share/v/...`, `/share/r/...`, `fb.watch/...` |
| TikTok | `tiktok.com/@user/video/...`, `vm.tiktok.com/...`, `tiktok.com/t/...` |
| Telegram | `t.me/<channel>/<post number>` (also `telegram.me`, `t.me/s/<channel>/<number>`). **Public channels and groups only.** Videos, round videos, photos and voice / music posts. Private channels (`t.me/c/...`), invite links (`t.me/+...`) and bots are not supported. See *Telegram* below. |
| Spotify | `open.spotify.com/track/...` (also `/intl-xx/track/...`), `spotify.link/...`. **Single songs only**, no albums, playlists or podcasts. See *Spotify* below. |
| Pinterest | `pinterest.com/pin/...` (and regional sites such as `pinterest.co.uk`), `pin.it/...`. Video pins give MP4 + MP3 (the page data, Pinterest's pin API and HLS playlists are all tried, so a video pin is never turned into its cover picture); image pins give the original-size picture in the Document tab. |

Only **public** videos work. Not supported: private accounts, stories, friends/group posts, photo-only posts (incl. TikTok slideshows),
playlists and channels, live streams and premieres, age-restricted or members-only YouTube videos, YouTube videos
longer than `MAX_DURATION`.

## How downloads work

| Tab | What you get | How |
|---|---|---|
| Video | MP4 in the chosen quality. Watermark switch + corner picker. | **YouTube:** always a job (yt-dlp downloads picture + sound, ffmpeg joins them, no re-encode; watermark = one extra encode). **Instagram / Facebook / TikTok:** direct stream, or a job when a quality is picture-only or the watermark is on. |
| Audio | Real **MP3** with title/creator tags. | ffmpeg job. |
| Document | **Original file** (no watermark, no re-encode), **cover image**, **details TXT**. | Same as Video, or a direct download. |

Every download starts with `POST /api/prepare`, so any failure shows as a message in the page.
Files are named `youtube_...`, `instagram_...`, `facebook_...`, `tiktok_...` or `pinterest_...`.

## Telegram

Telegram publishes every public post as a small embed page (`t.me/<channel>/<number>?embed=1`) that contains the direct video / photo / voice links, so no login or API key is needed.
`from_telegram_embed` in `app.py` reads that page (video, round video, photo, voice / music, caption, channel name, views, date); if it finds nothing, yt-dlp's Telegram extractor is tried.
Video posts give MP4 + MP3 + original file + cover + details TXT, photo posts give the full-size photo + details TXT, voice / music posts give MP3 + details TXT.
Telegram itself decides which files the embed page shows: very large files can be missing from it, and then the visitor sees "Telegram doesn't share this file outside the app".
Theme: Telegram blue on blue-black (`:root[data-site="telegram"]` in `static/style.css`).

## Spotify

Spotify's own audio is DRM-protected, so it cannot be saved directly. Like spotDL, the app reads the song's details from Spotify
(title, artists, album, cover, length; no Spotify account or API key needed: the public embed page, the page's meta tags and oEmbed are tried in that order),
searches YouTube for the same song (the match is scored on length, "- Topic" channels, title and artist, and live / remix / cover versions are penalised),
and turns that audio into an **MP3 with Spotify's title / artist / album / year tags and the album cover embedded**. Files are named `Artist - Title.mp3`.
Tabs: Audio (MP3) and Document (album cover, song details TXT). There is no Video tab.
If YouTube blocks the server, a SoundCloud search (length must match within 8 s) is tried as a fallback; it finds fewer songs, so cookies are still the real fix.
The sound quality is therefore that of the YouTube version, and YouTube's bot blocking (below) also applies to Spotify songs, so the same `cookies.txt` helps.
Theme: green and black (`:root[data-site="spotify"]` in `static/style.css`).

## IMPORTANT: YouTube and Instagram block cloud servers

YouTube and Instagram answer requests from data-centre IPs (Render, AWS, ...) with "Sign in to confirm you're
not a bot" or "login required". That is the most common reason for "it doesn't work", and it is not a bug in the app.
(Facebook is much more relaxed.) For YouTube the app already makes a second try with other player clients when
it sees the bot message, which sometimes helps. If it still fails, use one of these:

1. **Cookies.** Export a `cookies.txt` (Netscape format) from a browser that is logged in to a **throw-away**
   account (extension "Get cookies.txt LOCALLY"). On Render: *Environment > Secret Files*.
   * YouTube: file name `cookies.txt` (read automatically from `/etc/secrets/cookies.txt`), or set `COOKIES_FILE`,
     or paste the content into `YOUTUBE_COOKIES`.
   * Instagram: file name `instagram_cookies.txt` (read automatically from `/etc/secrets/instagram_cookies.txt`),
     or set `INSTAGRAM_COOKIES_FILE`, or paste the content into `INSTAGRAM_COOKIES`.

   Never use a main account (it can get flagged or restricted), never commit cookies to GitHub, and re-export now
   and then because they expire.
2. **A residential proxy** in `PROXY_URL` (e.g. `http://user:pass@host:port`).
3. Host the app somewhere with a home IP (a Raspberry Pi at home works well).

To see what the server has, set `DEBUG_ERRORS=1` and open `/api/debug/env`: it shows the yt-dlp version, whether
`deno` / `node` and ffmpeg were found, and which sites have cookies loaded. Remove `DEBUG_ERRORS` afterwards.

## Environment variables (all optional)

| Name | Default | Meaning |
|---|---|---|
| `MAX_HEIGHT` | `1080` | Tallest YouTube quality offered. Above 1080 the file is an MKV and much bigger. |
| `MAX_DURATION` | `1800` | Longest YouTube video accepted, in seconds. |
| `MAX_SOURCE_MB` | `250` | Largest download accepted. |
| `PARALLEL_JOBS` | `2` | Downloads running at once (watermark encoding is always one at a time). |
| `MAX_ACTIVE_JOBS` | `5` | Jobs allowed in the queue + running. |
| `COOKIES_FILE` / `YOUTUBE_COOKIES` | `/etc/secrets/cookies.txt` | YouTube cookies (see above). |
| `INSTAGRAM_COOKIES_FILE` / `INSTAGRAM_COOKIES` | `/etc/secrets/instagram_cookies.txt` | Instagram cookies (see above). |
| `TIKTOK_PROVIDERS` (or `PROVIDERS`) | `own,tikwm,ytdlp` | Order of TikTok lookup providers. `own,ytdlp` never uses the third-party tikwm API. |
| `PROXY_URL` | - | Proxy for all requests. |
| `WATERMARK` | `1` | `0` switches the watermark feature off. |
| `WATERMARK_POSITION` | `br` | Default corner: `br`, `bl`, `tr`, `tl`. |
| `WATERMARK_SIZE` | `0.24` | Logo width as a share of the video width. |
| `WATERMARK_OPACITY` | `0.92` | 0.1 to 1. |
| `WATERMARK_IMAGE` | `static/watermark.png` | Use another PNG (transparent background). |
| `FFMPEG_PRESET` | `ultrafast` | `veryfast` gives smaller files but uses more CPU. |
| `RATE_LIMIT` / `RATE_WINDOW` | `12` / `60` | Requests per visitor per window (seconds). |
| `GLOBAL_RATE_LIMIT` | `240` | Requests per window for the whole site. |
| `PROXY_HOPS` | `2` | See below. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | - | Keeps the download counter across restarts. |
| `COUNTER_KEY` | `rio_downloads` | Counter name (one shared counter for all six sites). |
| `DEBUG_ERRORS` | - | `1` shows the real error in the UI and enables `/api/debug/ip` and `/api/debug/env`. |

### Rate limit and `PROXY_HOPS`

`X-Forwarded-For` can be forged by visitors, so the app trusts only the entry added by your own proxies,
counted from the right. On Render this is normally 2. To check: set `DEBUG_ERRORS=1`, open `/api/debug/ip`
and confirm `seen_as` is **your** IP, then remove `DEBUG_ERRORS`.

## Notes

* **These sites change constantly.** If lookups suddenly fail, redeploy so `yt-dlp` updates (it is not
  version-pinned on purpose). Render: Manual Deploy > "Clear build cache & deploy".
* Render's free plan sleeps after 15 min idle (first request is slow) and wipes temp files on restart.
  Long YouTube videos use disk space and time on the free plan; lower `MAX_DURATION` if needed.
* Replace `static/watermark.png` with any transparent PNG to rebrand.
* Only save videos you made, videos whose licence allows it, or videos you have permission to use.
  The terms of YouTube, Instagram, Facebook, TikTok, Pinterest and Spotify do not allow downloading other people's videos without permission.
