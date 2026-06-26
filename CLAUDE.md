# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project: Self-Hosted WhatsApp Server for BlackBerry Q20

## Goal
Deploy the *WhatsApp Messenger by Novel-Professor3366* server on the local Debian
machine (`tiny-server`) using Docker. This lets a modified BlackBerry Q20 send and
receive WhatsApp messages while keeping all data at home. The deployment lives at
`/home/max/novel-whats-srv`. Since it runs on a local network without a static
public IP, a Cloudflare tunnel exposes the service securely to the internet.

> This project is a **fork** of NovelProfessor's WhatsApp server and BB10 client,
> with many bug fixes and new features (see "Improvements over upstream" below).

## Resources & Official Documentation (upstream)
- **Server repo (upstream):** https://github.com/NovelProfessor/whatsapp-server
- **Project website:** http://nokia4ever.com
- **YouTube (tutorials):** https://youtube.com/@NovelProfessor

## Our forks
- **Server (active):** https://github.com/Maximo1998/whatsapp-server-improved (branch `main`)
- **Android client:** https://github.com/Maximo1998/whatsapp-client-android_BBOS10 (branch `improved`, built by GitHub Actions)

## System Requirements
- **Server:** Debian (`tiny-server`).
- **Dependencies:** Docker and Docker Compose installed.
- **Network:** Active Cloudflare account with Zero Trust configured for a tunnel.
- **Authorization:** A primary smartphone with the official WhatsApp account (needed to scan the initial QR).
- **Client:** BlackBerry Q20 with the *Novel Messenger* app (BB10 build) installed.

---

## Project File Structure

```
/home/max/novel-whats-srv/
├── Dockerfile                  # Server image (node:20-bookworm-slim + Chromium + FFMPEG)
├── entrypoint.sh               # Patches login.html with DOMAIN+https, starts node
├── docker-compose.yml          # Orchestrates novel-whats + cloudflared
├── .env                        # Environment variables (not in git)
├── .env.example                # Variable template
├── data/                       # Persistent SQLite volume (mydata.db)
├── media/                      # Persistent media volume
├── cache/pics/                 # Profile picture cache (24h TTL)
├── wwebjs_auth/                # WhatsApp session (avoids re-scanning QR on rebuild)
├── whatsapp-server/            # Original upstream code (NovelProfessor)
├── whatsapp-server-improved/   # Improved version (ACTIVE — used by the Dockerfile)
│   ├── server.js
│   ├── connect.js
│   ├── messageRouter.js
│   └── WhatsappClient.js
└── app/whatsapp-client-android/  # Android (BB10) client source — built on GitHub Actions
```

> **The Dockerfile points at `whatsapp-server-improved/`.** The `whatsapp-server/`
> directory is kept only as an upstream reference.

---

## Development Workflow & Code Map

### Git topology (important)
- The deployment root `/home/max/novel-whats-srv/` is **NOT** a git repository.
- The git repo is `whatsapp-server-improved/` (`origin` = `Maximo1998/whatsapp-server-improved`,
  branch `main`). **All server commits/pushes happen from inside that subdirectory.**
- The Android client lives in `app/whatsapp-client-android/` and builds on GitHub
  Actions (push to the `improved` branch); it does **not** build locally.

### Running & building
- There is **no local Node run path and no tests/lint.** Everything runs in Docker.
- `package.json` `main`/`scripts` (`dev`/`start` → `index.js`) are **stale and wrong** —
  there is no `index.js` in the improved server. The real entry point is **`server.js`**,
  launched by `entrypoint.sh` (`exec node server.js`).
- Iterate with `docker compose build && docker compose up -d` then
  `docker compose logs -f novel-whats`. `.env` must define `DOMAIN` and
  `CLOUDFLARE_TUNNEL_TOKEN` (see `.env.example`).
- `sqlite3` is compiled from source in the image (`npm_config_build_from_source=true`)
  so it links against the container's GLIBC; Puppeteer uses the system Chromium
  (`PUPPETEER_SKIP_DOWNLOAD=true`), not its own download.

