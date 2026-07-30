# Diagnostic snapshot API

CursorRemote exposes a **Diagnostic ID** in the web UI composer bar and in `/debug/info`. The ID identifies the running relay instance (Crockford base32, stable for the process lifetime). It is **not** a secret and does **not** grant access by itself.

Use the snapshot API when an agent (or human) reads the ID from a screenshot and needs a self-service bundle of Cursor DOM, screenshot, server state, and optional web-client DOM.

## Security

- All `/debug/snapshot` requests require the same auth as other `/debug/*` routes:
  - Web session cookie or `Authorization: Bearer <session-token>` after login, **or**
  - `Authorization: Bearer <DIAGNOSTIC_TOKEN>` when `WEBAPP_PASSWORD` is set and `DIAGNOSTIC_TOKEN` is configured in env.
- Wrong or missing auth → `401`.
- Wrong `id` (not this relay) → `404`.
- Responses use `Cache-Control: no-store`. DOM/screenshot content is not logged or written to disk by the server.
- **Warning:** responses contain raw sensitive data (chats, code, paths, terminals). Treat like production secrets.

## Design: part-based endpoints

We use `GET /debug/snapshot?id=<ID>&part=<part>` instead of one giant JSON blob because:

- Cursor chat DOM alone can be up to **5 MiB**; screenshots add another large base64 payload.
- Agents can fetch only what they need (`state`, `screenshot`, …).
- `part=all` still exists for convenience but may be heavy; prefer individual parts for automation.

**Web client visual:** PNG capture of the mobile web UI is **not** implemented server-side (would require unreliable in-browser canvas/html2canvas or a headless browser). The API returns web **DOM** via a short-lived socket request to connected clients. For a web UI screenshot, use your browser automation tool on the client URL.

## Quick start (agent)

1. Read Diagnostic ID from UI (composer bar) or Debug sheet, e.g. `7K9M2P4Q`.
2. Authenticate (session token or `DIAGNOSTIC_TOKEN`).
3. Discover parts:

```bash
curl -s -H "Authorization: Bearer $DIAGNOSTIC_TOKEN" \
  "http://127.0.0.1:4174/debug/snapshot?id=7K9M2P4Q&part=meta"
```

4. Fetch pieces:

```bash
# Sanitized state + metadata
curl -s -H "Authorization: Bearer $DIAGNOSTIC_TOKEN" \
  "http://127.0.0.1:4174/debug/snapshot?id=7K9M2P4Q&part=state" \
  -o state.json

# Active composer DOM (HTML)
curl -s -H "Authorization: Bearer $DIAGNOSTIC_TOKEN" \
  "http://127.0.0.1:4174/debug/snapshot?id=7K9M2P4Q&part=cursor-dom&scope=chat" \
  -o cursor-chat.html

# Cursor window PNG (JSON with dataBase64)
curl -s -H "Authorization: Bearer $DIAGNOSTIC_TOKEN" \
  "http://127.0.0.1:4174/debug/snapshot?id=7K9M2P4Q&part=screenshot" \
  -o screenshot.json

# Web client DOM (requires connected browser tab)
curl -s -H "Authorization: Bearer $DIAGNOSTIC_TOKEN" \
  "http://127.0.0.1:4174/debug/snapshot?id=7K9M2P4Q&part=web-dom" \
  -o web-client.html
```

5. Optional combined bundle:

```bash
curl -s -H "Authorization: Bearer $DIAGNOSTIC_TOKEN" \
  "http://127.0.0.1:4174/debug/snapshot?id=7K9M2P4Q&part=all" \
  -o bundle.json
```

## Parts

| `part` | Response | Notes |
|--------|----------|--------|
| `meta` (default) | JSON index, warnings, part URLs | Start here |
| `state` | JSON sanitized relay/Cursor context | Includes `activeConversationContext` |
| `cursor-dom` | HTML | `scope=chat` (default) or `document`; max 5 MiB |
| `screenshot` | JSON `{ format, dataBase64, bytes }` | Parallel CDP connection; max ~2 MiB |
| `web-dom` | HTML or JSON error | Socket to web client, ~5 s timeout |
| `all` | JSON combining above | May be large |

## Limits and errors

| Code | HTTP | Meaning |
|------|------|---------|
| `unauthorized` | 401 | No valid session or diagnostic token |
| `diagnostic_id_mismatch` | 404 | `id` does not match this relay |
| `id_required` | 422 | Missing `id` query |
| `snapshot_busy` | 503 | Another snapshot already running |
| `too_large` / `screenshot_too_large` | 413 | Size limit exceeded |
| `timeout` / `screenshot_timeout` | 504 | CDP or client timed out |

Only **one** snapshot operation runs at a time per relay (shared with DOM export busy lock on export path).

## Environment

```env
WEBAPP_PASSWORD=...          # enables auth on /debug/*
DIAGNOSTIC_TOKEN=...         # optional agent Bearer for /debug/* without browser session
DOM_EXPORT_MAX_BYTES=5242880 # optional; cursor DOM limit (default 5 MiB)
```

## UI

- **Composer input bar:** small `ID xxxxx` badge (top-right), tap/click copies ID. Visible in subagent “return to parent” mode too.
- **Debug sheet:** Diagnostic ID row and snapshot API hint.
