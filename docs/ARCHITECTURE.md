# Voice-to-Notion Architecture

## System Overview

Voice-to-Notion is a self-hosted media transcription pipeline that captures voice memos, URLs, photos, and media files from multiple input sources and writes structured notes to Notion or Obsidian. It runs as a single Node.js worker process inside a Docker container alongside a Scriberr (WhisperX) transcription server.

Four pipelines + an admin server run in parallel inside the worker:

1. **Scriberr Sync** -- polls Scriberr for completed transcripts and syncs them to Notion (with Groq fallback for empty transcripts)
2. **Media Pipeline** -- watches an inbox directory for URLs and media files, downloads/transcribes them
3. **Telegram Bot** -- mobile capture layer accepting URLs, voice notes, photos, and media files
4. **Admin API** -- lightweight HTTP server for remote state management (retry, abandon, health check)

```
                           INGESTION SOURCES
  +------------------+  +------------------+  +------------------+
  |  Voice Memos     |  |  inbox_media/    |  |  Telegram Bot    |
  |  (iOS Shortcut)  |  |  (.txt, .mp3,    |  |  (URLs, voice,   |
  |                  |  |   .mp4, .json)   |  |   photos, media) |
  +--------+---------+  +--------+---------+  +--------+---------+
           |                      |                      |
           v                      v                      v
  +------------------+  +------------------+  +------------------+
  |    Scriberr      |  |  Media Pipeline  |  |  TelegramBot     |
  |    (WhisperX)    |  |  (orchestrator)  |  |  (Telegraf)      |
  +--------+---------+  +--------+---------+  +--------+---------+
           |                      |                      |
           |           +----------+----------+           |
           |           |          |          |           |
           |           v          v          v           |
           |      +--------+ +--------+ +--------+     |
           |      | yt-dlp | | ffmpeg | | YT Sub | +--------+
           |      +--------+ +--------+ +--------+ | Gemini |
           |                      |                 | (OCR)  |
           |                      v                 +--------+
           |           +------------------+              |
           |           | Groq (cloud) or  |              |
           |           | Scriberr (local) |              |
           |           | transcription    |              |
           |           +--------+---------+              |
           |                    |                        |
           +--------------------+------------------------+
                                |
                    +-----------+-----------+
                    |                       |
               +----v-----+          +-----v----+
               |  Notion  |          | Obsidian |
               |  (API)   |          | (REST)   |
               +----------+          +----------+
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 (Alpine Docker) |
| Transcription (local) | Scriberr / WhisperX |
| Transcription (cloud) | Groq Whisper API |
| Media download | yt-dlp (Python) |
| Audio extraction | ffmpeg |
| OCR | Google Gemini 2.5 Flash |
| Title generation | Groq LLM (llama-3.3-70b) |
| Telegram | Telegraf (long-polling) |
| Destination (primary) | Notion API (FileUpload API for attachments) |
| Destination (alt) | Obsidian Local REST API |
| Admin API | Node built-in `http` module |
| Container orchestration | Docker Compose |
| macOS persistence | launchd |

---

## Directory Structure

```
voice-to-notion/
  src/
    index.js              Entry point -- wires up all pipelines
    scriberr.js           Scriberr API client (JWT auth, auto-refresh)
    notion.js             Notion API client (page creation, file uploads)
    obsidian.js           Obsidian vault client (Local REST API)
    sync.js               Pipeline 1: Scriberr poll/sync worker (+ Groq fallback)
    media-pipeline.js     Pipeline 2: URL + file ingestion orchestrator
    telegram-bot.js       Pipeline 3: Telegram mobile capture
    admin.js              Pipeline 4: Admin HTTP API (state management)
    groq-transcriber.js   Groq Whisper + LLM (transcription + titles)
    media-downloader.js   yt-dlp wrapper
    audio-extractor.js    ffmpeg wrapper
    yt-transcript.js      YouTube subtitle fetcher
    ocr.js                Gemini 2.5 Flash OCR
  scripts/
    boot.sh               Docker startup with health checks
    launchd-start.sh      macOS launchd startup wrapper
    ingest-url.js         CLI: ingest a URL (direct or inbox mode)
    ingest-file.js        CLI: ingest local files (picker or glob)
    test-connection.js    Connection verification
  test/
    unit/                 Vitest unit tests (one per source module)
  data/
    inbox_media/          Drop zone for URL files and media
    processed/            Completed files moved here
    .sync-state.json      Persistent sync state
  docker-compose.yml      Scriberr + worker + network
  Dockerfile              Worker image (node + yt-dlp + ffmpeg)
  .env.example            Environment variable template
