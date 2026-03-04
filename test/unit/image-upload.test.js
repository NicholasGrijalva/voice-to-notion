/**
 * Tests for image upload feature: OCR pages now embed the original image
 * in Notion alongside the transcription text.
 *
 * Separate file to avoid vi.restoreAllMocks() interaction in telegram-bot.test.js.
 */

const fs = require('fs');
const path = require('path');

const ocr = require('../../src/ocr');
const TelegramBot = require('../../src/telegram-bot');

describe('Image Upload Feature', () => {
  let bot;
  let mockNotion;
  let mockPipeline;

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
        getFileLink: vi.fn().mockResolvedValue({ href: 'https://api.telegram.org/file/bot123/photo.jpg' }),
        ...overrides.telegram,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue({
      on: vi.fn((event, cb) => { if (event === 'finish') setTimeout(cb, 0); }),
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1024 });
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

    mockPipeline = {
      ingest: vi.fn().mockResolvedValue({ title: 'Test', notionUrl: 'https://notion.so/x', pageId: 'p1' }),
      ingestFile: vi.fn().mockResolvedValue({ title: 'Test', notionUrl: 'https://notion.so/x', pageId: 'p1' }),
    };

    mockNotion = {
      uploadFile: vi.fn().mockResolvedValue('img-upload-123'),
      createTranscriptPage: vi.fn().mockResolvedValue('page-abc-123'),
      splitText: vi.fn(text => [text]),
      appendBlocks: vi.fn().mockResolvedValue({}),
    };

    process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
    delete process.env.TELEGRAM_ALLOWED_USERS;

    bot = new TelegramBot({
      pipeline: mockPipeline,
      notionClient: mockNotion,
      tempDir: '/tmp/test-telegram',
    });

    vi.spyOn(bot, 'downloadTelegramFile').mockResolvedValue('/tmp/test-telegram/tg-123.jpg');
    vi.spyOn(ocr, 'ocrImage').mockResolvedValue('# Test Heading\nSome OCR text content');
  });

  // ─── getImageMimeType ────────────────────────────────────────────────────

  describe('getImageMimeType()', () => {
    it('should return image/jpeg for .jpg', () => {
      expect(bot.getImageMimeType('/tmp/photo.jpg')).toBe('image/jpeg');
    });

    it('should return image/png for .png', () => {
      expect(bot.getImageMimeType('/tmp/photo.png')).toBe('image/png');
    });

    it('should return image/webp for .webp', () => {
      expect(bot.getImageMimeType('/tmp/photo.webp')).toBe('image/webp');
    });

    it('should return image/heic for .heic', () => {
      expect(bot.getImageMimeType('/tmp/photo.heic')).toBe('image/heic');
    });

    it('should fall back to image/jpeg for unknown extension', () => {
      expect(bot.getImageMimeType('/tmp/photo.bmp')).toBe('image/jpeg');
    });

    it('should be case-insensitive', () => {
      expect(bot.getImageMimeType('/tmp/photo.JPG')).toBe('image/jpeg');
      expect(bot.getImageMimeType('/tmp/photo.PNG')).toBe('image/png');
    });
  });

  // ─── handlePhoto ─────────────────────────────────────────────────────────

  describe('handlePhoto()', () => {
    it('should upload image to Notion before creating page', async () => {
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 100 }, { file_id: 'p2', width: 800 }] },
      });

      await bot.handlePhoto(ctx);

      expect(mockNotion.uploadFile).toHaveBeenCalledWith(
        '/tmp/test-telegram/tg-123.jpg',
        expect.stringMatching(/^photo-\d+\.jpg$/),
        'image/jpeg'
      );
    });

    it('should pass imageFileUploadId to createTranscriptPage', async () => {
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800 }] },
      });

      await bot.handlePhoto(ctx);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({
          imageFileUploadId: 'img-upload-123',
          source: 'Idea',
        })
      );
    });

    it('should use OCR first line as title', async () => {
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800 }] },
      });

      await bot.handlePhoto(ctx);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Heading' })
      );
    });

    it('should pass null imageFileUploadId when upload fails', async () => {
      mockNotion.uploadFile.mockRejectedValue(new Error('Upload failed'));
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800 }] },
      });

      await bot.handlePhoto(ctx);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ imageFileUploadId: null })
      );
    });

    it('should show "Done (image upload failed)" when upload fails', async () => {
      mockNotion.uploadFile.mockRejectedValue(new Error('Upload failed'));
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800 }] },
      });

      await bot.handlePhoto(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        expect.stringContaining('Done (image upload failed)')
      );
    });

    it('should show "Done:" when upload succeeds', async () => {
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800 }] },
      });

      await bot.handlePhoto(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        expect.stringMatching(/^Done: Test Heading/)
      );
    });

    it('should reject images > 20MB', async () => {
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800, file_size: 25 * 1024 * 1024 }] },
      });

      await bot.handlePhoto(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Image too large (>20MB).');
      expect(ocr.ocrImage).not.toHaveBeenCalled();
    });

    it('should clean up temp file after processing', async () => {
      const ctx = makeCtx({
        message: { photo: [{ file_id: 'p1', width: 800 }] },
      });
      const cleanupSpy = vi.spyOn(bot, 'cleanup');

      await bot.handlePhoto(ctx);

      expect(cleanupSpy).toHaveBeenCalledWith('/tmp/test-telegram/tg-123.jpg');
    });

    it('should track source for reply chain', async () => {
      const ctx = makeCtx({
        message: {
          message_id: 42,
          photo: [{ file_id: 'p1', width: 800 }],
        },
      });

      await bot.handlePhoto(ctx);

      expect(bot.pendingSources.has(42)).toBe(true);
      expect(bot.pendingSources.get(42).pageId).toBe('page-abc-123');
    });
  });

  // ─── handleDocument (image branch) ────────────────────────────────────────

  describe('handleDocument() - image branch', () => {
    beforeEach(() => {
      bot.downloadTelegramFile.mockResolvedValue('/tmp/test-telegram/tg-123.png');
      ocr.ocrImage.mockResolvedValue('# Doc Image\nExtracted text');
    });

    it('should upload image document to Notion using doc.file_name', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'screenshot.png', file_size: 5000 } },
      });

      await bot.handleDocument(ctx);

      expect(mockNotion.uploadFile).toHaveBeenCalledWith(
        '/tmp/test-telegram/tg-123.png',
        'screenshot.png',
        'image/png'
      );
    });

    it('should pass imageFileUploadId to createTranscriptPage', async () => {
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'photo.jpg', file_size: 5000 } },
      });

      await bot.handleDocument(ctx);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({
          imageFileUploadId: 'img-upload-123',
          sourceFilename: 'photo.jpg',
        })
      );
    });

    it('should show "Done (image upload failed)" when upload fails', async () => {
      mockNotion.uploadFile.mockRejectedValue(new Error('API error'));
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'notes.jpg', file_size: 5000 } },
      });

      await bot.handleDocument(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        expect.stringContaining('Done (image upload failed)')
      );
    });

    it('should still create page with null imageFileUploadId when upload fails', async () => {
      mockNotion.uploadFile.mockRejectedValue(new Error('API error'));
      const ctx = makeCtx({
        message: { document: { file_id: 'doc-1', file_name: 'notes.jpg', file_size: 5000 } },
      });

      await bot.handleDocument(ctx);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ imageFileUploadId: null })
      );
    });
  });

  // ─── handleReplyChain (photo reply) ───────────────────────────────────────

  describe('handleReplyChain() - photo reply', () => {
    beforeEach(() => {
      bot.downloadTelegramFile.mockResolvedValue('/tmp/test-telegram/tg-reply.jpg');
      ocr.ocrImage.mockResolvedValue('Reply OCR text');
      bot.pendingSources.set(100, { pageId: 'page-original', timestamp: Date.now() });
    });

    it('should upload reply photo to Notion', async () => {
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });

      await bot.handleReplyChain(ctx, 100);

      expect(mockNotion.uploadFile).toHaveBeenCalledWith(
        '/tmp/test-telegram/tg-reply.jpg',
        expect.stringMatching(/^reply-photo-\d+\.jpg$/),
        'image/jpeg'
      );
    });

    it('should include image block in appended blocks when upload succeeds', async () => {
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });

      await bot.handleReplyChain(ctx, 100);

      const blocks = mockNotion.appendBlocks.mock.calls[0][1];
      const imageBlocks = blocks.filter(b => b.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0].image.file_upload.id).toBe('img-upload-123');
    });

    it('should order reply blocks as divider, heading, image, paragraphs', async () => {
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });

      await bot.handleReplyChain(ctx, 100);

      const blocks = mockNotion.appendBlocks.mock.calls[0][1];
      const types = blocks.map(b => b.type);
      expect(types).toEqual(['divider', 'heading_2', 'image', 'paragraph']);
    });

    it('should not include image block when upload fails', async () => {
      mockNotion.uploadFile.mockRejectedValue(new Error('Upload failed'));
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });

      await bot.handleReplyChain(ctx, 100);

      const blocks = mockNotion.appendBlocks.mock.calls[0][1];
      const imageBlocks = blocks.filter(b => b.type === 'image');
      expect(imageBlocks).toHaveLength(0);
    });

    it('should show "(image upload failed)" when reply photo upload fails', async () => {
      mockNotion.uploadFile.mockRejectedValue(new Error('Upload failed'));
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });

      await bot.handleReplyChain(ctx, 100);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        'Added your take to the page (image upload failed).'
      );
    });

    it('should show success message when reply photo upload succeeds', async () => {
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });

      await bot.handleReplyChain(ctx, 100);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        456, 1, null,
        'Added your take to the page.'
      );
    });

    it('should clean up temp file after reply processing', async () => {
      const ctx = makeCtx({
        message: {
          reply_to_message: { message_id: 100 },
          photo: [{ file_id: 'rp1', width: 800 }],
        },
      });
      const cleanupSpy = vi.spyOn(bot, 'cleanup');

      await bot.handleReplyChain(ctx, 100);

      expect(cleanupSpy).toHaveBeenCalledWith('/tmp/test-telegram/tg-reply.jpg');
    });
  });
});
