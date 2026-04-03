/**
 * Voice-to-Notion Worker
 * Entry point — runs pipelines in parallel:
 *   1. Scriberr Sync: Polls Scriberr for completed transcripts → Notion
 *   2. Media Pipeline: Watches inbox_media/ for URLs → yt-dlp → ffmpeg → Notion
 *   3. Telegram Bot: Mobile capture layer → URLs/voice/media → Notion
 */

// --help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Voice-to-Notion Worker v2.1
Multi-format content capture pipeline: Capture -> Extract -> Summarize -> Notion/Obsidian

USAGE
  node src/index.js [options]

OPTIONS
  --help, -h    Show this help message

PIPELINES
  1. Scriberr Sync    Polls Scriberr for completed transcripts (with Groq fallback)
  2. Media Pipeline    Watches inbox for URLs/media files (yt-dlp + ffmpeg)
  3. Telegram Bot      Mobile capture: URLs, voice, photos, media files
  4. Admin API         HTTP server for remote state management (default port 9200)

ADMIN API ENDPOINTS
  GET  /health             Uptime and pipeline status
  GET  /state              Synced/failed job counts and retry timers
  POST /retry/:jobId       Reset a failed job for immediate retry
  POST /retry-all          Reset all failed jobs
  POST /abandon/:jobId     Permanently skip a job

ENVIRONMENT
  Required:
    SCRIBERR_API_URL           Scriberr server URL
    SCRIBERR_USERNAME          Scriberr login username
    SCRIBERR_PASSWORD          Scriberr login password
    NOTION_API_KEY             Notion integration secret
    NOTION_DATABASE_ID         Target Notion database ID

  Optional:
    DESTINATION                notion (default) or obsidian
    GROQ_API_KEY               Groq API key (cloud transcription + titles)
    TELEGRAM_BOT_TOKEN         Telegram bot token (mobile capture)
    GEMINI_API_KEY             Gemini API key (photo OCR)
    POLL_INTERVAL_SECONDS      Scriberr poll interval (default: 30)
    MAX_SYNC_RETRIES           Max retries for failed syncs (default: 10, 0=unlimited)
    ADMIN_PORT                 Admin API port (default: 9200)
    ENABLE_MEDIA_PIPELINE      Enable media pipeline (default: true)
    AUDIO_FORMAT               Output format: mp3/m4a/wav (default: mp3)

  See .env.example for full configuration reference.
`);
  process.exit(0);
}

require('dotenv').config();

const ScriberrClient = require('./scriberr');
const NotionClient = require('./notion');
const ObsidianClient = require('./obsidian');
const CognosMapClient = require('./cognosmap-client');
const SyncWorker = require('./sync');
const MediaPipeline = require('./media-pipeline');
const GroqTranscriber = require('./groq-transcriber');
const AdminServer = require('./admin');

// Validate required environment variables
// Notion keys are only required if not using CognosMap as destination
const destination = (process.env.DESTINATION || 'notion').toLowerCase();
const required = ['SCRIBERR_API_URL', 'SCRIBERR_USERNAME', 'SCRIBERR_PASSWORD'];
if (destination !== 'cognosmap') {
  required.push('NOTION_API_KEY', 'NOTION_DATABASE_ID');
}
if (destination === 'cognosmap') {
  required.push('COGNOSMAP_API_URL', 'COGNOSMAP_API_KEY');
}
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error(`[Worker] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[Worker] Please check your .env file or environment configuration');
  process.exit(1);
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
    inboxDir: process.env.MEDIA_INBOX_DIR || './data/inbox_media',
    processedDir: process.env.MEDIA_PROCESSED_DIR || './data/processed',
    tempDir: process.env.TEMP_DIR || '/tmp/media-pipeline'
  }
};

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║         Voice-to-Notion Worker v2.1                      ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log('');
console.log('[Worker] Configuration:');
console.log(`  Scriberr URL:     ${config.scriberr.url}`);
console.log(`  Scriberr User:    ${config.scriberr.username}`);
console.log(`  Notion Database:  ${config.notion.databaseId.slice(0, 8)}...`);
console.log(`  Sync Interval:    ${config.pollInterval / 1000}s`);
console.log(`  Media Pipeline:   ${config.media.enabled ? 'ENABLED' : 'DISABLED'}`);
if (config.media.enabled) {
  console.log(`  Media Interval:   ${config.media.pollInterval / 1000}s`);
  console.log(`  Audio Format:     ${config.media.audioFormat}`);
  console.log(`  Inbox Dir:        ${config.media.inboxDir}`);
}
console.log(`  Telegram Bot:     ${process.env.TELEGRAM_BOT_TOKEN ? 'ENABLED' : 'DISABLED'}`);