```

---

## Pipeline 1: Scriberr Sync

**Module:** `src/sync.js` (SyncWorker class)

Polls Scriberr every 30 seconds (configurable) for completed transcription jobs and syncs each to Notion/Obsidian.

```
Scriberr (completed jobs)
    |
    v
SyncWorker.sync()
    |
    +-- Fetch job list (GET /api/v1/transcription/list)
    +-- Filter: completed, not already synced, under retry limit
    +-- For each job:
    |     +-- Fetch transcript text (GET /api/v1/transcription/{id}/transcript)
    |     +-- If empty + Groq available:
    |     |     +-- Download audio (GET /api/v1/transcription/{id}/audio)
    |     |     +-- Re-transcribe via Groq Whisper API
    |     +-- Download audio file for attachment
    |     +-- Upload audio to Notion (FileUpload API) or Obsidian vault
    |     +-- Create page with transcript + audio block/embed
    |     +-- Mark as synced in state file
    |
    +-- Save state to data/.sync-state.json
```

**Groq fallback:** When Scriberr returns an empty transcript (e.g. Whisper produced nothing from silent/low-quality audio), the sync worker downloads the audio file and re-transcribes via Groq's Whisper API. This catches cases where local Whisper fails but cloud Whisper succeeds.

**State persistence:** Synced job IDs and failed job retry counts (with exponential backoff) are stored in `.sync-state.json`. Jobs that fail 10 times (default, configurable via `MAX_SYNC_RETRIES`) are permanently skipped. State can be managed remotely via the Admin API.

**Intended input path:** iOS Voice Memos via Shortcuts app, or drag-drop into Scriberr's web UI.

---

## Pipeline 2: Media Pipeline

**Module:** `src/media-pipeline.js` (MediaPipeline class)

Watches `inbox_media/` every 15 seconds for URL files (`.txt`, `.json`, `.url`) and media files (`.mp3`, `.mp4`, etc). Also exposes `ingest(url)` and `ingestFile(path)` methods called by the Telegram bot and CLI scripts.

### URL Ingestion Flow

```
URL received (from file, Telegram, or CLI)
    |
    v
1. YouTube transcript fetch (yt-transcript.js)
   |-- Try manual subtitles first
   |-- Fall back to auto-generated subtitles
   |-- Returns null if not YouTube or no subs available
    |
    v
2. Download media via yt-dlp (media-downloader.js)
   |-- Audio-only extraction by default
   |-- Returns: filePath, title, duration, sourceType
    |
    v
3. If no transcript from step 1:
   |-- Check if file is audio-only (ffprobe)
   |-- Extract audio from video if needed (ffmpeg)
   |-- Transcribe: Groq (cloud, <25MB) -> Scriberr (local fallback)
    |
    v
4. Upload audio file to Notion (FileUpload API)
    |
    v
5. Create Notion page
   |-- Title from yt-dlp metadata
   |-- Transcript as paragraph blocks
   |-- Audio attachment block
   |-- Metadata callout (duration, language)
```

### Local File Ingestion Flow

```
Local file received (inbox drop, Telegram, or CLI)
    |
    v
1. Detect audio vs video (ffprobe)
   |-- Audio: convert to target format if needed
   |-- Video: extract audio via ffmpeg
    |
    v
2. Transcribe: Groq -> Scriberr fallback
    |
    v
3. Generate title from transcript (Groq LLM, optional)
    |
    v
