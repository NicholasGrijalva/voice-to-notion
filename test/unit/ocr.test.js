/**
 * Tests for OCR module -- context parameter, prompt construction, error handling.
 */

const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ocrImage, MIME_TYPES } = require('../../src/ocr');

describe('OCR Module', () => {
  let mockModel;
  let mockGenAI;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    mockModel = {
      generateContent: vi.fn().mockResolvedValue({
        response: { text: () => '# Heading\nSome extracted text' },
      }),
    };

    vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel').mockReturnValue(mockModel);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake-image-data'));
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  // ─── Basic OCR ────────────────────────────────────────────────────────────

  it('should call Gemini with image data and prompt', async () => {
    await ocrImage('/tmp/test.jpg');

    expect(mockModel.generateContent).toHaveBeenCalledTimes(1);
    const args = mockModel.generateContent.mock.calls[0][0];
    expect(args).toHaveLength(2);
    expect(args[0].inlineData.mimeType).toBe('image/jpeg');
    expect(args[0].inlineData.data).toBeTruthy();
    expect(typeof args[1]).toBe('string');
  });

  it('should return trimmed text from Gemini response', async () => {
    mockModel.generateContent.mockResolvedValue({
      response: { text: () => '  Some text with whitespace  \n' },
    });

    const result = await ocrImage('/tmp/test.jpg');

    expect(result).toBe('Some text with whitespace');
  });

  it('should use correct MIME type based on file extension', async () => {
    await ocrImage('/tmp/test.png');

    const args = mockModel.generateContent.mock.calls[0][0];
    expect(args[0].inlineData.mimeType).toBe('image/png');
  });

  it('should default to image/jpeg for unknown extensions', async () => {
    await ocrImage('/tmp/test.bmp');

    const args = mockModel.generateContent.mock.calls[0][0];
    expect(args[0].inlineData.mimeType).toBe('image/jpeg');
  });

  // ─── Prompt Construction ──────────────────────────────────────────────────

  it('should include role adoption in base prompt', async () => {
    await ocrImage('/tmp/test.jpg');

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).toContain("world's greatest transcriber");
  });

  it('should instruct to preserve exact words and not add words', async () => {
    await ocrImage('/tmp/test.jpg');

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).toContain("Preserve the writer's exact words");
    expect(prompt).toContain('Do not add any words not in the image');
  });

  // ─── Context Parameter ────────────────────────────────────────────────────

  it('should NOT include context section when no context provided', async () => {
    await ocrImage('/tmp/test.jpg');

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).not.toContain('The user describes this image as');
  });

  it('should NOT include context section when context is null', async () => {
    await ocrImage('/tmp/test.jpg', { context: null });

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).not.toContain('The user describes this image as');
  });

  it('should append context to prompt when provided', async () => {
    await ocrImage('/tmp/test.jpg', { context: 'Meeting notes from standup' });

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).toContain('The user describes this image as: "Meeting notes from standup"');
  });

  it('should instruct to use context for disambiguation', async () => {
    await ocrImage('/tmp/test.jpg', { context: 'API design notes' });

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).toContain('resolve ambiguous handwriting');
    expect(prompt).toContain('domain-specific terms');
  });

  it('should instruct not to add info beyond the image even with context', async () => {
    await ocrImage('/tmp/test.jpg', { context: 'Some context' });

    const prompt = mockModel.generateContent.mock.calls[0][0][1];
    expect(prompt).toContain('do not add information beyond what is in the image');
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  it('should throw when GEMINI_API_KEY not set', async () => {
    delete process.env.GEMINI_API_KEY;

    await expect(ocrImage('/tmp/test.jpg')).rejects.toThrow('GEMINI_API_KEY not set');
  });

  it('should throw when OCR returns empty text', async () => {
    mockModel.generateContent.mockResolvedValue({
      response: { text: () => '' },
    });

    await expect(ocrImage('/tmp/test.jpg')).rejects.toThrow('OCR returned empty text');
  });

  it('should throw when OCR returns whitespace-only text', async () => {
    mockModel.generateContent.mockResolvedValue({
      response: { text: () => '   \n  ' },
    });

    await expect(ocrImage('/tmp/test.jpg')).rejects.toThrow('OCR returned empty text');
  });

  // ─── MIME_TYPES export ────────────────────────────────────────────────────

  it('should export MIME_TYPES mapping', () => {
    expect(MIME_TYPES['.jpg']).toBe('image/jpeg');
    expect(MIME_TYPES['.png']).toBe('image/png');
    expect(MIME_TYPES['.webp']).toBe('image/webp');
    expect(MIME_TYPES['.heic']).toBe('image/heic');
  });
});
