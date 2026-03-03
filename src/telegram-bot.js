/**
 * Telegram Bot - Mobile capture layer for voice-to-notion
 *
 * Receives URLs, voice notes, audio, video, and photos via Telegram
 * and routes them through the existing MediaPipeline to Notion.
 *
 * Features:
 * - Photo OCR via Gemini 2.5 Flash
 * - Reply chain: reply to any message with voice/text to append "My Take"
 * - Long-polling (no webhook/SSL/port exposure needed)
 */

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { ocrImage } = require('./ocr');

const URL_REGEX = /https?:\/\/[^\s]+/g;

class TelegramBot {
  constructor({ pipeline, notionClient, tempDir }) {
    this.pipeline = pipeline;
    this.notion = notionClient;
    this.tempDir = tempDir || '/tmp/telegram-downloads';

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

    this.bot = new Telegraf(token);
    this.allowedUsers = this.parseAllowedUsers();

    // Reply chain: track messages that created Notion pages
    // message_id -> { pageId, timestamp }
    this.pendingSources = new Map();

    this.ensureDir(this.tempDir);
    this.registerHandlers();
    this.startCleanupTimer();
  }

  parseAllowedUsers() {
    const raw = process.env.TELEGRAM_ALLOWED_USERS || '';
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    return new Set(ids);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  registerHandlers() {
    // Auth middleware -- silently ignore unauthorized users
    this.bot.use((ctx, next) => {
      if (this.allowedUsers.size > 0 && !this.allowedUsers.has(ctx.from?.id)) {
        return; // silent reject
      }
      return next();
    });

    // /start command
    this.bot.start((ctx) => {
      ctx.reply(
        'Send me URLs, voice notes, photos, or media files.\n' +
        'I\'ll transcribe/OCR and save to Notion.\n\n' +
        'Reply to any message with voice or text to add your take.'
      );
    });

    // Text messages (extract URLs, or reply chain)
    this.bot.on(message('text'), (ctx) => this.handleText(ctx));

    // Voice messages
    this.bot.on(message('voice'), (ctx) => this.handleFile(ctx, 'voice'));

    // Audio files
    this.bot.on(message('audio'), (ctx) => this.handleFile(ctx, 'audio'));

    // Video files
    this.bot.on(message('video'), (ctx) => this.handleFile(ctx, 'video'));

    // Video notes (round video messages)
    this.bot.on(message('video_note'), (ctx) => this.handleFile(ctx, 'video_note'));

    // Photo messages (OCR)
    this.bot.on(message('photo'), (ctx) => this.handlePhoto(ctx));

    // Documents (check if media or image)
    this.bot.on(message('document'), (ctx) => this.handleDocument(ctx));
  }

  // ─── Reply Chain ───────────────────────────────────────────────────────────

  /**
   * Check if this message is a reply to a tracked source.
   * Returns true if handled as reply chain, false otherwise.
   */
  async checkReplyChain(ctx) {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo || !this.pendingSources.has(replyTo.message_id)) {
      return false;
    }
    await this.handleReplyChain(ctx, replyTo.message_id);
    return true;
  }

  /**
   * Handle a reply to a tracked source: transcribe/extract text,
   * then append "My Take" section to the existing Notion page.
   */
  async handleReplyChain(ctx, originalMessageId) {
    const { pageId } = this.pendingSources.get(originalMessageId);
    const status = await ctx.reply('Adding your take...');
    let tempPath = null;

    try {
      let replyText = '';

      if (ctx.message.voice || ctx.message.audio) {
        // Voice/audio reply: transcribe without creating Notion page
        const fileObj = ctx.message.voice || ctx.message.audio;
        tempPath = await this.downloadTelegramFile(ctx, fileObj.file_id, 'voice');
        const result = await this.pipeline.ingestFile(tempPath, {
          title: 'reply',
          skipNotion: true,
        });
        replyText = result.transcript;
      } else if (ctx.message.text) {
        replyText = ctx.message.text;
      } else if (ctx.message.photo) {
        // Photo reply: OCR the image and append as text
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        tempPath = await this.downloadTelegramFile(ctx, largest.file_id, 'photo');
        replyText = await ocrImage(tempPath);
      }

      if (!replyText) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, status.message_id, null,
          'Could not extract content from your reply.'
        );
        return;
      }