4. Upload audio + create Notion page
```

### Transcription Routing

The system uses a tiered transcription strategy:

1. **YouTube subtitles** (free, instant) -- checked first for YouTube URLs
2. **Groq cloud** (fast, free tier 8h/day, 25MB limit) -- tried if `GROQ_API_KEY` is set
3. **Scriberr/WhisperX** (local, no limits, slower) -- always-available fallback

---

## Pipeline 3: Telegram Bot

**Module:** `src/telegram-bot.js` (TelegramBot class)

Mobile capture layer using long-polling (no webhook, no exposed ports). Handles:

| Input Type | Handler | Processing |
|-----------|---------|-----------|
| Text with URLs | `handleText` | Extract URLs, route each through `pipeline.ingestUrl()`; non-URL text preserved as quote block |
| Text only | `handleText` | Create "Idea" page via `pipeline.ingestText()`; LLM title if > 100 chars |
| Voice message | `handleFile('voice')` | Download `.ogg`, route through `pipeline.ingestFile()` |
| Audio file | `handleFile('audio')` | Download, route through `pipeline.ingestFile()` |
| Video / video note | `handleFile('video')` | Download `.mp4`, route through `pipeline.ingestFile()` |
| Photo | `handlePhoto` | Download, OCR via Gemini, create page as "Idea" type |
| Image document | `handleDocument` | Same as photo (routes through OCR path) |
| Media document | `handleDocument` | Download, route through `pipeline.ingestFile()` |

### Reply Chain

The bot tracks which Telegram messages created which Notion pages (in-memory Map with 30-minute TTL). When a user replies to a processed message with voice, text, or a photo, the bot appends a "My Take" section to the existing page instead of creating a new one.

```
Original message (URL/voice/photo)
    |
    +-- Creates Notion page
    +-- Tracks: message_id -> pageId (30min TTL)
    |
Reply to original (voice/text/photo)
    |
    +-- Transcribe voice / OCR photo / use text directly
    +-- Append "My Take" heading + content blocks to existing page
    +-- Delete tracking entry
```

### Destination Toggling

The `/mode` command switches the active write destination between Notion and Obsidian at runtime. This swaps the client reference on both the TelegramBot and the MediaPipeline, so all subsequent ingestions go to the new destination.

---

## Pipeline 4: Admin API

**Module:** `src/admin.js` (AdminServer class)

Lightweight HTTP server using Node's built-in `http` module (zero dependencies). Provides remote state management without SSH access.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Uptime, start time, pipeline running status |
| `/state` | GET | Full state: synced IDs, failed jobs with retry counts and time-to-retry |
| `/retry/:jobId` | POST | Remove job from failed queue so it retries on next sync cycle |
| `/retry-all` | POST | Clear all failed jobs for immediate retry |
| `/abandon/:jobId` | POST | Move job from failed to synced (permanently skip) |

**Configuration:** `ADMIN_PORT` env var (default: 9200).

**Security:** The admin API has no authentication -- it's intended for use on localhost or behind a reverse proxy / SSH tunnel. Do not expose port 9200 directly to the internet.

**HTTPS:** For remote access, use one of:
- SSH tunnel: `ssh -L 9200:localhost:9200 user@host`
- Reverse proxy: nginx or Caddy with TLS termination
- Tailscale / WireGuard: access via private network

---

## External Service Dependencies

| Service | Role | Required? | Module |
|---------|------|-----------|--------|
| **Scriberr** | Local WhisperX transcription server | Yes (core) | `scriberr.js` |
| **Notion API** | Note storage with database, file uploads | Yes (default dest) | `notion.js` |
| **Obsidian Local REST API** | Alternative note storage | No (alt dest) | `obsidian.js` |
| **Groq API** | Cloud Whisper transcription + LLM title generation | No (speedup) | `groq-transcriber.js` |
| **Telegram Bot API** | Mobile capture interface | No (convenience) | `telegram-bot.js` |
| **Google Gemini** | Photo/image OCR | No (photo feature) | `ocr.js` |
| **yt-dlp** | Media downloading from URLs | Yes (media pipeline) | `media-downloader.js` |
| **ffmpeg/ffprobe** | Audio extraction and format conversion | Yes (media pipeline) | `audio-extractor.js` |

### Authentication Methods

- **Scriberr:** JWT (auto-register on first run, auto-refresh on 401)
- **Notion:** Bearer token (static API key)
- **Obsidian:** Bearer token (plugin-generated key, self-signed TLS)
- **Groq:** Bearer token (static API key)
- **Telegram:** Bot token (from BotFather)
- **Gemini:** API key (passed to SDK constructor)

---

## Configuration Reference

All configuration is via environment variables (`.env` file). Grouped by service:

### Destination

| Variable | Description | Default |
|----------|-------------|---------|
| `DESTINATION` | Active destination: `notion` or `obsidian` | `notion` |

### Notion

| Variable | Description | Default |
|----------|-------------|---------|
| `NOTION_API_KEY` | Integration secret from notion.so/my-integrations | **required** |
| `NOTION_DATABASE_ID` | Target database ID (32-char hex from URL) | **required** |

### Obsidian

| Variable | Description | Default |
|----------|-------------|---------|
| `OBSIDIAN_LOCAL_REST_API_KEY` | API key from Local REST API plugin settings | optional |
| `OBSIDIAN_REST_API_PORT` | REST API port | `27124` |
| `OBSIDIAN_CAPTURE_FOLDER` | Vault folder for new notes | `01_Capture` |

### Scriberr

| Variable | Description | Default |
|----------|-------------|---------|
| `SCRIBERR_API_URL` | Scriberr server URL | set by Docker (`http://scriberr:8080`) |
| `SCRIBERR_USERNAME` | Login username (auto-registers on first run) | **required** |
| `SCRIBERR_PASSWORD` | Login password | **required** |
| `SCRIBERR_PORT` | Host port for Scriberr web UI | `8080` |
| `WHISPER_MODEL` | WhisperX model: tiny/base/small/medium/large-v2/large-v3 | `small` |
| `DEVICE` | Compute device: cpu/cuda | `cpu` |
| `COMPUTE_TYPE` | Precision: float32/int8 (int8 faster on CPU) | `int8` |
| `WHISPER_BATCH_SIZE` | Batch size (lower = less RAM) | `4` |

