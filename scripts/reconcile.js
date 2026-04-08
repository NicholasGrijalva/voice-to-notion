#!/usr/bin/env node
/**
 * Telegram Reconciler CLI
 *
 * Scans the Telegram bot chat history and re-ingests any messages
 * that are missing from Notion.
 *
 * Usage:
 *   npm run reconcile              # Dry run -- show what's missing
 *   npm run reconcile -- --execute # Actually re-ingest missing messages
 */

require('dotenv').config();

const path = require('path');
const TelegramReconciler = require('../src/telegram-reconciler');
const NotionClient = require('../src/notion');
const MediaPipeline = require('../src/media-pipeline');
const ScriberrClient = require('../src/scriberr');
const GroqTranscriber = require('../src/groq-transcriber');

// Validate required env vars
const required = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION', 'TELEGRAM_BOT_USERNAME', 'NOTION_API_KEY', 'NOTION_DATABASE_ID'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  if (missing.includes('TELEGRAM_SESSION')) {
    console.error('Run: npm run telegram-auth');
  }
  if (missing.includes('TELEGRAM_API_ID') || missing.includes('TELEGRAM_API_HASH')) {
    console.error('Get these from https://my.telegram.org/apps');
  }
  if (missing.includes('TELEGRAM_BOT_USERNAME')) {
    console.error('Set TELEGRAM_BOT_USERNAME in .env (e.g. @MyVoiceBot)');
  }
  process.exit(1);
}

const execute = process.argv.includes('--execute');

(async () => {
  // Set up shared clients (same as index.js)
  const notionClient = new NotionClient(process.env.NOTION_API_KEY, process.env.NOTION_DATABASE_ID);
  await notionClient.testConnection();

  const scriberr = new ScriberrClient(
    process.env.SCRIBERR_API_URL || 'http://localhost:8080',
    process.env.SCRIBERR_USERNAME,
    process.env.SCRIBERR_PASSWORD
  );

  let groq = null;
  if (process.env.GROQ_API_KEY) {
    groq = new GroqTranscriber(process.env.GROQ_API_KEY);
  }

  const tempDir = process.env.TEMP_DIR || path.join(__dirname, '..', 'data', 'tmp');

  const pipeline = new MediaPipeline({
    notionClient,
    scriberrClient: scriberr,
    groqTranscriber: groq,
    config: {
      audioFormat: process.env.AUDIO_FORMAT || 'mp3',
      tempDir,
    },
  });

  const reconciler = new TelegramReconciler({
    apiId: parseInt(process.env.TELEGRAM_API_ID, 10),
    apiHash: process.env.TELEGRAM_API_HASH,
    session: process.env.TELEGRAM_SESSION,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    notionClient,
    pipeline,
    tempDir: path.join(tempDir, 'reconcile'),
  });

  try {
    await reconciler.connect();

    if (execute) {
      const results = await reconciler.execute();
      console.log('\nResults:', JSON.stringify(results, null, 2));
    } else {
      const report = await reconciler.scan();
      if (report.missing > 0) {
        console.log('To re-ingest missing messages, run:');
        console.log('  npm run reconcile -- --execute');
      }
    }
  } finally {
    await reconciler.disconnect();
  }

  process.exit(0);
})();
