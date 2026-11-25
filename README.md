# Hollow Hours

A night-time, top-down arena brawler: eight live 3D fighters, room codes for PvP, and a 20-level quest
with four bosses. The same game page runs as a Claude artifact and on this server.

## Layout
- `game/index.html` — the whole game (canvas + three.js). Edit this file.
- `public/net.js` — sign-in screen and the room connector (WebSocket) the game uses here.
- `public/admin.html` — the owner login monitor at `/admin`.
- `server.js` — Express + WebSocket rooms, Google sign-in / guests, login record.

## Run locally
```
npm install && npm run build && npm start   # http://localhost:3000
```

## Render settings (Environment)
| Key | What it does |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth web client ID. Add this site's URL to the client's *Authorised JavaScript origins*. |
| `OWNER_EMAILS` | Comma-separated Google emails allowed to open `/admin`. |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Optional owner Drive connection: keeps the login record in a Google Sheet ("Hollow Hours — login record") instead of memory only. |
| `SESSION_SECRET` | Long random string so sign-ins survive restarts (the blueprint generates one). |
| `ALLOW_GUESTS` | Set to `0` to require Google sign-in. |

© Matthew Wong. All rights reserved.
