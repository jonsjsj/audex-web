# Audex Web

Self-hosted, browser version of [Audex](https://github.com/jonsjsj/codexaudio) — library,
audio player, ebook reader, and word-sync read-along, syncing with your own
Audiobookshelf server and (optionally) [Codex](https://github.com/jonsjsj/codex).

Phases 0-1 of the plan are done: sign-in (SSO or Audiobookshelf credentials), and a
first real MVP — browse/search your library and listen to an audiobook in the browser
(streaming, chapters, speed, sleep timer, resume, OS media controls). The ebook reader,
Codex sync, and read-along land in the phases after this one.

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

`/api/health`, `/api/auth/*`, `/api/library/*` (libraries, items, item detail, cover
proxy), `/api/play/*` (start/sync/close an ABS session), `/api/stream` (range-request
audio proxy) today. See the plan (§4) for the full surface as later phases land:
`/api/read`, `/api/readalong`, `/api/progress` (which also pushes to Codex's webhook —
the same call the Android app makes — so a web session shows up on Codex immediately).