### Where the logic lives (improved server)
- **`server.js`** — Express bootstrap: middleware, ensure `media/` exists, init DB, listen.
- **`connect.js`** — opens `data/mydata.db`, creates tables, runs the boot-time `ALTER TABLE`
  migrations and indexes. Exposes `db()` (lazy getter) + `initializeDatabase()`.
- **`messageRouter.js`** — all HTTP routes; thin wrappers over `WhatsappClient`. Note the
  `BB_WIFI_REGEX` (`;interface=wifi`) stripping applied to params/queries — the BB10
  client appends that suffix and it must be scrubbed everywhere.
- **`WhatsappClient.js`** (~40 KB, the core) — owns three in-memory maps keyed by phone
  number: `clients`, `authenticatedClients`, `qrcodes`. **All session state is in-memory
  and lost on container restart** (the `.wwebjs_auth` volume only persists the WA login,
  not these maps; clients re-init on demand via `/api/startclient`). `startClient()` wires
  the WA event handlers — `message` (incoming), `message_create` (the single DB writer,
  incl. fromMe), `message_reaction`. Helpers worth knowing: `normalizeAddr`, `fmtTs`,
  `persistMedia`, `extractQuoted`, `fetchProfilePicUrlSafe`, `resolveContactName`.
- **`login.html`** is patched at container start by `entrypoint.sh` (rewrites
  `nokia4ever.com` → `$DOMAIN`, drops `:80`, forces `https://`). Edits to hard-coded URLs
  in that file are overwritten on every boot — change `entrypoint.sh` instead.

---

## Step-by-Step Guide

### 1. Directories
```bash
mkdir -p /home/max/novel-whats-srv/data
mkdir -p /home/max/novel-whats-srv/media
```
Mounted as Docker volumes:
- `./data` → `/app/data/mydata.db` (SQLite database)
- `./media` → `/app/media/` (media files)
- `./wwebjs_auth` → `/app/.wwebjs_auth` (WhatsApp session)
- `./cache` → `/app/cache` (profile-pic cache)

### 2. Environment Variables
```bash
cp .env.example .env
nano .env
```
| Variable | Description | Example |
|---|---|---|
| `DOMAIN` | Public Cloudflare tunnel domain | `whatsnovel.immichalbum.com` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Zero Trust tunnel token | `eyJhIjoixxxxxxx...` |
| `PORT` | Internal server port (do not change) | `80` |
| `DISPLAY_TZ` | Timezone for message timestamps (optional) | `Europe/Madrid` |

### 3. Build & Run with Docker Compose
```bash
cd /home/max/novel-whats-srv
docker compose build         # First time or after code changes (~85s with cache)
docker compose up -d         # Start in the background
docker compose logs -f       # Live logs
```

### 4. Cloudflare Zero Trust Tunnel
1. **Cloudflare Dashboard → Zero Trust → Networks → Tunnels** → create a *Cloudflared* tunnel.
2. Copy the **token** from the Docker command shown → paste it into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. In **Public Hostname** add a rule: **Service:** `http://novel-whats:80`.
4. Verify the status turns **Healthy**.

### 5. First Authentication — QR Scan
The WhatsApp client **does not start automatically**; it initializes on demand.
1. Open `https://<DOMAIN>/login` in a browser (or hit `GET /api/startclient/<number>`).
2. Select country and phone number → press *Start*.
3. Scan the QR with WhatsApp → **Linked devices → Link a device**.
4. The log confirms: `Client is ready!`

The session is stored in `./wwebjs_auth/` (persistent volume), so a rebuild does
**not** require re-scanning the QR. `entrypoint.sh` patches `login.html` on each
start to rewrite `http://nokia4ever.com:80` → `https://<DOMAIN>` (avoids Mixed Content).

### 6. Configure Novel Messenger on the BlackBerry Q20
1. After authenticating: `GET https://<DOMAIN>/api/login/<number_with_prefix>`
2. In **Novel Messenger (BB10)**: **Server** = `https://<DOMAIN>`, **Token** = value returned above.

### 7. Maintenance
```bash
docker compose down                          # Stop
docker compose build && docker compose up -d # Update code & redeploy
docker compose logs -f novel-whats           # Logs
cp ./data/mydata.db ./data/mydata.db.bak     # Backup DB
```

---

## System Architecture

