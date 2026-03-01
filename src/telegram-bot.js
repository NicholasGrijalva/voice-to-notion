/**
 * Telegram Bot - Mobile capture layer for voice-to-notion
 *
 * Receives URLs, voice notes, audio, and video via Telegram
 * and routes them through the existing MediaPipeline to Notion.
 *
 * Uses long-polling (no webhook/SSL/port exposure needed).
 */

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

    this.ensureDir(this.tempDir);
    this.registerHandlers();
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
      ctx.reply('Send me URLs, voice notes, or media files. I\'ll transcribe and save to Notion.');
    });

    // Text messages (extract URLs)
    this.bot.on(message('text'), (ctx) => this.handleText(ctx));

    // Voice messages
    this.bot.on(message('voice'), (ctx) => this.handleFile(ctx, 'voice'));

    // Audio files
    this.bot.on(message('audio'), (ctx) => this.handleFile(ctx, 'audio'));

    // Video files
    this.bot.on(message('video'), (ctx) => this.handleFile(ctx, 'video'));

    // Video notes (round video messages)
    this.bot.on(message('video_note'), (ctx) => this.handleFile(ctx, 'video_note'));

    // Documents (check if media)
    this.bot.on(message('document'), (ctx) => this.handleDocument(ctx));
  }

  async handleText(ctx) {
    const text = ctx.message.text;
    const urls = text.match(URL_REGEX);

    if (!urls || urls.length === 0) {
      return ctx.reply('No URLs found. Send a link, voice note, or media file.');
    }

    for (const url of urls) {
      const status = await ctx.reply(`Processing: ${url}`);
      try {
        const result = await this.pipeline.ingest(url);
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
    const doc = ctx.message.document;
    if (!doc) return;

    // Only process media files
    const mediaExts = /\.(mp3|mp4|m4a|mov|wav|flac|ogg|opus|webm|mkv|avi|m4v|aac|wma)$/i;
    if (!mediaExts.test(doc.file_name || '')) {
      return ctx.reply(`Unsupported file type: ${doc.file_name}. Send media files or URLs.`);
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
    console.log('[TelegramBot] Running');
  }

  stop() {
    this.bot.stop('shutdown');
  }
}

module.exports = TelegramBot;
