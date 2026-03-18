# Voice-to-Notion/Obsidian Transcription System

Self-hosted voice & media transcription pipeline: **Record/Download → Transcribe → Notion or Obsidian**

Zero OpenAI dependency by default. Uses [Scriberr](https://github.com/rishikanthc/Scriberr) (WhisperX) for local transcription, optional [Groq](https://groq.com) cloud fallback for speed, yt-dlp for media downloads, ffmpeg for audio extraction.

## Quick Start

```bash
# 1. Clone/copy this directory
cd voice-to-notion

# 2. Configure
cp .env.example .env
# Edit .env with your credentials (see Setup below)

# 3. Deploy
./scripts/boot.sh

# Or manually:
docker compose up -d
docker compose logs -f notion-worker
```

## Features

- **Dual destination** — write to Notion (default) or Obsidian vault via `DESTINATION` env var
- **Telegram bot** — send URLs, voice notes, photos, or media from your phone
- **Photo OCR** — send photos/screenshots; Gemini 2.5 Flash extracts text
- **Reply chain** — reply to any captured message with voice/text to append a "My Take" annotation
- **Auto-generated titles** — Groq LLM summarizes transcripts into descriptive page titles
- **Local transcription** via Scriberr (WhisperX)
- **Cloud transcription** via Groq Whisper API (optional, ~164x real-time)
- **Audio file upload** to Notion (uses FileUpload API)
- **Media ingestion** — YouTube videos, podcasts, any yt-dlp URL
- **YouTube transcript fetching** — grabs existing subs before falling back to Whisper
- **Audio extraction** via ffmpeg from any video format
- **Local file ingestion** — drop mp3/mp4/mov/wav files directly into inbox, or use CLI
- **File-based inbox** — drop a .txt with URLs or media files, worker handles the rest
- **One-command deployment** with Docker Compose
- **State persistence** — survives restarts, tracks synced jobs

## Architecture

Three pipelines run in parallel inside a single worker container:

```
Pipeline 1: Voice Memos (Scriberr Sync)
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Voice Memos │────▶│  Scriberr   │────▶│   Notion    │
│ (iOS/phone) │     │ (WhisperX)  │     │  Database   │
└─────────────┘     └─────────────┘     └─────────────┘
                           ▲
                    ┌──────┴──────┐
                    │ Sync Worker │ polls every 30s
                    └─────────────┘

Pipeline 2a: URL Ingestion (yt-dlp + ffmpeg)
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ inbox_media/ │────▶│   yt-dlp    │────▶│   ffmpeg    │────▶│   Notion    │
│ (.txt URLs)  │     │ (download)  │     │ (extract)   │     │  Database   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  YT Subs?   │──yes──▶ Use existing transcript
                    └──────┬──────┘
                           │ no
                           ▼
                    ┌─────────────┐
                    │ Groq / local│ Whisper transcription
                    └─────────────┘

Pipeline 2b: Local File Ingestion (ffmpeg + Groq/Scriberr)
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ inbox_media/ │────▶│   ffmpeg    │────▶│ Groq/Scrib. │────▶│   Notion    │
│ (mp3/mp4/..) │     │ (extract)   │     │ (Whisper)   │     │  Database   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘

Pipeline 3: Telegram Bot (mobile capture)
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram    │────▶│  Download   │────▶│ Groq/Scrib. │────▶│   Notion    │
│ (URL/voice)  │     │  + ffmpeg   │     │ (Whisper)   │     │  Database   │
└─────────────┘     └─────────────┘     └──────┬──────┘     └─────────────┘
       │                                       │
       │ photo                          ┌──────┴──────┐
       ▼                                │  Groq LLM   │ auto-generates title
┌─────────────┐                         └─────────────┘
│ Gemini 2.5  │ OCR
│   Flash     │────────────────────────────────▶ Notion
└─────────────┘

Pipeline 4: Reply Chain (annotation layer)
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Reply to any │────▶│ Transcribe  │────▶│  Append     │
│ bot message  │     │ or extract  │     │ "My Take"   │
│ with voice/  │     │ text        │     │ to existing │
│ text/photo   │     │             │     │ Notion page │
└─────────────┘     └─────────────┘     └─────────────┘

Transcription routing: Groq (if GROQ_API_KEY set, <25MB) → Scriberr (local fallback)
Title generation: Groq LLM (llama-3.3-70b) generates titles from transcript content
OCR: Gemini 2.5 Flash (requires GEMINI_API_KEY)
```

## Setup

### 1. Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.com/my-integrations)
2. Click **"+ New Integration"**
3. Name it "Voice Transcripts" (or whatever)
4. Copy the **Internal Integration Secret** → `NOTION_API_KEY` in `.env`

### 2. Notion Database

Your database needs these properties (the worker maps to them automatically):

| Property | Type | Description |
|----------|------|-------------|
| Title | title | Auto-filled with media title/filename |
| Status | select | Set to "New" on creation |
| Date Added | date | Timestamp of when transcript was created |
| Type | select | "Audio", "Video", or "YouTube" (auto-created on first run) |
| Source | rich_text | Source filepath or URL (auto-created on first run) |
| Source Filename | rich_text | Original filename |
| Processing Time (s) | number | How long transcription took |
| URL | url | Source URL (for media pipeline items) |
| Tags | multi_select | Optional tags |
| Project | relation | Optional project link |

**Important:** Share the database with your integration:
1. Open your database in Notion
2. Click **Share** → **Invite**
3. Select your integration

Get the Database ID from the URL:
```
https://notion.so/workspace/DATABASE_ID?v=...
                         ^^^^^^^^^^^^^^^^
```
Copy that ID (with or without hyphens) → `NOTION_DATABASE_ID` in `.env`

### 3. Scriberr Credentials

Set your desired username and password in `.env`:

```
SCRIBERR_USERNAME=YourName
SCRIBERR_PASSWORD=YourPassword
```

The worker auto-registers on first boot (fresh Scriberr install) and logs in on subsequent starts.

### 4. Telegram Bot (optional — mobile capture)

1. Open Telegram, message [@BotFather](https://t.me/botfather)
2. Send `/newbot`, pick a name and username
3. Copy the token → `TELEGRAM_BOT_TOKEN` in `.env`
4. Message [@userinfobot](https://t.me/userinfobot) to get your user ID
5. Add it to `TELEGRAM_ALLOWED_USERS` in `.env`

The bot uses long-polling (no webhooks, no SSL, no exposed ports needed).

### 5. Gemini API Key (optional — photo OCR)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create an API key
3. Add to `.env`: `GEMINI_API_KEY=AIza...`

Required only if you want to send photos/screenshots to the bot for OCR. All other features work without it.

### 6. Start Everything

```bash
# Option A: Boot script (handles sequencing and health checks)
./scripts/boot.sh

# Option B: Manual
docker compose up -d
```

## Usage

### From Telegram (recommended for mobile)

Send any of these to your bot:

- **YouTube/podcast URL** — downloads, transcribes, creates Notion page with video title
- **Voice message** — transcribes, generates AI title from content
- **Video message** — extracts audio, transcribes, generates AI title
- **Audio/video file** — same pipeline as voice messages
- **Photo/screenshot** — OCR via Gemini 2.5 Flash, creates Notion page as "Idea"
- **Image file** (.jpg, .png, .webp, .heic sent as document) — same as photo
- **Multiple URLs in one message** — processes each one sequentially

**Reply chain:** Reply to any bot-processed message with voice, text, or a photo to append a "My Take" section to the existing Notion page. This lets you capture a source (image, URL, video) and then add your reaction/annotation without creating a separate page.

The bot replies with a link to the created Notion page.

### From iPhone (iOS Shortcut)

Scriberr uses JWT auth, so the shortcut needs to login first:

1. Open Shortcuts app
2. Create new shortcut with:
   - **Get URL Contents** (login):
     - URL: `http://YOUR_SERVER_IP:8080/api/v1/auth/login`
     - Method: POST
     - Headers: `Content-Type: application/json`
     - Body: JSON `{"username":"YOUR_USER","password":"YOUR_PASS"}`
   - **Get Dictionary Value**: key `token` from previous result
   - **Receive Files** (any type)
   - **Get URL Contents** (upload):
     - URL: `http://YOUR_SERVER_IP:8080/api/v1/transcription/submit`
     - Method: POST
     - Headers: `Authorization: Bearer [token from step 2]`
     - Body: Form with `audio` (received file) and `language` ("en")
   - **Show Notification**: "Upload Started"

3. Record in Voice Memos → Share → Your Shortcut

### From Desktop

Drag-drop files into Scriberr web UI at http://localhost:8080

### Media Ingestion (YouTube, Podcasts, etc.)

**Important:** Always quote URLs containing `?` — zsh treats `?` as a glob wildcard and will reject unquoted URLs with `no matches found`.

```bash
# Direct mode (recommended for local/non-Docker use — runs pipeline immediately)
DIRECT=1 npm run ingest -- "https://youtube.com/watch?v=dQw4w9WgXcQ"
DIRECT=1 npm run ingest -- "https://youtu.be/dQw4w9WgXcQ?si=abc123"

# Inbox mode (drops a .txt for the Docker worker to pick up)
npm run ingest -- "https://youtube.com/watch?v=dQw4w9WgXcQ"
```

**Local (non-Docker) prerequisites:** `yt-dlp` and `ffmpeg` (`brew install yt-dlp ffmpeg`).

You can also drop URL files into the inbox directly:

```bash
echo "https://youtube.com/watch?v=dQw4w9WgXcQ" > inbox_media/video.txt

# Multiple URLs
cat > inbox_media/batch.txt << 'EOF'
https://youtube.com/watch?v=xxxxx
https://youtube.com/watch?v=yyyyy
https://podcasts.apple.com/us/podcast/...
EOF
```

You can also use JSON for more control:

```json
// inbox_media/podcast.json
{
  "url": "https://youtube.com/watch?v=xxxxx",
  "options": {
    "skipTranscript": false,
    "audioOnly": true,
    "tags": ["podcast", "tech"]
  }
}
```

The worker scans `inbox_media/` every 15 seconds and moves processed files to `processed/`.

### Local Files (MP3, MP4, MOV, etc.)

Drop media files directly into `inbox_media/` — the worker auto-detects them, extracts audio from video if needed, transcribes via Scriberr, and creates a Notion page.

```bash
# Drop files into inbox (worker picks up within 15s)
cp recording.mp3 inbox_media/
cp meeting.mp4 inbox_media/
cp interview.mov inbox_media/

# CLI: single file (processes in-place, original untouched)
npm run ingest-file -- /path/to/video.mp4
npm run ingest-file -- ~/Voice\ Memos/recording.m4a

# CLI: glob pattern for batch processing
npm run ingest-file -- "/Volumes/SSD/footage/*.mov"
npm run ingest-file -- "/Users/me/Downloads/*.mp4"

# CLI: interactive file picker (no args)
npm run ingest-file
```

Supported formats: mp3, mp4, m4a, mov, wav, flac, ogg, opus, webm, mkv, avi, m4v, aac, wma.

Video files have audio extracted via ffmpeg before transcription. Audio files go straight to Scriberr (converted to the configured `AUDIO_FORMAT` if needed).

The CLI processes files in-place — originals are never modified or moved. Works with external drives, iCloud Drive, and network paths.

### Batch Processing (Direct to Scriberr)

```bash
# Login first to get a JWT token
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"YourName","password":"YourPassword"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Upload all MP3s in a folder
for f in *.mp3; do
  curl -X POST http://localhost:8080/api/v1/transcription/submit \
    -H "Authorization: Bearer $TOKEN" \
    -F "audio=@$f" \
    -F "language=en"
done
```

## Configuration

All config is in `.env`:

### Destination

| Variable | Description | Default |
|----------|-------------|---------|
| `DESTINATION` | `notion` or `obsidian` | `notion` |

### Notion (when DESTINATION=notion)

| Variable | Description | Default |
|----------|-------------|---------|
| `NOTION_API_KEY` | Notion integration secret | (required) |
| `NOTION_DATABASE_ID` | Target database ID | (required) |

### Obsidian (when DESTINATION=obsidian)

| Variable | Description | Default |
|----------|-------------|---------|
| `OBSIDIAN_LOCAL_REST_API_KEY` | API key from Obsidian Local REST API plugin | (required) |
| `OBSIDIAN_REST_API_PORT` | REST API port | 27124 |
| `OBSIDIAN_CAPTURE_FOLDER` | Vault folder for new notes | 01_Capture |

Requires Obsidian running with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. Notes are written as markdown with YAML frontmatter. The reply chain "My Take" feature appends to existing notes.

### Transcription & Services

| Variable | Description | Default |
|----------|-------------|---------|
| `SCRIBERR_USERNAME` | Scriberr login username | (required) |
| `SCRIBERR_PASSWORD` | Scriberr login password | (required) |
| `SCRIBERR_PORT` | Scriberr web UI port | 8080 |
| `WHISPER_MODEL` | tiny/base/small/medium/large-v2/large-v3 | small |
| `DEVICE` | cuda/cpu | cpu |
| `COMPUTE_TYPE` | float32/int8 (int8 is faster on CPU) | int8 |
| `WHISPER_BATCH_SIZE` | Batch size (lower = less RAM) | 4 |
| `GROQ_API_KEY` | Groq API key for cloud transcription | (optional) |
| `POLL_INTERVAL_SECONDS` | Scriberr poll interval | 30 |
| `ENABLE_MEDIA_PIPELINE` | Enable URL ingestion pipeline | true |
| `MEDIA_POLL_INTERVAL_SECONDS` | Inbox scan interval | 15 |
| `AUDIO_FORMAT` | Output audio format: mp3/m4a/wav | mp3 |
| `MEDIA_INBOX_PATH` | Host path for inbox mount | ./inbox_media |
| `MEDIA_PROCESSED_PATH` | Host path for processed files | ./processed |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather | (optional) |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs | (optional) |
| `GEMINI_API_KEY` | Google Gemini API key for photo OCR | (optional) |

## Troubleshooting

### Notion pages not being created

```bash
# Check worker logs
docker compose logs -f notion-worker

# Test connections
npm test
```

Common issues:
- Database not shared with integration
- Wrong database ID (use the 32-char ID, not the URL)
- Properties don't match expected names (worker auto-creates Audio/Video types on startup)

### Media pipeline not picking up files

```bash
# Check inbox directory is mounted correctly
docker compose exec notion-worker ls -la /app/data/inbox_media/

# Check worker logs for pipeline output
docker compose logs -f notion-worker | grep MediaPipeline
```

### yt-dlp download failures

```bash
# Update yt-dlp inside container
docker compose exec notion-worker pip3 install -U yt-dlp

# Test a URL manually
docker compose exec notion-worker yt-dlp --dump-json "https://youtube.com/watch?v=xxxxx"
```

### Scriberr not accessible

```bash
docker compose ps
docker compose logs scriberr
curl http://localhost:8080/health
```

### Transcription slow

**Quick fixes (env vars only, restart containers):**

1. `WHISPER_MODEL=small` — ~6x faster than large-v2, still good English accuracy
2. `COMPUTE_TYPE=int8` — 2-4x faster on CPU with minimal accuracy loss
3. `WHISPER_BATCH_SIZE=4` — reduces RAM pressure, avoids swap thrashing

**Cloud transcription (fastest):**

Set `GROQ_API_KEY` in `.env` to enable Groq Whisper (~164x real-time). Free tier: 8 hours of audio/day. The worker tries Groq first, falls back to local Scriberr if the file is >25MB or the API fails.

```bash
# Get a free key at https://console.groq.com/keys
echo "GROQ_API_KEY=gsk_your_key_here" >> .env
docker compose build notion-worker && docker compose up -d notion-worker
```

**GPU (NVIDIA only):** Uncomment the GPU section in `docker-compose.yml` and set `DEVICE=cuda`. Apple Silicon MPS is not available inside Docker.

**Monitor:** `docker stats` to check memory usage.

## Files

```
voice-to-notion/
├── src/
│   ├── index.js            # Entry point (runs all pipelines)
│   ├── scriberr.js         # Scriberr API client
│   ├── notion.js           # Notion API client (with file upload)
│   ├── obsidian.js         # Obsidian vault client (via Local REST API)
│   ├── sync.js             # Pipeline 1: Scriberr poll/sync worker
│   ├── media-pipeline.js   # Pipeline 2: Orchestrator (inbox → download → transcribe → Notion)
│   ├── telegram-bot.js     # Pipeline 3: Telegram mobile capture (photo OCR + reply chain)
│   ├── ocr.js              # Gemini 2.5 Flash image OCR
│   ├── groq-transcriber.js # Groq Whisper + LLM client (transcription + title generation)
│   ├── media-downloader.js # yt-dlp wrapper
│   ├── audio-extractor.js  # ffmpeg wrapper
│   └── yt-transcript.js    # YouTube subtitle/transcript fetcher
├── scripts/
│   ├── boot.sh             # One-command startup (health checks + sequencing)
│   ├── test-connection.js  # Connection test
│   ├── ingest-url.js       # CLI URL ingestion helper
│   └── ingest-file.js      # CLI local file ingestion
├── inbox_media/            # Drop URL files here (bind-mounted)
├── processed/              # Completed files moved here
├── docker compose.yml      # One-command deployment
├── Dockerfile              # Worker container (node + yt-dlp + ffmpeg)
├── package.json
├── .env.example
├── PRD.md                  # Original product requirements
└── README.md
```

## License

MIT
