# Audex Web

Self-hosted, browser version of [Audex](https://github.com/jonsjsj/codexaudio) — library,
audio player, ebook reader, and word-sync read-along, syncing with your own
Audiobookshelf server and (optionally) [Codex](https://github.com/jonsjsj/codex).

Phases 0-3 of the plan are done: sign-in (SSO or Audiobookshelf credentials), the audio
player (streaming, chapters, speed, sleep timer, resume, OS media controls), the ebook
reader (an in-house EPUB parser feeding a real @readium/navigator, font size + position
sync to ABS), and now Codex sync — link your own Codex API key from Settings and audio
progress pushes to Codex's webhook in real time, the same call the mobile app makes.
Read-along lands in the phase after this one.

## Run it

```bash
cp .env.example .env
# edit .env: at minimum set ABS_URL and a random SECRET_KEY
docker compose up -d --build
```

Open `http://localhost:8420` (or whatever `AUDEX_WEB_PORT` you set).

## Sign-in

- **SSO (recommended)** — set `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` to
  register audex-web as an OIDC application in your identity provider (tested against
  [Authentik](https://goauthentik.io/)). First SSO login prompts once to connect an
  Audiobookshelf account; every login after that is pure SSO.
- **Audiobookshelf credentials** — leave the `OIDC_*` variables blank, or use the "Use
  your Audiobookshelf account" fallback shown even when SSO is configured.

Either way, the browser never receives an Audiobookshelf token or an OIDC client
secret — see `backend/app/api/auth.py` for the session model.

## Codex sync

Set `CODEX_URL` to your Codex instance (server-wide — a household shares one Codex).
Each signed-in person then links their OWN account from Settings: generate an API key
in Codex (Settings → API Keys) and paste it in. This is per-person, not per-server, the
same as the mobile app's own Settings → Codex sync — a single shared token would
attribute everyone's progress to whichever one Codex account it belongs to.

## Development

```bash
# backend
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# frontend (separate terminal)
cd frontend && npm install && npm run dev
```

The Vite dev server proxies `/api/*` to `:8000` (see `frontend/vite.config.ts`), so the
SPA and API behave the same in dev as they do same-origin in the built container.

## API

`/api/health`, `/api/auth/*` (including `/link/codex`, `/unlink/codex`), `/api/library/*`
(libraries, items, item detail, cover proxy), `/api/play/*` (start/sync/close an ABS
session — sync/close also push to Codex's webhook when linked), `/api/stream`
(range-request audio proxy), `/api/read/*` (RWPM manifest, per-resource proxy, position
get/save) today. See the plan (§4) for the full surface as the read-along phase lands:
`/api/readalong`.
