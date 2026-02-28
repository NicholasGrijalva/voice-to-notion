#!/usr/bin/env node
/**
 * Quick CLI tool to ingest a URL through the media pipeline
 *
 * Usage:
 *   node scripts/ingest-url.js <url>
 *   node scripts/ingest-url.js https://youtube.com/watch?v=xxxxx
 *   npm run ingest -- https://youtube.com/watch?v=xxxxx
 *
 * This writes a .txt file to the inbox_media/ directory.
 * The running worker will pick it up automatically.
 *
 * Alternatively, you can run the full pipeline directly (without the worker):
 *   DIRECT=1 node scripts/ingest-url.js <url>
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const url = process.argv[2];

if (!url) {
  console.error('Usage: node scripts/ingest-url.js <url>');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/ingest-url.js https://youtube.com/watch?v=dQw4w9WgXcQ');
  console.error('  node scripts/ingest-url.js https://podcasts.apple.com/...');
  console.error('');
  console.error('Options:');
  console.error('  DIRECT=1  Run pipeline directly instead of dropping to inbox');
  process.exit(1);
}

if (!url.startsWith('http')) {
  console.error(`Invalid URL: ${url}`);
  process.exit(1);
}

const isDirect = process.env.DIRECT === '1';

if (isDirect) {
  // Run the pipeline directly
  const ScriberrClient = require('../src/scriberr');
  const NotionClient = require('../src/notion');
  const MediaPipeline = require('../src/media-pipeline');
  const GroqTranscriber = require('../src/groq-transcriber');

  const scriberr = new ScriberrClient(
    process.env.SCRIBERR_API_URL || 'http://localhost:8080',
    process.env.SCRIBERR_USERNAME,
    process.env.SCRIBERR_PASSWORD
  );
  const notion = new NotionClient(
    process.env.NOTION_API_KEY,
    process.env.NOTION_DATABASE_ID
  );
  const groq = process.env.GROQ_API_KEY ? new GroqTranscriber(process.env.GROQ_API_KEY) : null;

  const pipeline = new MediaPipeline({
    notionClient: notion,
    scriberrClient: scriberr,
    groqTranscriber: groq
  });

  console.log(`Ingesting URL directly: ${url}`);
  scriberr.init().then(() => pipeline.ingest(url))
    .then(result => {
      console.log(`\nDone! ${result.notionUrl}`);
      process.exit(0);
    })
    .catch(error => {
      console.error(`\nFailed: ${error.message}`);
      process.exit(1);
    });

} else {
  // Drop a .txt file to inbox
  const inboxDir = process.env.MEDIA_INBOX_DIR || path.join(__dirname, '..', 'inbox_media');

  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  const timestamp = Date.now();
  const filename = `ingest-${timestamp}.txt`;
  const filePath = path.join(inboxDir, filename);

  fs.writeFileSync(filePath, url + '\n');
  console.log(`Queued for ingestion: ${url}`);
  console.log(`File: ${filePath}`);
  console.log(`The worker will pick this up on its next scan cycle.`);
}