// Initialize shared clients
const scriberr = new ScriberrClient(config.scriberr.url, config.scriberr.username, config.scriberr.password);

// Build all configured clients so /mode can toggle at runtime
const notionClientInstance = (process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID)
  ? new NotionClient(config.notion.key, config.notion.databaseId)
  : null;

let obsidianClientInstance = null;
const obsidianKey = process.env.OBSIDIAN_LOCAL_REST_API_KEY;
if (obsidianKey) {
  const obsidianPort = parseInt(process.env.OBSIDIAN_REST_API_PORT || '27124', 10);
  const obsidianFolder = process.env.OBSIDIAN_CAPTURE_FOLDER || '01_Capture';
  obsidianClientInstance = new ObsidianClient(obsidianKey, null, {
    port: obsidianPort,
    captureFolder: obsidianFolder,
  });
}

let cognosmapClientInstance = null;
if (process.env.COGNOSMAP_API_URL && process.env.COGNOSMAP_API_KEY) {
  cognosmapClientInstance = new CognosMapClient(
    process.env.COGNOSMAP_API_URL,
    process.env.COGNOSMAP_API_KEY
  );
}

// Select active destination
const notion = destination === 'cognosmap' && cognosmapClientInstance
  ? cognosmapClientInstance
  : destination === 'obsidian' && obsidianClientInstance
  ? obsidianClientInstance
  : notionClientInstance;

console.log(`  Destination:      ${destination === 'obsidian' ? 'Obsidian' : 'Notion'} (toggle via /mode in Telegram)`);
if (obsidianClientInstance) {
  console.log(`  Obsidian:         configured (port ${process.env.OBSIDIAN_REST_API_PORT || '27124'})`);
}

// Groq cloud transcription (optional — used by media pipeline if configured)
let groq = null;
if (process.env.GROQ_API_KEY) {
  groq = new GroqTranscriber(process.env.GROQ_API_KEY);
  console.log(`  Transcription:    Groq (cloud) + Scriberr fallback`);
} else {
  console.log(`  Transcription:    Scriberr only (local)`);
}
console.log('');

// Pipeline 1: Scriberr Sync Worker
const syncWorker = new SyncWorker(scriberr, notion, config.pollInterval, groq);

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
    notionClient: notionClientInstance,
    obsidianClient: obsidianClientInstance,
    cognosmapClient: cognosmapClientInstance,
    tempDir: config.media.tempDir ? config.media.tempDir + '/telegram' : '/tmp/telegram-downloads'
  });
}

// Pipeline 4: Admin API (remote state management)
const admin = new AdminServer(syncWorker);

const shutdown = (signal) => {
  console.log(`\n[Worker] Received ${signal}, shutting down gracefully...`);
  syncWorker.stop();
  if (mediaPipeline) mediaPipeline.stop();
  if (telegramBot) telegramBot.stop();
  admin.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Worker] Uncaught exception:', error);
  syncWorker.stop();
  if (mediaPipeline) mediaPipeline.stop();
  if (telegramBot) telegramBot.stop();
  admin.stop();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled rejection at:', promise, 'reason:', reason);
});

// Start both pipelines
async function main() {
  // Authenticate with Scriberr (register on first run, then login)
  console.log('[Worker] Authenticating with Scriberr...');
  await scriberr.init();

  console.log('[Worker] Starting pipelines...\n');

  // Start Scriberr sync
  await syncWorker.start();

  // Start media pipeline (if enabled)
  if (mediaPipeline) {
    await mediaPipeline.start();
  }

  // Start Telegram bot (if configured)
  if (telegramBot) {
    await telegramBot.start();
  }

  // Start admin API
  admin.start();

  console.log('\n[Worker] All pipelines running. Waiting for work...\n');
}

main().catch(error => {
  console.error('[Worker] Failed to start:', error);
  process.exit(1);
});