### Groq (optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `GROQ_API_KEY` | Groq API key from console.groq.com | optional |

### Telegram (optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | optional |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs | optional (open) |

### Gemini (optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Google AI Studio API key | optional |

### Worker Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `POLL_INTERVAL_SECONDS` | Scriberr sync poll interval | `30` |
| `ENABLE_MEDIA_PIPELINE` | Enable/disable media pipeline | `true` |
| `MEDIA_POLL_INTERVAL_SECONDS` | Inbox scan interval | `15` |
| `AUDIO_FORMAT` | Output audio format: mp3/m4a/wav | `mp3` |
| `MEDIA_INBOX_PATH` | Host path for inbox bind mount | `./inbox_media` |
| `MEDIA_PROCESSED_PATH` | Host path for processed files | `./processed` |
| `STATE_FILE` | Sync state file path | `./data/.sync-state.json` |
| `TEMP_DIR` | Temporary file directory | `/tmp/media-pipeline` |
| `MAX_SYNC_RETRIES` | Max retries before abandoning a failed sync job (0=unlimited) | `10` |
| `ADMIN_PORT` | Admin API HTTP port | `9200` |

---

## Notion Database Schema

The worker writes to a Notion database with these properties (auto-created on first run where possible):

| Property | Type | Set By Worker |
|----------|------|--------------|
| Title | title | Media title, filename, or LLM-generated from text |
| Status | select | Always "New" |
| Date Added | date | Current timestamp |
| Type | select | "Audio", "Video", "YouTube", "Idea", "Post", "Article" |
| Source | rich_text | Filepath or URL (auto-created if missing) |
| Source Filename | rich_text | Original filename |
| Processing Time (s) | number | Transcription duration |
| URL | url | Source URL (media pipeline only) |
| Tags | multi_select | Not currently set by worker |
| Project | relation | Not currently set by worker |

Page body contains:
1. Metadata callout block (duration, language)
2. Audio attachment block (if upload succeeded)
3. Image block (for photo/OCR pages)
4. User annotation quote block (if text sent with URL)
5. Summary + Key Points sections (if LLM summarization enabled)
6. Full Transcript/content as paragraph blocks (chunked at 1900 chars)

The Notion API limits pages to 100 blocks per request; overflow blocks are appended via `PATCH /blocks/{id}/children`.

---

## Deployment Architecture

### Docker Compose

Two services on a shared bridge network (`voice2notion_network`):