```
BlackBerry Q20 (Novel Messenger BB10)
        │  HTTPS
        ▼
Cloudflare Edge ──── Zero Trust Tunnel ────► cloudflared (container)
                                                    │ internal HTTP
                                                    ▼
                                          novel-whats (container)
                                          Node.js + headless Chromium
                                          whatsapp-web.js
                                                    │
                                          ┌─────────┴──────────┐
                                       ./data/             ./media/
                                     mydata.db          media files
                                     (SQLite)
                                                    │
                                                    ▼
                                            WhatsApp network
```

---

## API Endpoints (improved version)

| Method | Path | Description |
|---|---|---|
| `GET` | `/login` | Login page + QR generation |
| `GET` | `/login-status/:phone` | Auth status + QR data |
| `GET` | `/:country/:phone/start` | Start the WhatsApp client for that number |
| `GET` | `/api/startclient/:mobile` | Idempotent client start for a registered number |
| `GET` | `/api/login/:user` | BB10 login — returns pushname, user, platform |
| `GET` | `/api/logout/:user` | Destroy the client session |
| `GET` | `/api/contact/:user/:contactId` | Contact info (name, phone, about) — resolves `@lid` |
| `GET` | `/api/chats/:receiver` | Conversation list (paginated; includes `unreadCount`, `lastFromMe`) |
| `GET` | `/api/messages/:receiver/:sender` | Messages of a conversation (paginated) |
| `POST` | `/api/messages` | Send a text message (optional `quotedMessageId` for replies) |
| `POST` | `/api/react` | React to a message (`{ sender, waId, emoji }`; `emoji:''` clears) |
| `POST` | `/api/upload` | Send a media file |
| `POST` | `/api/mark-read/:user/:contactId` | Reset the unread counter for a chat |
| `GET` | `/api/contacts/:user` | Saved contacts (full list by default; searchable) |
| `GET` | `/api/mediafile/:filename` | Download a received media file |
| `GET` | `/api/profilepic/:user/:contactId` | Contact profile picture (cached) |
| `GET` | `/api/allchats/:user` | Live chats from WA (no DB) |
| `GET` | `/api/allmessages/:user/:chatId` | Live messages from WA (no DB) |
| `GET` | `/listusers` | Active sessions (HTML) |

---

## Technical Notes (non-obvious quirks)

### Infrastructure
- The server uses **whatsapp-web.js** with **headless Chromium** (`--no-sandbox`).
- Port 80 is only exposed on localhost (`127.0.0.1:3000`); external access always goes through the Cloudflare tunnel (HTTPS).
- `shm_size: 256mb` in Docker is required so Chromium doesn't crash from low shared memory.

### Multi-Device identities (`@lid`)
WhatsApp uses the **LID** format (`number@lid`) for multi-device identities instead
of `number@c.us`. **A LID is an opaque identifier, NOT a phone number.** The real
phone number is resolved via `client.getContactById(lid).number` (verified:
`222337689452755@lid` → `34664687499`). `normalizeAddr()` preserves the existing
suffix (`@c.us`, `@lid`, `@g.us`) instead of corrupting it.

### Profile pictures (library workaround)
`client.getProfilePicUrl()` is **broken** in the current WhatsApp Web build (throws
`TypeError: Cannot read properties of undefined (reading 'isNewsletter')` inside
`requestProfilePicFromServer`). The working path is
`window.Store.ProfilePicThumb.find(wid)` via `pupPage.evaluate`, which returns a
model with `.eurl`. Implemented in `fetchProfilePicUrlSafe()`; results cached on disk for 24h.

### Server-authoritative timestamps
The BlackBerry Q20 has an outdated tz database and applies the wrong DST (message
times showed 1h behind). The **server is the source of truth for time**: `fmtTs()`
formats every timestamp in `DISPLAY_TZ` (default `Europe/Madrid`) via `Intl` (ICU,
no OS tzdata needed). The app displays the time verbatim, with no timezone math.

### Single writer for outgoing messages
`sendMessage` (text) and `uploadMedia` (media) **only send** to WhatsApp. The
`message_create` event (fromMe) is the **single writer** that inserts into the DB
and downloads media via the shared `persistMedia()` helper. This mirrors how text
already worked and eliminates the duplicate "image + default image" race. Dedup is
by `wa_id`.

