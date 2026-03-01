# Plan: Add Telegram Bot as Mobile Capture Layer

## Context

The voice-to-notion pipeline currently requires CLI access or filesystem drops to ingest content. The user wants a low-friction mobile capture flow for links, voice notes, photos, and batch video URLs. Telegram bot serves as the universal capture funnel; Notion remains the system of record.

Architecture:
```
Phone -> Telegram Bot -> Media Pipeline -> Notion Inbox -> Writing System -> AI triage
```

## Dependencies

- `telegraf` ^4.16.3 (Telegram bot framework for Node.js)
- BotFather setup (user creates bot, gets BOT_TOKEN)

## Files to Create

### `src/telegram-bot.js` -- New file, Telegram bot listener

Responsibilities:
- Listen for text messages containing URLs -> call `pipeline.ingest(url)`
- Listen for voice messages -> download .ogg from Telegram API, save to temp, call `pipeline.ingestFile(path)`
- Listen for photos -> download, save to temp (future: OCR processing)
- Listen for video/document messages -> download, call `pipeline.ingestFile(path)`
- Reply to user with status: "Processing..." then "Done! <notion-url>" or "Failed: <error>"
- Restrict to authorized user(s) via `TELEGRAM_ALLOWED_USERS` env var (comma-separated Telegram user IDs)

Key patterns from Telegraf:
```js
const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// URLs in text messages
bot.on(message('text'), async (ctx) => {
  // extract URLs, call pipeline.ingest() for each
});

// Voice messages (.ogg from Telegram)
bot.on(message('voice'), async (ctx) => {
  const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
  // download to temp, call pipeline.ingestFile()
});

// Photos
bot.on(message('photo'), async (ctx) => {
  // download highest-res version, save to Notion (future: OCR)
});

bot.launch(); // uses long-polling, no webhook/SSL needed
```

File download helper: use `ctx.telegram.getFileLink(fileId)` to get a URL, then `axios({ url, responseType: 'stream' })` to download to a temp file. Reuse existing `axios` dependency.

Auth guard: middleware that checks `ctx.from.id` against allowed user IDs list. Reject unauthorized users silently.

## Files to Modify

### `src/index.js` -- Start bot alongside existing workers

Add bot initialization after existing pipeline/sync setup:
```js
// Existing: sync worker + media pipeline start
// New: start Telegram bot if token configured
if (process.env.TELEGRAM_BOT_TOKEN) {
  const TelegramBot = require('./telegram-bot');
  const bot = new TelegramBot({ pipeline, config });
  bot.start();
}
```

The bot needs a reference to the `MediaPipeline` instance to call `ingest()` and `ingestFile()`.

### `.env` / `.env.example` -- Add Telegram config

```
# Telegram Bot (mobile capture)
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USERS=  # comma-separated Telegram user IDs
```

### `docker-compose.yml` -- No port exposure needed

Long-polling means the bot makes outbound connections only. No new ports, no SSL, no tunnels. Just add the env vars to the worker service.

## Implementation Details

### Message type handling:

| Telegram input | Action | Pipeline method |
|---|---|---|
| Text with URL(s) | Extract URLs, process each | `pipeline.ingest(url)` |
| Text without URL | Ignore or reply with help | n/a |
| Voice message | Download .ogg, transcribe | `pipeline.ingestFile(path)` |
| Audio file | Download, transcribe | `pipeline.ingestFile(path)` |
| Video file | Download, extract+transcribe | `pipeline.ingestFile(path)` |
| Photo | Download, create Notion page (body only for now) | `notion.createTranscriptPage()` with image |
| Document | Check if media, process if so | `pipeline.ingestFile(path)` |

### Auth middleware:
- Parse `TELEGRAM_ALLOWED_USERS` into a Set of user IDs
- On every message, check `ctx.from.id` is in the set
- If not authorized, ignore silently (don't reveal bot exists)

### Error handling:
- Wrap each handler in try/catch
- Reply with error message on failure
- Don't crash the bot on individual message failures

### Telegram file size limits:
- Telegram Bot API max download: 20MB
- For larger files, bot replies "File too large, use CLI instead"
- Voice messages are always small (< 1MB typical)

## Verification

1. Create bot via BotFather, add token to `.env`
2. Get your Telegram user ID (send /start to @userinfobot), add to `TELEGRAM_ALLOWED_USERS`
3. Start worker: `node src/index.js` or `docker-compose up`
4. Send a YouTube URL to the bot -> should reply with Notion page link
5. Send a voice message -> should transcribe and create Notion page
6. Send from unauthorized account -> should be silently ignored
