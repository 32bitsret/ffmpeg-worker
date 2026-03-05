# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install     # Install dependencies
npm start       # Run the server (node index.js)
```

No test suite exists. To test locally, start the server and send HTTP requests to `http://localhost:3001`.

## Architecture

This is a single-file Express HTTP service (`index.js`) that performs FFmpeg video processing and uploads results to Cloudflare R2.

### Endpoints

- `POST /composite` — Downloads a video/image clip + optional voiceover audio, applies text overlay and optional watermark via FFmpeg, uploads the output to R2, returns `{ outputUrl }`.
- `POST /render` — Concatenates multiple video clips (via FFmpeg concat demuxer), mixes in optional background music, uploads to R2, returns `{ outputUrl }`.
- `GET /health` — Returns `{ ok: true }`.

### Key design patterns

- All video processing is done via `fluent-ffmpeg` wrapping `@ffmpeg-installer/ffmpeg`.
- Files are downloaded to OS temp dir, processed, uploaded, then cleaned up in `finally` blocks.
- Structured JSON logs are emitted via `slog(step, msg, data)` throughout.
- The `backgroundType` field controls `/composite` behavior: `'cinematic'`/`'video'`/`'canvas'` use a video input; `'image'` uses a static image looped for the duration.
- `isTemplate` (when `backgroundType === 'canvas'`) enables centered text overlay and dynamic font sizing based on text length; non-template mode places text near the bottom.
- Canvas background color is resolved from `canvasColor` hex > `canvasStyle` preset (`white`/`dark`/`muted`) > default dark.

### Required environment variables

```
CLOUDFLARE_R2_ACCOUNT_ID
CLOUDFLARE_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_SECRET_ACCESS_KEY
CLOUDFLARE_R2_BUCKET_NAME
CLOUDFLARE_R2_PUBLIC_URL
PORT                          # optional, defaults to 3001
```

### Deployment

Deployed on Railway using Nixpacks. `nixpacks.toml` provisions `nodejs_20`, `ffmpeg`, `freefont_ttf`, and `fontconfig`. The `detectFont()` function at startup probes several known font paths (including the Nix store) to find a usable TTF for FFmpeg's `drawtext` filter.