### Reactions & emoji quirks (non-obvious)
- A reaction does **not** change a message's timestamp, so the app can't detect it by
  "newest message id". The client computes a **reaction signature** (id+emoji per
  message) and refreshes when it changes (without auto-scrolling to the bottom).
- BB10's runtime (≈Android 4.3, no color-emoji font) can't draw many emoji. The
  palette is curated to the classic set, and the **U+FE0F variation selector is
  stripped** — with it, symbols like ❤ ✌ ✈ ☀ ⏰ ⭐ ✅ ❌ render as tofu; the bare
  codepoint renders. Emoji are still sent as codepoints, so recipients see them in color.

### Image memory (OOM) on the Q20
The Q20 has a small heap; loading photos at full resolution caused spontaneous closes
(`OutOfMemoryError`). Fixes: Picasso `.fit()` downsamples list images to the view size,
camera/gallery photos are decoded with `inSampleSize` (≤1600px) and compressed at 85,
and `android:largeHeap="true"`.

### Database schema
- `messages`: includes `media_filename` (links a message to its media file), `wa_id`
  (dedup), `reaction` (emoji on the message), and `quoted_message`/`quoted_author` (reply).
- `chats`: stores **the last message per conversation**. Invariant: `sender` = the
  contact's address (always), `receiver` = the logged-in user (always),
  `sender_name` = the real contact name. Extra columns: `unread_count`,
  `last_from_me` (1 = I sent it, 0 = received — lets the app skip notifying my own
  messages sent from another device).
- Auto-migrations on boot add new columns if missing. Indexes on `chats(receiver)`,
  `chats(sender)`, `messages(receiver,sender)`, `messages(sender,receiver)`, `messages(wa_id)`.

### Contacts
`/api/contacts` returns only **saved address-book contacts** (`isMyContact`),
excluding self and groups, sorted alphabetically — not every WhatsApp user ever
encountered (`isWAContact` returned 3500+ entries, mostly raw numbers). The full
list is returned by default because the app filters search client-side.

---

## Supported Features
- ✅ Text (send & receive)
- ✅ Images JPG/WebP (send & receive)
- ✅ Audio OGG→MP3 (receive with FFMPEG conversion; record & send from BB10)
- ✅ Video MP4→3GP (receive with FFMPEG conversion)
- ✅ Contact profile pictures (cached)
- ✅ Multi-device sync (message_create events)
- ✅ Unread-message badge (red dot), cleared on chat open
- ✅ Add contacts to the phone book (real phone resolved via the server)
- ✅ Contact info dialog (name, phone, about)
- ✅ Reactions (emoji): send via long-press; receive via `message_reaction`
- ✅ Quoted replies (long-press → Reply; quoted block shown in the bubble)
- ✅ Stickers (receive; webp→png, transparent; animated shows the first frame)
- ❌ Send stickers (no picker on BB10), location, groups
- ❌ Animated stickers playback (only the first frame is shown)

---

## Improvements over upstream (summary)
- `@lid` multi-device address handling (no more `number@lid@c.us` corruption).
- Working profile pictures via `ProfilePicThumb.find` (upstream `getProfilePicUrl` is broken).
- Server-authoritative timestamps (fixes the Q20's 1h-behind clock).
- Single-writer message persistence (`message_create` + `persistMedia`) — no duplicate media.
- `unread_count` + `last_from_me` columns; unread badge and correct notification filtering.
- Saved-contacts-only contact list.
- Media send from the app (images + recorded audio), camera photos.
- Message reactions and quoted replies (`/api/react`, `quotedMessageId`; `reaction`/
  `quoted_message`/`quoted_author` columns). The app refreshes on a reaction
  signature because reactions don't change a message's timestamp.
- Sticker rendering (server webp→png keeps alpha + first frame; client uses
  fitCenter, no person placeholder).
- Emoji palette curated for the BB10 font (classic Unicode set, U+FE0F stripped to
  avoid tofu) and a dark input caret.
- App stability hardening (single RequestQueue, handler/lifecycle cleanup, null-context
  guards) + OOM fixes: Picasso `.fit()` downsampling, sampled camera/gallery decode,
  `largeHeap`.
```
