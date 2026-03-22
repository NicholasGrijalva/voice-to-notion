# Remote Development Guide: Mac Mini via SSH

Guide for AI agents and developers working on voice-to-notion remotely. The bot runs on a Mac Mini (`nicks-mac-mini`) via Docker, accessible over Tailscale.

## Connection

```bash
# Mac Mini is on Tailscale
tailscale status
# Look for: 100.108.112.19  nicks-mac-mini

# SSH in (key-based auth, no password needed)
ssh nick@100.108.112.19

# Test connection
ssh nick@100.108.112.19 "echo 'connected' && hostname"
```

## Git Workflow (Preferred)

Work locally, push, pull on Mac Mini, rebuild. Don't edit files over SSH unless it's a quick fix.

```bash
# 1. Work locally
cd ~/Downloads/voice-to-notion
# ... make changes ...
git add -A && git commit -m "feat: description" && git push

# 2. Pull and rebuild on Mac Mini
ssh nick@100.108.112.19 "cd ~/Downloads/voice-to-notion && git pull"
ssh nick@100.108.112.19 "export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH; cd ~/Downloads/voice-to-notion && docker-compose up -d --build 2>&1"

# 3. Verify
ssh nick@100.108.112.19 "export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH; docker logs notion-worker --tail 20 2>&1"
```

## Important: PATH on Mac Mini

SSH sessions don't load the full shell profile. Docker and node aren't in the default PATH. Always prefix commands:

```bash
ssh nick@100.108.112.19 "export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH; <command>"
```

Or for multiple commands:
```bash
ssh nick@100.108.112.19 'export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH && cd ~/Downloads/voice-to-notion && docker-compose up -d --build 2>&1'
```

## Docker Operations

```bash
# Rebuild and restart (after code changes)
docker-compose up -d --build

# View logs (live)
docker logs -f notion-worker

# View recent logs
docker logs notion-worker --tail 50

# Check container status
docker ps -a --filter name=notion --filter name=scriberr --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'

# Restart without rebuild
docker-compose restart notion-worker

# Full stop and start
docker-compose down && docker-compose up -d

# Run a command inside the container
docker exec notion-worker node -e "console.log('hello')"

# Check a specific module
docker exec notion-worker node -c src/summarizer.js

# Test the pipeline programmatically
docker exec notion-worker node -e "
require('dotenv').config();
const NotionClient = require('./src/notion');
const MediaPipeline = require('./src/media-pipeline');
const GroqTranscriber = require('./src/groq-transcriber');
const ScriberrClient = require('./src/scriberr');

async function test() {
  const notion = new NotionClient(process.env.NOTION_API_KEY, process.env.NOTION_DATABASE_ID);
  const groq = new GroqTranscriber(process.env.GROQ_API_KEY);
  const scriberr = new ScriberrClient(process.env.SCRIBERR_API_URL, process.env.SCRIBERR_USERNAME, process.env.SCRIBERR_PASSWORD);
  await scriberr.init();
  await notion.ensureTypeOptions();
  const pipeline = new MediaPipeline({ notionClient: notion, scriberrClient: scriberr, groqTranscriber: groq });

  const result = await pipeline.ingestUrl('<URL_HERE>');
  console.log('Done:', result.title, result.notionUrl);
}
test().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
"
```

## Package Changes

When adding npm dependencies:

```bash
# 1. Edit package.json locally (add the dep)
# 2. Run npm install locally to update package-lock.json
npm install
# 3. Commit both files
git add package.json package-lock.json
git commit -m "chore: add <package>"
git push

# 4. Rebuild on Mac Mini (docker-compose up --build will npm ci)
```

The Dockerfile uses `npm ci` which requires package-lock.json to be in sync. If you only edit package.json without running `npm install`, the Docker build will fail.

## Launchd Service

The bot has a launchd agent for auto-start on reboot, but it currently fails due to macOS Full Disk Access permissions on `/bin/bash` accessing `~/Downloads/`.

```bash
# Check service status
launchctl list | grep voice-to-notion
# Exit code 126 = permission denied

# Plist location
~/Library/LaunchAgents/com.voice-to-notion.plist

# Fix: System Settings > Privacy & Security > Full Disk Access > add /bin/bash
# Must be done on the Mac Mini screen directly (not via SSH)

# Manual reload after fixing permissions
launchctl unload ~/Library/LaunchAgents/com.voice-to-notion.plist
launchctl load ~/Library/LaunchAgents/com.voice-to-notion.plist
```

Currently the Docker containers have `restart: unless-stopped`, so they survive reboots as long as Docker Desktop starts (which it does by default on macOS login).

## Zombie Process Cleanup

ADW worktree test runs can leave orphaned `node (vitest)` processes on the Mac Mini. Check and kill periodically:

```bash
# Count zombie vitest processes
ps aux | grep 'node (vitest)' | grep -v grep | wc -l

# Kill them all
pkill -f 'node.*vitest'
```

## Environment Variables

All env vars are in `~/Downloads/voice-to-notion/.env`. Key ones:

| Var | Purpose |
|-----|---------|
| `GROQ_API_KEY` | Whisper transcription + Llama 3.3 summarization |
| `NOTION_API_KEY` | Notion API integration |
| `NOTION_DATABASE_ID` | Inbox database ID |
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs |
| `GEMINI_API_KEY` | Photo OCR via Gemini 2.5 Flash |
| `OBSIDIAN_LOCAL_REST_API_KEY` | Obsidian Local REST API (optional) |
| `DESTINATION` | `notion` or `obsidian` (default: notion) |

## Architecture Quick Reference

```
src/
  index.js              # Entrypoint -- starts 3 pipelines in parallel
  telegram-bot.js       # Telegram message handling (Telegraf)
  media-pipeline.js     # Orchestrator: URL routing, download, transcribe, summarize, save
  content-router.js     # Regex URL classification (youtube/twitter/pdf/webpage/etc.)
  summarizer.js         # Groq Llama 3.3 70B auto-summarization
  web-scraper.js        # Mozilla Readability + jsdom for articles; pdf-parse for PDFs
  twitter-extractor.js  # FxTwitter API for tweet capture
  yt-transcript.js      # YouTube subtitle extraction via yt-dlp
  media-downloader.js   # yt-dlp wrapper for media downloads
  audio-extractor.js    # ffmpeg wrapper for audio extraction
  groq-transcriber.js   # Groq Whisper API + Llama title generation
  scriberr.js           # Local Scriberr/WhisperX API client
  notion.js             # Notion API client (pages, file uploads, structured pages)
  obsidian.js           # Obsidian Local REST API client (same interface as notion.js)
  ocr.js                # Gemini 2.5 Flash image OCR
  sync.js               # Scriberr poll loop (legacy pipeline)
```

## Content Flow

```
Telegram message
  |
  +-- URL --> ContentRouter.detect()
  |             +-- youtube --> yt-transcript + yt-dlp + summarize
  |             +-- twitter --> FxTwitter API + summarize
  |             +-- pdf URL --> pdf-parse + summarize
  |             +-- webpage --> Readability + summarize
  |             +-- media  --> yt-dlp + Whisper + summarize
  |
  +-- voice/audio/video --> Groq Whisper + summarize
  +-- photo --> Gemini OCR
  +-- .md/.txt --> read UTF-8 + summarize
  +-- .pdf file --> pdf-parse + summarize
  |
  v
  Notion/Obsidian createStructuredPage()
    - Summary section (LLM-generated)
    - Key Points (bulleted)
    - Full Transcript (verbatim)
```
