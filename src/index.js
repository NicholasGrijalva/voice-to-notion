/**
 * Voice-to-Notion Worker
 * Entry point — runs pipelines in parallel:
 *   1. Scriberr Sync: Polls Scriberr for completed transcripts → Notion
 *   2. Media Pipeline: Watches inbox_media/ for URLs → yt-dlp → ffmpeg → Notion
 *   3. Telegram Bot: Mobile capture layer → URLs/voice/media → Notion
 */

require('dotenv').config();

const ScriberrClient = require('./scriberr');
const NotionClient = require('./notion');
const SyncWorker = require('./sync');
const MediaPipeline = require('./media-pipeline');
const GroqTranscriber = require('./groq-transcriber');

// Validate required environment variables
// Scriberr is optional when running Telegram+Groq only (no local transcription)
const hasScriberr = process.env.SCRIBERR_API_URL && process.env.SCRIBERR_USERNAME && process.env.SCRIBERR_PASSWORD;
const hasGroq = !!process.env.GROQ_API_KEY;
const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN;

const required = ['NOTION_API_KEY', 'NOTION_DATABASE_ID'];
if (!hasTelegram || !hasGroq) {
  // Full pipeline mode requires Scriberr
  required.push('SCRIBERR_API_URL', 'SCRIBERR_USERNAME', 'SCRIBERR_PASSWORD');
}
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error(`[Worker] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[Worker] Please check your .env file or environment configuration');
  process.exit(1);
}

if (!hasScriberr && hasGroq && hasTelegram) {
  console.log('[Worker] Running in Telegram + Groq mode (no Scriberr required)');
}

// Configuration
const config = {
  scriberr: {
    url: process.env.SCRIBERR_API_URL,
    username: process.env.SCRIBERR_USERNAME,
    password: process.env.SCRIBERR_PASSWORD
  },
  notion: {
    key: process.env.NOTION_API_KEY,
    databaseId: process.env.NOTION_DATABASE_ID
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10) * 1000,
  media: {
    enabled: process.env.ENABLE_MEDIA_PIPELINE !== 'false',
    pollInterval: parseInt(process.env.MEDIA_POLL_INTERVAL_SECONDS || '15', 10) * 1000,
    audioFormat: process.env.AUDIO_FORMAT || 'mp3',
    inboxDir: process.env.MEDIA_INBOX_DIR || '/app/data/inbox_media',
    processedDir: process.env.MEDIA_PROCESSED_DIR || '/app/data/processed',
    tempDir: process.env.TEMP_DIR || '/tmp/media-pipeline'
  }
};

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║         Voice-to-Notion Worker v2.1                      ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log('');
console.log('[Worker] Configuration:');
if (hasScriberr) {
  console.log(`  Scriberr URL:     ${config.scriberr.url}`);
  console.log(`  Scriberr User:    ${config.scriberr.username}`);
  console.log(`  Sync Interval:    ${config.pollInterval / 1000}s`);
} else {
  console.log(`  Scriberr:         DISABLED (Groq-only mode)`);
}
console.log(`  Notion Database:  ${config.notion.databaseId.slice(0, 8)}...`);
console.log(`  Media Pipeline:   ${config.media.enabled ? 'ENABLED' : 'DISABLED'}`);
if (config.media.enabled) {
  console.log(`  Media Interval:   ${config.media.pollInterval / 1000}s`);
  console.log(`  Audio Format:     ${config.media.audioFormat}`);
  console.log(`  Inbox Dir:        ${config.media.inboxDir}`);
}
console.log(`  Telegram Bot:     ${process.env.TELEGRAM_BOT_TOKEN ? 'ENABLED' : 'DISABLED'}`);
if (process.env.TELEGRAM_BOT_TOKEN && process.env.WEBHOOK_DOMAIN) {
  console.log(`  Bot Mode:         Webhook (${process.env.WEBHOOK_DOMAIN})`);
} else if (process.env.TELEGRAM_BOT_TOKEN) {
  console.log(`  Bot Mode:         Long-polling`);
}


// Initialize shared clients
let scriberr = null;
if (hasScriberr) {
  scriberr = new ScriberrClient(config.scriberr.url, config.scriberr.username, config.scriberr.password);
}
const notion = new NotionClient(config.notion.key, config.notion.databaseId);

// Groq cloud transcription (optional — used by media pipeline if configured)
let groq = null;
if (process.env.GROQ_API_KEY) {
  groq = new GroqTranscriber(process.env.GROQ_API_KEY);
  console.log(`  Transcription:    Groq (cloud)${hasScriberr ? ' + Scriberr fallback' : ''}`);
} else {
  console.log(`  Transcription:    ${hasScriberr ? 'Scriberr only (local)' : 'NONE — set GROQ_API_KEY or Scriberr'}`);
}
console.log('');

// Pipeline 1: Scriberr Sync Worker (only if Scriberr is configured)
let syncWorker = null;
if (scriberr) {
  syncWorker = new SyncWorker(scriberr, notion, config.pollInterval);
}

// Pipeline 2: Media Ingestion Pipeline (optional)
let mediaPipeline = null;
if (config.media.enabled) {
  mediaPipeline = new MediaPipeline({
    notionClient: notion,
    scriberrClient: scriberr,
    groqTranscriber: groq,
    config: {
      inboxDir: config.media.inboxDir,
      processedDir: config.media.processedDir,
      tempDir: config.media.tempDir,
      pollInterval: config.media.pollInterval,
      audioFormat: config.media.audioFormat
    }
  });
}

// Graceful shutdown handlers
// Pipeline 3: Telegram Bot (optional — mobile capture layer)
let telegramBot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  const TelegramBot = require('./telegram-bot');
  telegramBot = new TelegramBot({
    pipeline: mediaPipeline,
    notionClient: notion,
    tempDir: config.media.tempDir ? config.media.tempDir + '/telegram' : '/tmp/telegram-downloads'
  });
}

const shutdown = (signal) => {
  console.log(`\n[Worker] Received ${signal}, shutting down gracefully...`);
  if (syncWorker) syncWorker.stop();
  if (mediaPipeline) mediaPipeline.stop();
  if (telegramBot) telegramBot.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Worker] Uncaught exception:', error);
  if (syncWorker) syncWorker.stop();
  if (mediaPipeline) mediaPipeline.stop();
  if (telegramBot) telegramBot.stop();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled rejection at:', promise, 'reason:', reason);
});

// Start both pipelines
async function main() {
  // Authenticate with Scriberr (register on first run, then login)
  if (scriberr) {
    console.log('[Worker] Authenticating with Scriberr...');
    await scriberr.init();
  }

  console.log('[Worker] Starting pipelines...\n');

  // Start Scriberr sync (if configured)
  if (syncWorker) {
    await syncWorker.start();
  }

  // Start media pipeline (if enabled)
  if (mediaPipeline) {
    await mediaPipeline.start();
  }

  // Start Telegram bot (if configured)
  if (telegramBot) {
    await telegramBot.start();
  }

  console.log('\n[Worker] All pipelines running. Waiting for work...\n');
}

main().catch(error => {
  console.error('[Worker] Failed to start:', error);
  process.exit(1);
});
