/**
 * Telegram Reconciler
 *
 * Connects to Telegram as a user (MTProto), reads the full chat history
 * with the bot, diffs against Notion, and re-ingests missing messages.
 *
 * Usage:
 *   const reconciler = new TelegramReconciler(config);
 *   await reconciler.connect();
 *   const report = await reconciler.scan();        // dry run
 *   const results = await reconciler.execute();     // re-ingest missing
 *   await reconciler.disconnect();
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');

class TelegramReconciler {
  /**
   * @param {Object} config
   * @param {number} config.apiId
   * @param {string} config.apiHash
   * @param {string} config.session - StringSession string
   * @param {string} config.botUsername - Bot username (e.g. '@MyBot')
   * @param {Object} config.notionClient - NotionClient instance
   * @param {Object} config.pipeline - MediaPipeline instance
   * @param {string} config.tempDir - Temp directory for downloads
   */
  constructor(config) {
    this.apiId = config.apiId;
    this.apiHash = config.apiHash;
    this.botUsername = config.botUsername;
    this.notion = config.notionClient;
    this.pipeline = config.pipeline;
    this.tempDir = config.tempDir || path.join(__dirname, '..', 'data', 'tmp', 'reconcile');

    this.client = new TelegramClient(
      new StringSession(config.session),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5 }
    );
    this.client.floodSleepThreshold = 120;
  }

  async connect() {
    await this.client.connect();
    console.log('[Reconciler] Connected to Telegram');
  }

  async disconnect() {
    await this.client.disconnect();
    console.log('[Reconciler] Disconnected');
  }

  /**
   * Classify a Telegram message into a capture type.
   * Returns null for non-capture messages (commands, bot replies, etc.)
   */
  classifyMessage(msg) {
    // Skip bot messages (not outgoing from user)
    if (!msg.out) return null;

    // Skip replies (these are "My Take" appends, not new captures)
    if (msg.replyTo) return null;

    // Text messages
    if (!msg.media) {
      const text = msg.text || '';
      // Skip commands
      if (text.startsWith('/')) return null;
      // Skip very short messages
      if (text.trim().length < 2) return null;

      // Check for URLs
      const urls = text.match(/https?:\/\/[^\s]+/g);
      if (urls && urls.length > 0) {
        return { type: 'url', urls, text, annotation: text.replace(/https?:\/\/[^\s]+/g, '').trim() || null };
      }

      return { type: 'text', text };
    }

    // Photo
    if (msg.media instanceof Api.MessageMediaPhoto) {
      return { type: 'photo', caption: msg.text || null };
    }

    // Document-based media
    if (msg.media instanceof Api.MessageMediaDocument) {
      const doc = msg.media.document;
      if (!doc) return null;

      const attrs = doc.attributes || [];

      // Voice note
      if (msg.media.voice) {
        const audioAttr = attrs.find(a => a instanceof Api.DocumentAttributeAudio);
        return {
          type: 'voice',
          duration: audioAttr?.duration || 0,
          mimeType: doc.mimeType,
          size: Number(doc.size),
        };
      }

      // Audio file
      const audioAttr = attrs.find(a => a instanceof Api.DocumentAttributeAudio);
      if (audioAttr && !audioAttr.voice) {
        return {
          type: 'audio',
          duration: audioAttr.duration || 0,
          title: audioAttr.title || null,
          performer: audioAttr.performer || null,
          mimeType: doc.mimeType,
          size: Number(doc.size),
        };
      }

      // Video / round video
      const videoAttr = attrs.find(a => a instanceof Api.DocumentAttributeVideo);
      if (videoAttr) {
        return {
          type: msg.media.round ? 'video_note' : 'video',
          duration: videoAttr.duration || 0,
          mimeType: doc.mimeType,
          size: Number(doc.size),
        };
      }

      // Generic document (PDF, markdown, images as docs, media files)
      const filenameAttr = attrs.find(a => a instanceof Api.DocumentAttributeFilename);
      const filename = filenameAttr?.fileName || '';

      if (/\.(jpg|jpeg|png|webp|heic)$/i.test(filename)) {
        return { type: 'photo_doc', filename, mimeType: doc.mimeType, size: Number(doc.size) };
      }
      if (/\.(pdf)$/i.test(filename)) {
        return { type: 'pdf', filename, mimeType: doc.mimeType, size: Number(doc.size) };
      }
      if (/\.(md|markdown|txt)$/i.test(filename)) {
        return { type: 'text_doc', filename, mimeType: doc.mimeType, size: Number(doc.size) };
      }
      if (/\.(mp3|mp4|m4a|mov|wav|flac|ogg|opus|webm|mkv|avi|m4v|aac|wma)$/i.test(filename)) {
        return { type: 'media_doc', filename, mimeType: doc.mimeType, size: Number(doc.size) };
      }

      return { type: 'document', filename, mimeType: doc.mimeType, size: Number(doc.size) };
    }

    return null;
  }

  /**
   * Get extension for a media message.
   */
  getExtension(info) {
    const mimeMap = {
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'image/jpeg': '.jpg',
      'image/png': '.png',
    };

    if (info.filename) return path.extname(info.filename) || '.bin';
    return mimeMap[info.mimeType] || '.bin';
  }

  /**
   * Scan: pull all user messages from bot chat, diff against Notion.
   * Returns a report of missing messages without re-ingesting.
   */
  async scan() {
    console.log(`[Reconciler] Scanning chat with ${this.botUsername}...`);

    // Step 1: Get all messages from bot chat (from user only)
    const allMessages = [];
    for await (const msg of this.client.iterMessages(this.botUsername, { reverse: true })) {
      const info = this.classifyMessage(msg);
      if (info) {
        allMessages.push({
          id: msg.id,
          date: new Date(msg.date * 1000),
          info,
          msg,
        });
      }
    }

    console.log(`[Reconciler] Found ${allMessages.length} capture messages in Telegram`);

    // Step 2: Get all known Telegram IDs from Notion
    console.log('[Reconciler] Querying Notion for existing Telegram IDs...');
    const knownIds = await this.notion.queryAllTelegramIds();
    console.log(`[Reconciler] Found ${knownIds.size} pages with Telegram IDs in Notion`);

    // Step 3: Diff
    const missing = allMessages.filter(m => !knownIds.has(m.id));
    const synced = allMessages.filter(m => knownIds.has(m.id));

    // Build report
    const report = {
      total: allMessages.length,
      synced: synced.length,
      missing: missing.length,
      messages: missing.map(m => ({
        id: m.id,
        date: m.date.toISOString(),
        type: m.info.type,
        preview: this.previewMessage(m.info),
      })),
    };

    console.log('\n[Reconciler] ========== SCAN REPORT ==========');
    console.log(`  Total captures in Telegram: ${report.total}`);
    console.log(`  Already synced to Notion:   ${report.synced}`);
    console.log(`  Missing from Notion:        ${report.missing}`);

    if (report.missing > 0) {
      console.log('\n  Missing messages:');
      for (const m of report.messages) {
        console.log(`    [${m.id}] ${m.date} | ${m.type} | ${m.preview}`);
      }
    }

    console.log('[Reconciler] ================================\n');
    return report;
  }

  /**
   * Execute: re-ingest all missing messages through the pipeline.
   */
  async execute() {
    const report = await this.scan();

    if (report.missing === 0) {
      console.log('[Reconciler] Nothing to do -- all messages are synced.');
      return { processed: 0, failed: 0, results: [] };
    }

    console.log(`[Reconciler] Re-ingesting ${report.missing} missing message(s)...\n`);

    // Ensure temp dir
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Re-fetch the missing messages (scan() only returns summaries)
    const allMessages = [];
    for await (const msg of this.client.iterMessages(this.botUsername, { reverse: true })) {
      const info = this.classifyMessage(msg);
      if (info) allMessages.push({ id: msg.id, date: new Date(msg.date * 1000), info, msg });
    }

    const knownIds = await this.notion.queryAllTelegramIds();
    const missing = allMessages.filter(m => !knownIds.has(m.id));

    let processed = 0;
    let failed = 0;
    const results = [];

    for (const m of missing) {
      try {
        console.log(`[Reconciler] Processing [${m.id}] ${m.info.type}...`);
        const result = await this.reingest(m);
        results.push({ id: m.id, status: 'ok', ...result });
        processed++;
        console.log(`[Reconciler] OK: [${m.id}] -> ${result.title}`);
      } catch (error) {
        results.push({ id: m.id, status: 'error', error: error.message });
        failed++;
        console.error(`[Reconciler] FAIL: [${m.id}] ${error.message}`);
      }

      // Small delay between ingestions to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`\n[Reconciler] Done: ${processed} processed, ${failed} failed`);
    return { processed, failed, results };
  }

  /**
   * Re-ingest a single missing message through the appropriate pipeline path.
   */
  async reingest(entry) {
    const { id, info, msg } = entry;
    const opts = { telegramMessageId: id };

    switch (info.type) {
      case 'voice':
      case 'audio':
      case 'video':
      case 'video_note':
      case 'media_doc': {
        const ext = this.getExtension(info);
        const filePath = path.join(this.tempDir, `tg-reconcile-${id}${ext}`);
        await this.client.downloadMedia(msg.media, { outputFile: filePath });
        try {
          const title = info.title || `Reconciled ${info.type} ${id}`;
          return await this.pipeline.ingestFile(filePath, { title, ...opts });
        } finally {
          this.cleanupFile(filePath);
        }
      }

      case 'url': {
        // Ingest each URL in the message
        let lastResult = null;
        for (const url of info.urls) {
          lastResult = await this.pipeline.ingestUrl(url, { annotation: info.annotation, ...opts });
        }
        return lastResult;
      }

      case 'text': {
        return await this.pipeline.ingestText(info.text, opts);
      }

      case 'photo':
      case 'photo_doc': {
        // Download photo, run through OCR pipeline
        const ext = info.type === 'photo' ? '.jpg' : this.getExtension(info);
        const filePath = path.join(this.tempDir, `tg-reconcile-${id}${ext}`);
        await this.client.downloadMedia(msg.media, { outputFile: filePath });
        try {
          // Use the pipeline's OCR if available, otherwise just create a basic page
          const ocr = require('./ocr');
          const ocrText = await ocr.ocrImage(filePath, { context: info.caption });
          const title = info.caption || ocrText.split('\n')[0].slice(0, 80) || `Photo ${id}`;

          let summary = null;
          if (this.pipeline.summarizer && ocrText.length > 100) {
            summary = await this.pipeline.summarizer.summarize(ocrText, 'idea', { title });
          }

          const pageId = await this.notion.createStructuredPage({
            title: summary?.title || title,
            content: ocrText,
            summary,
            source: 'Idea',
            metadata: {},
            telegramMessageId: id,
          });

          return { pageId, title: summary?.title || title };
        } finally {
          this.cleanupFile(filePath);
        }
      }

      case 'pdf': {
        const filePath = path.join(this.tempDir, `tg-reconcile-${id}.pdf`);
        await this.client.downloadMedia(msg.media, { outputFile: filePath });
        try {
          const pdfParse = require('pdf-parse');
          const buffer = fs.readFileSync(filePath);
          const data = await pdfParse(buffer);
          const title = data.info?.Title || info.filename?.replace(/\.pdf$/i, '') || `PDF ${id}`;

          let summary = null;
          if (this.pipeline.summarizer && data.text.length > 100) {
            summary = await this.pipeline.summarizer.summarize(data.text, 'pdf', { title });
          }

          const pageId = await this.notion.createStructuredPage({
            title: summary?.title || title,
            content: data.text,
            summary,
            source: 'Idea',
            sourceFilename: info.filename,
            metadata: {},
            telegramMessageId: id,
          });

          return { pageId, title: summary?.title || title };
        } finally {
          this.cleanupFile(filePath);
        }
      }

      case 'text_doc': {
        const filePath = path.join(this.tempDir, `tg-reconcile-${id}${this.getExtension(info)}`);
        await this.client.downloadMedia(msg.media, { outputFile: filePath });
        try {
          const text = fs.readFileSync(filePath, 'utf8');
          const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim();
          const title = firstLine.slice(0, 100) || info.filename?.replace(/\.[^/.]+$/, '') || `Text ${id}`;

          let summary = null;
          if (this.pipeline.summarizer && text.length > 100) {
            summary = await this.pipeline.summarizer.summarize(text, 'article', { title });
          }

          const pageId = await this.notion.createStructuredPage({
            title: summary?.title || title,
            content: text,
            summary,
            source: 'Idea',
            sourceFilename: info.filename,
            metadata: {},
            telegramMessageId: id,
          });

          return { pageId, title: summary?.title || title };
        } finally {
          this.cleanupFile(filePath);
        }
      }

      default:
        throw new Error(`Unsupported message type: ${info.type}`);
    }
  }

  previewMessage(info) {
    switch (info.type) {
      case 'voice': return `${info.duration}s voice note`;
      case 'audio': return `${info.title || 'audio'} (${info.duration}s)`;
      case 'video':
      case 'video_note': return `${info.duration}s ${info.type}`;
      case 'url': return info.urls[0] + (info.urls.length > 1 ? ` (+${info.urls.length - 1})` : '');
      case 'text': return info.text.slice(0, 60);
      case 'photo': return info.caption || 'photo';
      case 'photo_doc':
      case 'pdf':
      case 'text_doc':
      case 'media_doc':
      case 'document': return info.filename || info.type;
      default: return info.type;
    }
  }

  cleanupFile(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

module.exports = TelegramReconciler;