      // Append "My Take" section to existing Notion page
      const blocks = [
        { object: 'block', type: 'divider', divider: {} },
        {
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: [{ type: 'text', text: { content: 'My Take' } }],
          },
        },
        ...this.notion.splitText(replyText, 1900).map(chunk => ({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: chunk } }],
          },
        })),
      ];

      await this.notion.appendBlocks(pageId, blocks);
      this.pendingSources.delete(originalMessageId);

      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        'Added your take to the page.'
      );
    } catch (error) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Failed to add take: ${error.message}`
      );
    } finally {
      this.cleanup(tempPath);
    }
  }

  /**
   * Track a message that created a Notion page (for reply chain).
   */
  trackSource(messageId, pageId) {
    this.pendingSources.set(messageId, { pageId, timestamp: Date.now() });
  }

  /**
   * Clean up expired pending sources every 5 minutes.
   * Pages are already created, so expiry just stops tracking.
   */
  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const TTL = 30 * 60 * 1000; // 30 minutes
      for (const [msgId, { timestamp }] of this.pendingSources) {
        if (now - timestamp > TTL) {
          this.pendingSources.delete(msgId);
        }
      }
    }, 5 * 60 * 1000);
  }

  // ─── Message Handlers ─────────────────────────────────────────────────────

  async handleText(ctx) {
    // Check reply chain first
    if (await this.checkReplyChain(ctx)) return;

    const text = ctx.message.text;
    const urls = text.match(URL_REGEX);

    if (!urls || urls.length === 0) {
      return ctx.reply('No URLs found. Send a link, voice note, photo, or media file.');
    }

    for (const url of urls) {
      const status = await ctx.reply(`Processing: ${url}`);
      try {
        const result = await this.pipeline.ingest(url);
        this.trackSource(ctx.message.message_id, result.pageId);
        await ctx.telegram.editMessageText(
          ctx.chat.id, status.message_id, null,
          `Done: ${result.title}\n${result.notionUrl}`
        );
      } catch (error) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, status.message_id, null,
          `Failed: ${error.message}`
        );
      }
    }
  }

  async handlePhoto(ctx) {
    // Check reply chain first
    if (await this.checkReplyChain(ctx)) return;

    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1]; // highest resolution

    // Telegram Bot API limit: 20MB
    if (largest.file_size && largest.file_size > 20 * 1024 * 1024) {
      return ctx.reply('Image too large (>20MB).');
    }

    const status = await ctx.reply('Processing image (OCR)...');
    let tempPath = null;

    try {
      tempPath = await this.downloadTelegramFile(ctx, largest.file_id, 'photo');
      const ocrText = await ocrImage(tempPath);

      // Use first line of OCR as title, fallback to timestamp
      const firstLine = ocrText.split('\n')[0].replace(/^#+\s*/, '').trim();
      const title = firstLine.slice(0, 80) || `Image ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

      const pageId = await this.notion.createTranscriptPage({
        title,
        transcript: ocrText,
        source: 'Idea',
        metadata: {},
      });

      this.trackSource(ctx.message.message_id, pageId);

      const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Done: ${title}\n${notionUrl}`
      );
    } catch (error) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Failed: ${error.message}`
      );
    } finally {
      this.cleanup(tempPath);
    }
  }

  getDefaultTitle(type, ctx) {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
    const labels = { voice: 'Voice Note', video_note: 'Video Note', video: 'Video', audio: 'Audio' };

    // Audio files from Telegram often carry metadata
    if (type === 'audio' && ctx.message.audio) {
      const a = ctx.message.audio;
      if (a.title) return a.title;
      if (a.file_name) return a.file_name.replace(/\.[^/.]+$/, '');
    }

    return `${labels[type] || 'Media'} ${stamp}`;
  }

  async handleFile(ctx, type) {
    // Check reply chain first
    if (await this.checkReplyChain(ctx)) return;

    let fileObj;
    if (type === 'voice') fileObj = ctx.message.voice;
    else if (type === 'audio') fileObj = ctx.message.audio;
    else if (type === 'video') fileObj = ctx.message.video;
    else if (type === 'video_note') fileObj = ctx.message.video_note;

    if (!fileObj) return;

    // Telegram Bot API limit: 20MB download
    if (fileObj.file_size && fileObj.file_size > 20 * 1024 * 1024) {
      return ctx.reply('File too large (>20MB). Use the CLI for big files.');
    }

    const title = this.getDefaultTitle(type, ctx);
    const status = await ctx.reply(`Processing ${type}...`);
    let tempPath = null;

    try {
      tempPath = await this.downloadTelegramFile(ctx, fileObj.file_id, type);
      const result = await this.pipeline.ingestFile(tempPath, { title });
      this.trackSource(ctx.message.message_id, result.pageId);
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Done: ${result.title}\n${result.notionUrl}`
      );
    } catch (error) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Failed: ${error.message}`
      );
    } finally {
      this.cleanup(tempPath);
    }
  }

  async handleDocument(ctx) {
    // Check reply chain first
    if (await this.checkReplyChain(ctx)) return;

    const doc = ctx.message.document;
    if (!doc) return;

    // Accept media files and image files
    const mediaExts = /\.(mp3|mp4|m4a|mov|wav|flac|ogg|opus|webm|mkv|avi|m4v|aac|wma)$/i;
    const imageExts = /\.(jpg|jpeg|png|webp|heic)$/i;

    if (imageExts.test(doc.file_name || '')) {
      // Route image documents through photo/OCR handler
      if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
        return ctx.reply('Image too large (>20MB).');
      }

      const status = await ctx.reply(`Processing image: ${doc.file_name}`);
      let tempPath = null;

      try {
        tempPath = await this.downloadTelegramFile(ctx, doc.file_id, 'photo', doc.file_name);
        const ocrText = await ocrImage(tempPath);

        const firstLine = ocrText.split('\n')[0].replace(/^#+\s*/, '').trim();
        const title = firstLine.slice(0, 80) || doc.file_name.replace(/\.[^/.]+$/, '');

        const pageId = await this.notion.createTranscriptPage({
          title,
          transcript: ocrText,
          source: 'Idea',
          sourceFilename: doc.file_name,
          metadata: {},
        });

        this.trackSource(ctx.message.message_id, pageId);

        const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
        await ctx.telegram.editMessageText(
          ctx.chat.id, status.message_id, null,
          `Done: ${title}\n${notionUrl}`
        );
      } catch (error) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, status.message_id, null,
          `Failed: ${error.message}`
        );
      } finally {
        this.cleanup(tempPath);
      }
      return;
    }

    if (!mediaExts.test(doc.file_name || '')) {
      return ctx.reply(`Unsupported file type: ${doc.file_name}. Send media files, images, or URLs.`);
    }

    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      return ctx.reply('File too large (>20MB). Use the CLI for big files.');
    }

    const title = doc.file_name ? doc.file_name.replace(/\.[^/.]+$/, '') : 'Document';
    const status = await ctx.reply(`Processing: ${doc.file_name}`);
    let tempPath = null;

    try {
      tempPath = await this.downloadTelegramFile(ctx, doc.file_id, 'document', doc.file_name);
      const result = await this.pipeline.ingestFile(tempPath, { title });
      this.trackSource(ctx.message.message_id, result.pageId);
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Done: ${result.title}\n${result.notionUrl}`
      );
    } catch (error) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, null,
        `Failed: ${error.message}`
      );
    } finally {
      this.cleanup(tempPath);
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Download a file from Telegram to a temp path
   */
  async downloadTelegramFile(ctx, fileId, type, originalName) {
    const fileLink = await ctx.telegram.getFileLink(fileId);

    // Determine extension
    let ext;
    if (originalName) {
      ext = path.extname(originalName);
    } else if (type === 'voice') {
      ext = '.ogg'; // Telegram voice messages are opus in ogg
    } else if (type === 'video' || type === 'video_note') {
      ext = '.mp4';
    } else if (type === 'photo') {
      ext = '.jpg';
    } else {
      ext = '.mp3';
    }

    const filename = `tg-${Date.now()}${ext}`;
    const tempPath = path.join(this.tempDir, filename);

    const response = await axios({
      url: fileLink.href || fileLink,
      method: 'GET',
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const size = fs.statSync(tempPath).size;
    console.log(`[TelegramBot] Downloaded: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    return tempPath;
  }

  cleanup(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  async start() {
    console.log('[TelegramBot] Starting (long-polling)...');
    if (this.allowedUsers.size > 0) {
      console.log(`[TelegramBot] Authorized users: ${[...this.allowedUsers].join(', ')}`);
    } else {
      console.log('[TelegramBot] WARNING: No TELEGRAM_ALLOWED_USERS set -- bot is open to everyone');
    }

    this.bot.launch();
    console.log('[TelegramBot] Running (photo OCR + reply chain enabled)');
  }

  stop() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.bot.stop('shutdown');
  }
}

module.exports = TelegramBot;
