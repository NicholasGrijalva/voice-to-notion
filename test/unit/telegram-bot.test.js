const fs = require('fs');
const path = require('path');

const ocr = require('../../src/ocr');
const TelegramBot = require('../../src/telegram-bot');

describe('TelegramBot', () => {
  let bot;
  let mockPipeline;
  let mockNotion;
  let mockBotInst;

  // Captured handler callbacks from mockBotInst.use / .start / .on
  let authMiddleware;
  let startHandler;
  let handlers;

  const ENV_BACKUP = {};

  beforeEach(() => {
    vi.restoreAllMocks();

    // Save and set env vars
    ENV_BACKUP.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    ENV_BACKUP.TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
    delete process.env.TELEGRAM_ALLOWED_USERS;

    // Spy on fs methods before construction
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue({
      on: vi.fn((event, cb) => {
        if (event === 'finish') setTimeout(cb, 0);
      }),
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1024 });
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

    // Mock injected dependencies
    mockPipeline = {
      ingest: vi.fn().mockResolvedValue({
        title: 'Test Result',
        notionUrl: 'https://notion.so/page123',
        pageId: 'page-123',
      }),
      ingestFile: vi.fn().mockResolvedValue({
        title: 'Test File Result',
        notionUrl: 'https://notion.so/page456',
        pageId: 'page-456',
      }),
    };

    // Mock Notion client for reply chain tests
    mockNotion = {
      appendBlocks: vi.fn().mockResolvedValue(),
      uploadFile: vi.fn().mockResolvedValue('upload-id'),
      createTranscriptPage: vi.fn().mockResolvedValue('page-id'),
      splitText: vi.fn((text, max) => {
        if (!text) return [''];
        const chunks = [];
        for (let i = 0; i < text.length; i += max) {
          chunks.push(text.slice(i, i + max));
        }
        return chunks;
      }),
    };

    // Create TelegramBot (real Telegraf constructor runs but doesn't connect)
    bot = new TelegramBot({
      pipeline: mockPipeline,
      notionClient: mockNotion,
      tempDir: '/tmp/test-telegram',
    });

    // Replace bot.bot with a mock object to capture handler registrations
    mockBotInst = {
      use: vi.fn(),
      start: vi.fn(),
      on: vi.fn(),
      launch: vi.fn(),
      stop: vi.fn(),
    };

    handlers = {};
    authMiddleware = null;
    startHandler = null;
    mockBotInst.use.mockImplementation((fn) => { authMiddleware = fn; });
    mockBotInst.start.mockImplementation((fn) => { startHandler = fn; });
    mockBotInst.on.mockImplementation((filter, fn) => { handlers[filter] = fn; });

    // Replace with mock and re-register handlers so we can capture them
    bot.bot = mockBotInst;
    bot.registerHandlers();
  });

  afterEach(() => {
    if (ENV_BACKUP.TELEGRAM_BOT_TOKEN !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = ENV_BACKUP.TELEGRAM_BOT_TOKEN;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
    if (ENV_BACKUP.TELEGRAM_ALLOWED_USERS !== undefined) {
      process.env.TELEGRAM_ALLOWED_USERS = ENV_BACKUP.TELEGRAM_ALLOWED_USERS;
    } else {
      delete process.env.TELEGRAM_ALLOWED_USERS;
    }
  });

  // Helper: build a mock Telegram context object
  function makeCtx(overrides = {}) {
    return {
      from: { id: 123 },
      chat: { id: 456 },
      message: {
        text: '',
        voice: null,
        audio: null,
        video: null,
        video_note: null,
        document: null,
        ...overrides.message,
      },
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
      telegram: {
        editMessageText: vi.fn().mockResolvedValue({}),
        getFileLink: vi.fn().mockResolvedValue({ href: 'https://api.telegram.org/file/bot123/voice.ogg' }),
        ...overrides.telegram,
      },
      ...overrides,
    };
  }

  // Helper: build a reply context pointing at a tracked message
  function makeReplyCtx(trackedMessageId, overrides = {}) {
    const { message: msgOverrides, ...restOverrides } = overrides;
    return makeCtx({
      message: {
        reply_to_message: { message_id: trackedMessageId },
        ...msgOverrides,
      },
      ...restOverrides,
    });
  }

  describe('constructor', () => {
    it('should throw when TELEGRAM_BOT_TOKEN not set', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;

      expect(() => new TelegramBot({
        pipeline: mockPipeline,
        notionClient: {},
      })).toThrow('TELEGRAM_BOT_TOKEN not set');
    });

    it('should use default tempDir when not provided', () => {
      const b = new TelegramBot({
        pipeline: mockPipeline,
        notionClient: {},
      });
      expect(b.tempDir).toBe('/tmp/telegram-downloads');
    });

    it('should create temp directory when it does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockClear();

      new TelegramBot({
        pipeline: mockPipeline,
        notionClient: {},
        tempDir: '/tmp/new-dir',
      });

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/new-dir', { recursive: true });
    });

    it('should store pipeline and notionClient references', () => {
      expect(bot.pipeline).toBe(mockPipeline);
    });

    it('should register handlers on bot after construction', () => {
      // After beforeEach, registerHandlers was called on mockBotInst
      expect(mockBotInst.use).toHaveBeenCalledTimes(1);
      expect(mockBotInst.start).toHaveBeenCalledTimes(1);
      expect(mockBotInst.on).toHaveBeenCalled();
    });
  });

  describe('parseAllowedUsers()', () => {
    it('should parse comma-separated user IDs into Set', () => {
      process.env.TELEGRAM_ALLOWED_USERS = '111,222,333';
      const result = bot.parseAllowedUsers();
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has(111)).toBe(true);
      expect(result.has(222)).toBe(true);
      expect(result.has(333)).toBe(true);
    });

    it('should return empty Set when env var not set', () => {
      delete process.env.TELEGRAM_ALLOWED_USERS;
      const result = bot.parseAllowedUsers();
      expect(result.size).toBe(0);
    });

    it('should handle whitespace in IDs', () => {
      process.env.TELEGRAM_ALLOWED_USERS = ' 111 , 222 , 333 ';
      const result = bot.parseAllowedUsers();
      expect(result.size).toBe(3);
      expect(result.has(111)).toBe(true);
    });
  });

  describe('auth middleware', () => {
    it('should call next() for authorized user', async () => {
      bot.allowedUsers = new Set([123]);
      const ctx = makeCtx({ from: { id: 123 } });
      const next = vi.fn();

      await authMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('should silently reject unauthorized user (no next call)', async () => {
      bot.allowedUsers = new Set([999]);
      const ctx = makeCtx({ from: { id: 123 } });
      const next = vi.fn();

      await authMiddleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should call next() when allowedUsers is empty (open access)', async () => {
      bot.allowedUsers = new Set();
      const ctx = makeCtx({ from: { id: 123 } });
      const next = vi.fn();

      await authMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('handleText()', () => {
    it('should extract URLs and call pipeline.ingest() for each', async () => {
      const ctx = makeCtx({ message: { text: 'Check https://example.com' } });

      await bot.handleText(ctx);

      expect(mockPipeline.ingest).toHaveBeenCalledWith('https://example.com');
    });

    it('should reply with help when no URLs found', async () => {
      const ctx = makeCtx({ message: { text: 'no links here' } });

      await bot.handleText(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No URLs found'));
      expect(mockPipeline.ingest).not.toHaveBeenCalled();
    });

    it('should edit message with result on success', async () => {
      const ctx = makeCtx({ message: { text: 'https://example.com' } });

      await bot.handleText(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        expect.stringContaining('Done: Test Result')
      );
    });

    it('should edit message with error on failure', async () => {
      mockPipeline.ingest.mockRejectedValue(new Error('Download failed'));
      const ctx = makeCtx({ message: { text: 'https://example.com' } });

      await bot.handleText(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        expect.stringContaining('Failed: Download failed')
      );
    });

    it('should handle multiple URLs in single message', async () => {
      const ctx = makeCtx({
        message: { text: 'https://first.com and https://second.com' },
      });

      await bot.handleText(ctx);

      expect(mockPipeline.ingest).toHaveBeenCalledTimes(2);
      expect(mockPipeline.ingest).toHaveBeenCalledWith('https://first.com');
      expect(mockPipeline.ingest).toHaveBeenCalledWith('https://second.com');
    });
  });

  describe('getDefaultTitle()', () => {
    it('should return "Voice Note YYYY-MM-DD HH:MM" for voice type', () => {
      const ctx = makeCtx();
      const title = bot.getDefaultTitle('voice', ctx);
      expect(title).toMatch(/^Voice Note \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should return "Video Note YYYY-MM-DD HH:MM" for video_note type', () => {
      const ctx = makeCtx();
      const title = bot.getDefaultTitle('video_note', ctx);
      expect(title).toMatch(/^Video Note \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should return audio title from ctx.message.audio.title when available', () => {
      const ctx = makeCtx({
        message: { audio: { title: 'My Podcast Episode', file_name: 'ep42.mp3' } },
      });
      const title = bot.getDefaultTitle('audio', ctx);
      expect(title).toBe('My Podcast Episode');
    });

    it('should return filename without extension from ctx.message.audio.file_name', () => {
      const ctx = makeCtx({
        message: { audio: { file_name: 'episode_42.mp3' } },
      });
      const title = bot.getDefaultTitle('audio', ctx);
      expect(title).toBe('episode_42');
    });

    it('should fall back to "Audio YYYY-MM-DD HH:MM" when no metadata', () => {
      const ctx = makeCtx({ message: { audio: null } });
      const title = bot.getDefaultTitle('audio', ctx);
      expect(title).toMatch(/^Audio \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });

  describe('handleFile()', () => {
    it('should extract correct fileObj for voice type', async () => {
      const voiceFile = { file_id: 'voice-1', file_size: 50000 };
      const ctx = makeCtx({ message: { voice: voiceFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.ogg');

      await bot.handleFile(ctx, 'voice');

      expect(bot.downloadTelegramFile).toHaveBeenCalledWith(ctx, 'voice-1', 'voice');
    });

    it('should extract correct fileObj for audio type', async () => {
      const audioFile = { file_id: 'audio-1', file_size: 50000 };
      const ctx = makeCtx({ message: { audio: audioFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.mp3');

      await bot.handleFile(ctx, 'audio');

      expect(bot.downloadTelegramFile).toHaveBeenCalledWith(ctx, 'audio-1', 'audio');
    });

    it('should extract correct fileObj for video type', async () => {
      const videoFile = { file_id: 'video-1', file_size: 50000 };
      const ctx = makeCtx({ message: { video: videoFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.mp4');

      await bot.handleFile(ctx, 'video');

      expect(bot.downloadTelegramFile).toHaveBeenCalledWith(ctx, 'video-1', 'video');
    });

    it('should extract correct fileObj for video_note type', async () => {
      const videoNoteFile = { file_id: 'vnote-1', file_size: 50000 };
      const ctx = makeCtx({ message: { video_note: videoNoteFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.mp4');

      await bot.handleFile(ctx, 'video_note');

      expect(bot.downloadTelegramFile).toHaveBeenCalledWith(ctx, 'vnote-1', 'video_note');
    });

    it('should reject files > 20MB', async () => {
      const largeFile = { file_id: 'big-1', file_size: 25 * 1024 * 1024 };
      const ctx = makeCtx({ message: { voice: largeFile } });

      await bot.handleFile(ctx, 'voice');

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('too large'));
      expect(mockPipeline.ingestFile).not.toHaveBeenCalled();
    });

    it('should call pipeline.ingestFile with { title } option', async () => {
      const voiceFile = { file_id: 'voice-1', file_size: 50000 };
      const ctx = makeCtx({ message: { voice: voiceFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.ogg');

      await bot.handleFile(ctx, 'voice');

      expect(mockPipeline.ingestFile).toHaveBeenCalledWith(
        '/tmp/test.ogg',
        { title: expect.stringContaining('Voice Note') }
      );
    });

    it('should clean up temp file in finally block', async () => {
      const voiceFile = { file_id: 'voice-1', file_size: 50000 };
      const ctx = makeCtx({ message: { voice: voiceFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.ogg');
      const cleanupSpy = vi.spyOn(bot, 'cleanup');

      await bot.handleFile(ctx, 'voice');

      expect(cleanupSpy).toHaveBeenCalledWith('/tmp/test.ogg');
    });

    it('should clean up temp file even on pipeline error', async () => {
      const voiceFile = { file_id: 'voice-1', file_size: 50000 };
      const ctx = makeCtx({ message: { voice: voiceFile } });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test.ogg');
      mockPipeline.ingestFile.mockRejectedValue(new Error('Pipeline error'));
      const cleanupSpy = vi.spyOn(bot, 'cleanup');

      await bot.handleFile(ctx, 'voice');

      expect(cleanupSpy).toHaveBeenCalledWith('/tmp/test.ogg');
    });

    it('should return early when fileObj is missing', async () => {
      const ctx = makeCtx({ message: {} });

      await bot.handleFile(ctx, 'voice');

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(mockPipeline.ingestFile).not.toHaveBeenCalled();
    });
  });

  describe('handleDocument()', () => {
    it('should reject non-media files with message', async () => {
      const ctx = makeCtx({
        message: { document: { file_name: 'report.pdf', file_size: 1000 } },
      });

      await bot.handleDocument(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unsupported file type'));
      expect(mockPipeline.ingestFile).not.toHaveBeenCalled();
    });

    it('should reject files > 20MB', async () => {
      const ctx = makeCtx({
        message: { document: { file_name: 'big.mp3', file_size: 25 * 1024 * 1024 } },
      });

      await bot.handleDocument(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('too large'));
    });

    it('should process valid media document through pipeline', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'interview.mp3', file_size: 5000 } },
      });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/interview.mp3');

      await bot.handleDocument(ctx);

      expect(mockPipeline.ingestFile).toHaveBeenCalledWith(
        '/tmp/interview.mp3',
        { title: 'interview' }
      );
    });

    it('should derive title from filename (strips extension)', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'my_podcast.m4a', file_size: 5000 } },
      });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/my_podcast.m4a');

      await bot.handleDocument(ctx);

      expect(mockPipeline.ingestFile).toHaveBeenCalledWith(
        expect.any(String),
        { title: 'my_podcast' }
      );
    });

    it('should reject document without filename (no extension match)', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_size: 5000 } },
      });

      await bot.handleDocument(ctx);

      // No file_name means the regex test on '' returns false
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unsupported'));
    });

    it('should clean up temp file in finally block', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'audio.mp3', file_size: 5000 } },
      });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/audio.mp3');
      const cleanupSpy = vi.spyOn(bot, 'cleanup');

      await bot.handleDocument(ctx);

      expect(cleanupSpy).toHaveBeenCalledWith('/tmp/audio.mp3');
    });

    it('should return early when document is null', async () => {
      const ctx = makeCtx({ message: { document: null } });

      await bot.handleDocument(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should pass document filename as originalName to downloadTelegramFile', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'episode.wav', file_size: 5000 } },
      });
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/episode.wav');

      await bot.handleDocument(ctx);

      expect(bot.downloadTelegramFile).toHaveBeenCalledWith(
        ctx, 'doc-1', 'document', 'episode.wav'
      );
    });
  });

  describe('cleanup()', () => {
    it('should delete existing temp file', () => {
      fs.existsSync.mockReturnValue(true);

      bot.cleanup('/tmp/test.ogg');

      expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/test.ogg');
    });

    it('should do nothing when filePath is null', () => {
      fs.unlinkSync.mockClear();

      bot.cleanup(null);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should not throw on errors', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => { throw new Error('EPERM'); });

      expect(() => bot.cleanup('/tmp/locked.ogg')).not.toThrow();
    });
  });

  describe('start()', () => {
    it('should call bot.launch()', async () => {
      await bot.start();

      expect(mockBotInst.launch).toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('should call bot.stop("shutdown")', () => {
      bot.stop();

      expect(mockBotInst.stop).toHaveBeenCalledWith('shutdown');
    });
  });

  // ─── Reply Chain Tests ──────────────────────────────────────────────────────

  describe('reply chain', () => {
    const TRACKED_MSG_ID = 999;
    const TRACKED_PAGE_ID = 'page-abc-123';

    beforeEach(() => {
      // Spy on shared CJS module object (vi.mock doesn't work for CJS in Vitest v3)
      vi.spyOn(ocr, 'ocrImage').mockResolvedValue('OCR extracted text from image');
      vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test-telegram/downloaded-file');
    });

    describe('trackSource()', () => {
      it('should store pageId and timestamp in pendingSources', () => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);

        const entry = bot.pendingSources.get(TRACKED_MSG_ID);
        expect(entry.pageId).toBe(TRACKED_PAGE_ID);
        expect(entry.timestamp).toBeTypeOf('number');
      });

      it('should overwrite if same messageId tracked again', () => {
        bot.trackSource(TRACKED_MSG_ID, 'old-page');
        bot.trackSource(TRACKED_MSG_ID, 'new-page');

        expect(bot.pendingSources.get(TRACKED_MSG_ID).pageId).toBe('new-page');
        expect(bot.pendingSources.size).toBe(1);
      });

      it('pendingSources should be empty initially', () => {
        expect(bot.pendingSources.size).toBe(0);
      });
    });

    describe('checkReplyChain()', () => {
      it('should return false when message has no reply_to_message', async () => {
        const ctx = makeCtx({ message: { text: 'hello' } });
        const result = await bot.checkReplyChain(ctx);
        expect(result).toBe(false);
      });

      it('should return false when reply_to_message is not tracked', async () => {
        const ctx = makeReplyCtx(777, { message: { text: 'my take' } });
        const result = await bot.checkReplyChain(ctx);
        expect(result).toBe(false);
      });

      it('should return true when reply_to_message is tracked', async () => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
        const ctx = makeReplyCtx(TRACKED_MSG_ID, { message: { text: 'my take' } });

        const result = await bot.checkReplyChain(ctx);
        expect(result).toBe(true);
      });

      it('should call handleReplyChain when reply is tracked', async () => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
        const spy = vi.spyOn(bot, 'handleReplyChain').mockResolvedValue();
        const ctx = makeReplyCtx(TRACKED_MSG_ID, { message: { text: 'my take' } });

        await bot.checkReplyChain(ctx);

        expect(spy).toHaveBeenCalledWith(ctx, TRACKED_MSG_ID);
      });

      it('should not call handleReplyChain when reply is not tracked', async () => {
        const spy = vi.spyOn(bot, 'handleReplyChain').mockResolvedValue();
        const ctx = makeReplyCtx(777, { message: { text: 'my take' } });

        await bot.checkReplyChain(ctx);

        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('handleReplyChain() with text reply', () => {
      beforeEach(() => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
      });

      it('should call notion.appendBlocks with divider + heading + paragraph blocks', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, { message: { text: 'This is my take on it' } });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockNotion.appendBlocks).toHaveBeenCalledWith(
          TRACKED_PAGE_ID,
          expect.arrayContaining([
            expect.objectContaining({ type: 'divider' }),
            expect.objectContaining({ type: 'heading_2' }),
            expect.objectContaining({ type: 'paragraph' }),
          ])
        );
      });

      it('should delete originalMessageId from pendingSources after success', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, { message: { text: 'my take' } });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(bot.pendingSources.has(TRACKED_MSG_ID)).toBe(false);
      });

      it('should edit status message to "Added your take"', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, { message: { text: 'my take' } });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
          ctx.chat.id, 1, null,
          'Added your take to the page.'
        );
      });

      it('should edit status with error message on failure', async () => {
        mockNotion.appendBlocks.mockRejectedValueOnce(new Error('Notion API down'));
        const ctx = makeReplyCtx(TRACKED_MSG_ID, { message: { text: 'my take' } });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
          ctx.chat.id, 1, null,
          'Failed to add take: Notion API down'
        );
      });
    });

    describe('handleReplyChain() with voice reply', () => {
      beforeEach(() => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
        mockPipeline.ingestFile.mockResolvedValue({ transcript: 'Voice transcription text' });
      });

      it('should call pipeline.ingestFile with skipNotion: true', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { voice: { file_id: 'voice-123', duration: 10 } },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockPipeline.ingestFile).toHaveBeenCalledWith(
          '/tmp/test-telegram/downloaded-file',
          expect.objectContaining({ skipNotion: true })
        );
      });

      it('should use transcription result as reply text', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { voice: { file_id: 'voice-123', duration: 10 } },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockNotion.splitText).toHaveBeenCalledWith('Voice transcription text', 1900);
      });

      it('should call notion.appendBlocks with transcript content', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { voice: { file_id: 'voice-123', duration: 10 } },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockNotion.appendBlocks).toHaveBeenCalledWith(
          TRACKED_PAGE_ID,
          expect.arrayContaining([
            expect.objectContaining({ type: 'paragraph' }),
          ])
        );
      });
    });

    describe('handleReplyChain() with photo reply', () => {
      beforeEach(() => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
      });

      it('should call ocrImage on downloaded photo', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: {
            photo: [
              { file_id: 'small', width: 100, height: 100 },
              { file_id: 'large', width: 800, height: 600 },
            ],
          },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(ocr.ocrImage).toHaveBeenCalledWith('/tmp/test-telegram/downloaded-file');
      });

      it('should attempt notion.uploadFile for the image', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: {
            photo: [{ file_id: 'large', width: 800, height: 600 }],
          },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockNotion.uploadFile).toHaveBeenCalled();
      });

      it('should include image block when upload succeeds', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: {
            photo: [{ file_id: 'large', width: 800, height: 600 }],
          },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        const blocks = mockNotion.appendBlocks.mock.calls[0][1];
        const imageBlock = blocks.find(b => b.type === 'image');
        expect(imageBlock).toBeDefined();
        expect(imageBlock.image.file_upload.id).toBe('upload-id');
      });

      it('should still append text blocks when image upload fails', async () => {
        mockNotion.uploadFile.mockRejectedValueOnce(new Error('upload failed'));
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: {
            photo: [{ file_id: 'large', width: 800, height: 600 }],
          },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockNotion.appendBlocks).toHaveBeenCalled();
        const blocks = mockNotion.appendBlocks.mock.calls[0][1];
        expect(blocks.find(b => b.type === 'paragraph')).toBeDefined();
        expect(blocks.find(b => b.type === 'image')).toBeUndefined();
      });
    });

    describe('handleReplyChain() edge cases', () => {
      beforeEach(() => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
      });

      it('should edit status to "Could not extract content" when reply text is empty', async () => {
        // A message with no text, no voice, no photo -> empty replyText
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { document: { file_id: 'doc-1' } },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
          ctx.chat.id, 1, null,
          'Could not extract content from your reply.'
        );
      });

      it('should not call appendBlocks when reply text is empty', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { document: { file_id: 'doc-1' } },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(mockNotion.appendBlocks).not.toHaveBeenCalled();
      });

      it('should call cleanup in finally block regardless of success/failure', async () => {
        mockNotion.appendBlocks.mockRejectedValueOnce(new Error('fail'));
        const cleanupSpy = vi.spyOn(bot, 'cleanup');
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { voice: { file_id: 'voice-1', duration: 5 } },
        });

        await bot.handleReplyChain(ctx, TRACKED_MSG_ID);

        expect(cleanupSpy).toHaveBeenCalled();
      });
    });

    describe('cleanup timer', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
        if (bot.cleanupInterval) clearInterval(bot.cleanupInterval);
      });

      it('should remove entries older than 30 minutes', () => {
        const now = Date.now();
        bot.pendingSources.set(1, { pageId: 'old', timestamp: now - 31 * 60 * 1000 });
        bot.pendingSources.set(2, { pageId: 'fresh', timestamp: now });

        bot.startCleanupTimer();
        vi.advanceTimersByTime(5 * 60 * 1000); // trigger cleanup

        expect(bot.pendingSources.has(1)).toBe(false);
        expect(bot.pendingSources.has(2)).toBe(true);
      });

      it('should keep entries younger than 30 minutes', () => {
        const now = Date.now();
        bot.pendingSources.set(1, { pageId: 'recent', timestamp: now - 10 * 60 * 1000 });

        bot.startCleanupTimer();
        vi.advanceTimersByTime(5 * 60 * 1000);

        expect(bot.pendingSources.has(1)).toBe(true);
      });
    });

    describe('handler integration with reply chain', () => {
      beforeEach(() => {
        bot.trackSource(TRACKED_MSG_ID, TRACKED_PAGE_ID);
      });

      it('handleText should return early when reply is to tracked message', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: { text: 'https://youtube.com/watch?v=test' },
        });

        await bot.handleText(ctx);

        // Should NOT process the URL since it's a reply chain
        expect(mockPipeline.ingest).not.toHaveBeenCalled();
        // Should have appended blocks to existing page instead
        expect(mockNotion.appendBlocks).toHaveBeenCalledWith(TRACKED_PAGE_ID, expect.any(Array));
      });

      it('handlePhoto should return early when reply is to tracked message', async () => {
        const ctx = makeReplyCtx(TRACKED_MSG_ID, {
          message: {
            photo: [{ file_id: 'photo-1', width: 800, height: 600 }],
          },
        });

        await bot.handlePhoto(ctx);

        // Should NOT create a new OCR page
        expect(mockNotion.createTranscriptPage).not.toHaveBeenCalled();
        // Should have appended to existing page
        expect(mockNotion.appendBlocks).toHaveBeenCalledWith(TRACKED_PAGE_ID, expect.any(Array));
      });
    });
  });

});
