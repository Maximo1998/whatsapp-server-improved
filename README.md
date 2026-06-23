# whatsapp-server-improved
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE) [![Node.js](https://img.shields.io/badge/Node.js-16%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org) [![whatsapp-web.js](https://img.shields.io/badge/whatsapp--web.js-latest-25D366?logo=whatsapp&logoColor=white)](https://github.com/pedroslopez/whatsapp-web.js) [![Buy Me A Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%23FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/maxlakh1m)


A self-hosted WhatsApp bridge server that lets a modified **BlackBerry Q20** (running
the *Novel Messenger* BB10 client) send and receive WhatsApp messages, keeping all
data on your own machine.

> **This is a fork of [NovelProfessor's whatsapp-server](https://github.com/NovelProfessor/whatsapp-server)**
> (project site: [nokia4ever.com](http://nokia4ever.com),
> YouTube: [@NovelProfessor](https://youtube.com/@NovelProfessor)).
> It keeps the same overall design — Node.js + Express + [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
> driving headless Chromium — but adds many bug fixes and features on top.

## What this fork adds over upstream

- **`@lid` multi-device support.** WhatsApp multi-device identities use `number@lid`
  (an opaque id, *not* a phone number). Addresses are normalized without corruption,
  and the real phone is resolved via `getContactById(lid).number`.
- **Working profile pictures.** `client.getProfilePicUrl()` is broken on current
  WhatsApp Web builds (throws an `isNewsletter` error); this fork fetches the photo
  URL via `window.Store.ProfilePicThumb.find(wid)` and caches it on disk for 24h.
- **Server-authoritative timestamps.** Old BlackBerry devices apply the wrong DST.
  The server formats every timestamp in `DISPLAY_TZ` (default `Europe/Madrid`) and
  the client shows it verbatim, so message times are always correct.
- **No duplicate media.** Outgoing messages are persisted by a single writer (the
  `message_create` event + a shared `persistMedia` helper), eliminating the
  "image + broken default image" duplication.
- **Unread badge + smart notifications.** `chats` has `unread_count` and
  `last_from_me`, so the client shows an unread counter and never notifies for
  messages you sent from another device.
- **Saved-contacts-only list.** `/api/contacts` returns your address-book contacts
  (`isMyContact`), not every WhatsApp user you ever encountered.
- **Media from the client**, image/audio/video conversion via FFMPEG, and contact info.

## Stack

- **Node.js 20** + **Express**
- **whatsapp-web.js** + **headless Chromium** (`--no-sandbox`)
- **SQLite** (via `sqlite`/`sqlite3`) for chats and messages
- **FFMPEG** for media conversion (OGG↔MP3, MP4→3GP)
- Designed to run in **Docker**, exposed through a **Cloudflare Zero Trust tunnel**

## Files

| File | Purpose |
|---|---|
| `server.js` | Express app bootstrap, static files, DB init |
| `connect.js` | SQLite schema, migrations, indexes |
| `messageRouter.js` | HTTP routes / API endpoints |
| `WhatsappClient.js` | whatsapp-web.js client lifecycle, message handling, media, profile pics, contacts |

## Running

This server is normally run from the parent deployment via Docker Compose
(`docker compose up -d`). See the deployment's `CLAUDE.md`/`docker-compose.yml` for
the full setup (volumes for `data/`, `media/`, `wwebjs_auth/`, `cache/`, and the
Cloudflare tunnel). The WhatsApp client initializes on demand — open `/login` or
call `GET /api/startclient/<number>` and scan the QR once.

## API (summary)

`/login`, `/login-status/:phone`, `/:country/:phone/start`,
`/api/startclient/:mobile`, `/api/login/:user`, `/api/logout/:user`,
`/api/contact/:user/:contactId`, `/api/chats/:receiver`,
`/api/messages/:receiver/:sender`, `POST /api/messages`, `POST /api/upload`,
`POST /api/mark-read/:user/:contactId`, `/api/contacts/:user`,
`/api/mediafile/:filename`, `/api/profilepic/:user/:contactId`,
`/api/allchats/:user`, `/api/allmessages/:user/:chatId`, `/listusers`.

## Credits

Original work by **Novel Professor** ([nokia4ever.com](http://nokia4ever.com)).
This fork is maintained for a personal self-hosted BlackBerry Q20 setup.

## License

Inherits the licensing of the upstream project. Use at your own risk; this is an
unofficial bridge that automates WhatsApp Web and may break against WhatsApp updates.
