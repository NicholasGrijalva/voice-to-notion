#!/usr/bin/env node
/**
 * CLI tool to ingest local media files through the pipeline
 *
 * Modes:
 *   Interactive:  npm run ingest-file                     (launches file picker)
 *   Single file:  npm run ingest-file -- /path/to/file.mp4
 *   Glob pattern: npm run ingest-file -- "/dir/*.mp4"
 *   Multiple:     npm run ingest-file -- file1.mp3 file2.mov
 *
 * Files are processed in-place -- originals are never modified or moved.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const MEDIA_PATTERN = /\.(mp3|mp4|m4a|mov|wav|flac|ogg|opus|webm|mkv|avi|m4v|aac|wma)$/i;

// ─── Resolve files from args or interactive picker ───────────────────────────

async function resolveFiles() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    return await interactivePicker();
  }

  // Expand globs and resolve paths
  const files = [];
  for (const arg of args) {
    if (arg.includes('*') || arg.includes('?')) {
      // Glob pattern
      const matches = await fg(arg, { absolute: true, onlyFiles: true });
      const mediaMatches = matches.filter(f => MEDIA_PATTERN.test(f));
      if (mediaMatches.length === 0) {
        console.warn(`No media files matched pattern: ${arg}`);
      }
      files.push(...mediaMatches);
    } else {
      const absPath = path.resolve(arg);
      if (!fs.existsSync(absPath)) {
        console.error(`File not found: ${absPath}`);
        process.exit(1);
      }
      if (!MEDIA_PATTERN.test(absPath)) {
        console.error(`Not a supported media file: ${path.basename(absPath)}`);
        console.error('Supported: mp3, mp4, m4a, mov, wav, flac, ogg, opus, webm, mkv, avi, m4v, aac, wma');
        process.exit(1);
      }
      files.push(absPath);
    }
  }

  if (files.length === 0) {
    console.error('No files to process.');
    process.exit(1);
  }

  return files;
}

// ─── Interactive file picker ─────────────────────────────────────────────────

async function interactivePicker() {
  const { Input, MultiSelect } = require('enquirer');

  // Step 1: Ask for directory
  const dirPrompt = new Input({
    message: 'Directory to scan for media files',
    initial: process.cwd(),
    validate: (val) => {
      const resolved = val.startsWith('~') ? val.replace('~', process.env.HOME) : val;
      if (!fs.existsSync(resolved)) return 'Directory not found';
      if (!fs.statSync(resolved).isDirectory()) return 'Not a directory';
      return true;
    }
  });

  let dir = await dirPrompt.run();
  dir = dir.startsWith('~') ? dir.replace('~', process.env.HOME) : dir;
  dir = path.resolve(dir);

  // Step 2: Find media files (1 level deep by default)
  const pattern = path.join(dir, '**').replace(/\\/g, '/');
  const allFiles = await fg(pattern, {
    absolute: true,
    onlyFiles: true,
    deep: 2 // current dir + 1 level of subdirs
  });

  const mediaFiles = allFiles
    .filter(f => MEDIA_PATTERN.test(f))
    .sort((a, b) => a.localeCompare(b));

  if (mediaFiles.length === 0) {
    console.log(`No media files found in ${dir}`);
    process.exit(0);
  }

  // Step 3: Let user pick files
  const choices = mediaFiles.map(f => {
    const rel = path.relative(dir, f);
    const size = (fs.statSync(f).size / 1024 / 1024).toFixed(1);
    return {
      name: f,
      message: `${rel} (${size} MB)`
    };
  });

  const selectPrompt = new MultiSelect({
    message: `Select files to transcribe (${mediaFiles.length} found)`,
    choices,
    hint: 'Use space to select, enter to confirm',
    validate: (val) => val.length > 0 ? true : 'Select at least one file'
  });

  return await selectPrompt.run();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const files = await resolveFiles();

  console.log(`\nProcessing ${files.length} file(s):\n`);
  for (const f of files) {
    const size = (fs.statSync(f).size / 1024 / 1024).toFixed(1);
    console.log(`  ${path.basename(f)} (${size} MB)`);
  }
  console.log('');

  // Initialize pipeline
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
  if (groq) console.log('Using Groq cloud transcription (Scriberr fallback)');

  const pipeline = new MediaPipeline({
    notionClient: notion,
    scriberrClient: scriberr,
    groqTranscriber: groq
  });

  await scriberr.init();

  // Process each file
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = path.basename(f);
    console.log(`\n[${i + 1}/${files.length}] ${name}`);

    try {
      const result = await pipeline.ingestFile(f);
      console.log(`Done -> ${result.notionUrl}`);
      succeeded++;
    } catch (error) {
      console.error(`Failed: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n--- Complete: ${succeeded} succeeded, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(`\nFatal: ${error.message}`);
  process.exit(1);
});