```
+--------------------------------------------------+
|  Docker Compose                                   |
|                                                   |
|  +-------------------+    +--------------------+  |
|  |    scriberr        |    |   notion-worker    |  |
|  |  (WhisperX)        |    |  (Node.js 20)     |  |
|  |  Port 8080         |<---|  yt-dlp + ffmpeg   |  |
|  |  Volume:           |    |  Volumes:          |  |
|  |   scriberr_data    |    |   worker_data      |  |
|  |  Health: /health   |    |   inbox_media (bind)|  |
|  |  Start period: 15m |    |   processed (bind)  |  |
|  +-------------------+    |   /tmp (bind)       |  |
|                           +--------------------+  |
|                                                   |
|  Network: voice2notion_network (bridge)           |
+--------------------------------------------------+
```

**Startup order:** The worker container depends on Scriberr being healthy (`condition: service_healthy`). Scriberr has a 15-minute start period to allow for initial model download.

**Volumes:**
- `scriberr_data` -- named volume for Scriberr's database and models
- `worker_data` -- named volume for sync state persistence
- `inbox_media` -- bind mount for file drop zone
- `processed` -- bind mount for completed files
- `/tmp/notion-worker` -- bind mount for temp downloads/extraction

### Boot Script (`scripts/boot.sh`)

Sequenced startup with validation:

1. Preflight: Docker running, `.env` exists, required vars set
2. Start Scriberr, wait for healthy (up to 5 minutes)
3. Build and start worker
4. Tail worker logs

### macOS Persistence (`scripts/launchd-start.sh`)

Wrapper for launchd that:
1. Waits up to 120 seconds for Docker daemon (post-login startup delay)
2. Runs `docker-compose up --build` in foreground (no `-d`) so launchd can track the process

To use with launchd, create a plist in `~/Library/LaunchAgents/` pointing to this script.

### Worker Container (Dockerfile)

```
Base:  node:20-alpine
Added: ffmpeg, python3, yt-dlp (pip)
User:  non-root (worker:1001)
Cmd:   npm start
```

The healthcheck is basic (`node -e "console.log('healthy')"`) -- it verifies the Node runtime is responsive but does not check pipeline health.

---

## CLI Tools

### `npm run ingest -- <url>`

Ingests a URL. Two modes:
- **Inbox mode** (default): writes a `.txt` file to `inbox_media/` for the worker to pick up
- **Direct mode** (`DIRECT=1`): runs the full pipeline immediately in the CLI process

### `npm run ingest-file -- <path-or-glob>`

Ingests local media files. Three modes:
- **Single file:** `npm run ingest-file -- /path/to/file.mp4`
- **Glob pattern:** `npm run ingest-file -- "/dir/*.mp4"`
- **Interactive picker:** `npm run ingest-file` (no args, uses enquirer for directory browse + multi-select)

Files are processed in-place -- originals are never modified or moved.

---

## Testing

Tests use **Vitest** with the configuration in `vitest.config.js`:

```
test/
  unit/
    admin.test.js
    audio-extractor.test.js
    groq-transcriber.test.js
    image-upload.test.js
    media-downloader.test.js
    media-pipeline.test.js
    notion.test.js
    scriberr.test.js
    sync.test.js
    telegram-bot.test.js
    yt-transcript.test.js
```

Every source module has a corresponding unit test file. Run with:

```bash
npm test              # vitest run (single pass)
npm run test:watch    # vitest (watch mode)
npm run test:coverage # vitest run --coverage
```

---

## Known Limitations and Issues

### Telegram 20MB File Size Limit

The Telegram Bot API limits file downloads to 20MB. The bot checks `file_size` before downloading and rejects larger files with a message to use the CLI instead. This affects voice messages, videos, and documents sent through Telegram.

### Notion 100-Block Page Limit

Notion's `POST /pages` endpoint accepts a maximum of 100 child blocks. The worker handles this by creating the page with the first 100 blocks, then appending the remainder via `PATCH /blocks/{id}/children` in batches of 100. Very long transcripts (190k+ characters) will require many append calls.

### Multi-Part File Upload

The `notion.js` multi-part upload path (for files >20MB) reads the entire file into memory with `fs.readFileSync()` before slicing into 5MB parts. This is a potential memory concern for very large audio files. A streaming approach using `fs.createReadStream()` with range options would be more memory-efficient.

**Location:** [`src/notion.js`](../src/notion.js) line 112 (`const fileBuffer = fs.readFileSync(filePath)`)

### Reply Chain Memory-Only Storage

