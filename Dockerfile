# ── Stage 1: Build the React frontend ────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install

COPY frontend/ .
RUN npm run build

# ── Stage 2: Python backend, serving the built SPA directly ──────────────────
FROM python:3.12-slim

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend-builder /build/frontend/dist /app/static

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION:-0.1.0}
# The version is ALSO written to a file the app reads first: a container re-created from an older one can carry
# that older container's APP_VERSION environment variable (the updater used to copy the whole environment), which
# made a fully updated app still report the old version.
RUN echo "${APP_VERSION:-0.1.0}" > /app/VERSION

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