The Telegram reply chain tracking (`pendingSources` Map) is stored in memory with a 30-minute TTL. If the worker restarts, all reply chain associations are lost. This is acceptable given the short TTL but means replies after a restart will not match.

### Obsidian File Uploads

The Obsidian client uploads audio files to the vault via the Local REST API's `PUT /vault/` endpoint. Files are stored in `<capture_folder>/attachments/` and embedded in notes as `![[filename.mp3]]`. Obsidian natively renders audio embeds as playable audio players.

Image attachments from photo OCR are not yet uploaded to Obsidian (only the extracted text is included).

### No Concurrent Processing

Both the Scriberr sync and media pipeline process files sequentially within each poll cycle. A batch of 10 URLs in a `.txt` file will be ingested one at a time. This is intentional to avoid overloading Scriberr and Notion APIs but means large batches take proportionally longer.

### Duplicate splitText Implementation

The `splitText()` method is duplicated identically between `NotionClient` and `ObsidianClient`. Both use the same sentence-boundary-aware text chunking logic. This could be extracted to a shared utility.

**Locations:** [`src/notion.js`](../src/notion.js) lines 370-401, [`src/obsidian.js`](../src/obsidian.js) lines 152-175

### Worker Healthcheck

The Docker healthcheck (`node -e "console.log('healthy')"`) only verifies the Node runtime is alive. It does not check whether the pipelines are actually running, whether Scriberr is reachable, or whether Notion authentication is valid. A more robust healthcheck could verify pipeline state.

### Hardcoded Paths in launchd Script

`scripts/launchd-start.sh` has a hardcoded path (`/Users/nick/Downloads/voice-to-notion`). This needs to be updated for any deployment to a different location.

**Location:** [`scripts/launchd-start.sh`](../scripts/launchd-start.sh) line 5

## v3.0: Multi-Format Capture + Auto-Summarization

### New Modules

| Module | Purpose |
|---|---|
| `summarizer.js` | LLM summarization via Groq Llama 3.3 70B. Content-type-aware prompts for video, article, tweet, PDF. Returns { title, keyPoints[], summary }. |
| `content-router.js` | Regex-based URL classification. Routes to correct extractor: YouTube, Twitter/X, PDF, Perplexity, LinkedIn, general webpage. |
| `web-scraper.js` | Article extraction via Mozilla Readability + jsdom. PDF extraction via pdf-parse. |
| `twitter-extractor.js` | Tweet/thread capture via free FxTwitter API (api.fxtwitter.com). |

### Enhanced Pipeline Flow

```
User sends URL via Telegram
  |
  v
ContentRouter.detect(url)
  |
  +-- youtube ---------> yt-transcript.js (existing) + yt-dlp download
  +-- twitter ---------> twitter-extractor.js (FxTwitter API)
  +-- pdf --------------> web-scraper.extractPdf() (pdf-parse)
  +-- perplexity/web ---> web-scraper.extract() (Readability + jsdom)
  +-- media (other) ----> yt-dlp download (existing)
  |
  v
Summarizer.summarize(content, contentType)
  |
  v
notion.createStructuredPage() / obsidian.createStructuredPage()
  |
  Page structure:
  - Metadata callout (duration, language)
  - Audio/Image block (if applicable)
  - ## Summary (LLM-generated)
  - ### Key Points (bulleted list)
  - ---
  - ## Full Transcript (verbatim content)
```

### Telegram Bot Document Handling

| Extension | Handler |
|---|---|
| .md, .markdown, .txt | Read as UTF-8, first heading = title, summarize + save |
| .pdf | pdf-parse text extraction, summarize + save |
| .jpg, .png, .webp, .heic | Gemini OCR (existing) |
| .mp3, .mp4, .wav, etc. | Audio/video pipeline (existing) |

### Storage Abstraction

Both `NotionClient` and `ObsidianClient` implement the same interface:

- `createTranscriptPage()` -- legacy flat page (still works)
- `createStructuredPage()` -- new structured Summary + Transcript format
- `appendBlocks()` -- for reply chain "My Take" sections
- `uploadFile()` -- Notion: FileUpload API; Obsidian: PUT to vault attachments folder
- `splitText()` -- chunk text for API limits
- `testConnection()` -- health check

The Telegram bot's `/mode` command toggles between clients at runtime.
