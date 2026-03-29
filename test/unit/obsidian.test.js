const axios = require('axios');
const fs = require('fs');
const ObsidianClient = require('../../src/obsidian');

describe('ObsidianClient', () => {
  let client;
  let mockAxiosInstance;

  beforeEach(() => {
    mockAxiosInstance = {
      put: vi.fn().mockResolvedValue({ status: 204 }),
      get: vi.fn().mockResolvedValue({ status: 200, data: {} }),
      patch: vi.fn().mockResolvedValue({ status: 200 }),
    };
    vi.spyOn(axios, 'create').mockReturnValue(mockAxiosInstance);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake audio data'));

    client = new ObsidianClient('test-key', null, { port: 27124, captureFolder: '01_Capture' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('uploadFile()', () => {
    it('should PUT binary data to vault attachments folder', async () => {
      const result = await client.uploadFile('/tmp/audio.mp3', 'recording.mp3', 'audio/mpeg');

      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        '/vault/01_Capture/attachments/recording.mp3',
        expect.any(Buffer),
        expect.objectContaining({
          headers: { 'Content-Type': 'audio/mpeg' },
        })
      );
      expect(result).toBe('01_Capture/attachments/recording.mp3');
    });

    it('should return null on upload failure', async () => {
      mockAxiosInstance.put.mockRejectedValue(new Error('network error'));

      const result = await client.uploadFile('/tmp/audio.mp3', 'test.mp3', 'audio/mpeg');

      expect(result).toBeNull();
    });

    it('should use application/octet-stream when no content type given', async () => {
      await client.uploadFile('/tmp/audio.mp3', 'test.mp3', null);

      const putCall = mockAxiosInstance.put.mock.calls[0];
      expect(putCall[2].headers['Content-Type']).toBe('application/octet-stream');
    });
  });

  describe('createTranscriptPage()', () => {
    it('should create note in capture folder', async () => {
      const result = await client.createTranscriptPage({
        title: 'Test Note',
        transcript: 'Hello world',
        source: 'Audio',
      });

      expect(mockAxiosInstance.put).toHaveBeenCalled();
      const putPath = mockAxiosInstance.put.mock.calls[0][0];
      expect(putPath).toContain('01_Capture');
      expect(result).toContain('Test Note');
    });

    it('should embed audio wikilink when audioFileUploadId provided', async () => {
      await client.createTranscriptPage({
        title: 'Voice Memo',
        transcript: 'Hello world',
        audioFileUploadId: '01_Capture/attachments/audio.mp3',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toContain('![[audio.mp3]]');
    });

    it('should not include audio embed when no audioFileUploadId', async () => {
      await client.createTranscriptPage({
        title: 'Voice Memo',
        transcript: 'Hello world',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).not.toContain('![[');
    });

    it('should include transcript in note body', async () => {
      await client.createTranscriptPage({
        title: 'Test',
        transcript: 'The quick brown fox',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toContain('The quick brown fox');
    });

    it('should include YAML frontmatter', async () => {
      await client.createTranscriptPage({
        title: 'Test',
        transcript: 'content',
        source: 'YouTube',
        metadata: { url: 'https://youtube.com/test' },
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toMatch(/^---\n/);
      expect(body).toContain('type: "youtube"');
    });
  });

  // ─── createTranscriptPage - image embedding ──────────────────────────────

  describe('createTranscriptPage() - image embedding', () => {
    it('should embed image wikilink when imageFileUploadId provided', async () => {
      await client.createTranscriptPage({
        title: 'Photo Note',
        transcript: 'OCR text',
        source: 'Idea',
        imageFileUploadId: '01_Capture/attachments/photo-123.jpg',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toContain('![[photo-123.jpg]]');
    });

    it('should NOT include image embed when imageFileUploadId is null', async () => {
      await client.createTranscriptPage({
        title: 'Photo Note',
        transcript: 'OCR text',
        imageFileUploadId: null,
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      // Only check there's no image-style embed (audio may still not be there)
      expect(body).not.toContain('![[photo');
    });

    it('should embed both audio and image when both provided', async () => {
      await client.createTranscriptPage({
        title: 'Mixed',
        transcript: 'Content',
        audioFileUploadId: '01_Capture/attachments/recording.mp3',
        imageFileUploadId: '01_Capture/attachments/photo.jpg',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toContain('![[recording.mp3]]');
      expect(body).toContain('![[photo.jpg]]');
    });

    it('should place image embed before transcript', async () => {
      await client.createTranscriptPage({
        title: 'Test',
        transcript: 'Transcript text here',
        imageFileUploadId: '01_Capture/attachments/img.png',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      const imagePos = body.indexOf('![[img.png]]');
      const transcriptPos = body.indexOf('Transcript text here');
      expect(imagePos).toBeLessThan(transcriptPos);
    });
  });

  // ─── createStructuredPage - image and audio embedding ─────────────────────

  describe('createStructuredPage() - media embedding', () => {
    it('should embed image wikilink when imageFileUploadId provided', async () => {
      await client.createStructuredPage({
        title: 'Structured Note',
        content: 'Full content',
        imageFileUploadId: '01_Capture/attachments/photo.png',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toContain('![[photo.png]]');
    });

    it('should embed audio wikilink when audioFileUploadId provided', async () => {
      await client.createStructuredPage({
        title: 'Structured Note',
        content: 'Full content',
        audioFileUploadId: '01_Capture/attachments/audio.mp3',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).toContain('![[audio.mp3]]');
    });

    it('should place embeds before Summary section', async () => {
      await client.createStructuredPage({
        title: 'Test',
        content: 'Content',
        summary: { summary: 'A summary', keyPoints: ['Point 1'] },
        imageFileUploadId: '01_Capture/attachments/img.jpg',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      const imagePos = body.indexOf('![[img.jpg]]');
      const summaryPos = body.indexOf('## Summary');
      expect(imagePos).toBeLessThan(summaryPos);
    });

    it('should NOT include embeds when no file IDs provided', async () => {
      await client.createStructuredPage({
        title: 'Test',
        content: 'Content',
      });

      const body = mockAxiosInstance.put.mock.calls[0][1];
      expect(body).not.toMatch(/!\[\[.*\]\]/);
    });
  });

  // ─── appendBlocks - image block handling ──────────────────────────────────

  describe('appendBlocks() - image blocks', () => {
    beforeEach(() => {
      mockAxiosInstance.get.mockResolvedValue({ data: '# Existing Note\nOriginal content' });
    });

    it('should convert image blocks to wikilink embeds', async () => {
      await client.appendBlocks('01_Capture/Test.md', [
        {
          type: 'image',
          image: { type: 'file_upload', file_upload: { id: '01_Capture/attachments/reply-photo.jpg' } },
        },
      ]);

      const newContent = mockAxiosInstance.put.mock.calls[0][1];
      expect(newContent).toContain('![[reply-photo.jpg]]');
    });

    it('should extract basename from image file_upload.id', async () => {
      await client.appendBlocks('01_Capture/Test.md', [
        {
          type: 'image',
          image: { type: 'file_upload', file_upload: { id: 'deep/path/to/image.png' } },
        },
      ]);

      const newContent = mockAxiosInstance.put.mock.calls[0][1];
      expect(newContent).toContain('![[image.png]]');
    });

    it('should skip image blocks with null upload ID', async () => {
      await client.appendBlocks('01_Capture/Test.md', [
        { type: 'image', image: { type: 'file_upload', file_upload: { id: null } } },
      ]);

      const newContent = mockAxiosInstance.put.mock.calls[0][1];
      expect(newContent).not.toMatch(/!\[\[.*\]\]/);
    });

    it('should handle mixed block types including images', async () => {
      await client.appendBlocks('01_Capture/Test.md', [
        { type: 'divider', divider: {} },
        { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Continuation' } }] } },
        { type: 'image', image: { type: 'file_upload', file_upload: { id: 'attachments/photo.jpg' } } },
        { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'OCR text' } }] } },
      ]);

      const newContent = mockAxiosInstance.put.mock.calls[0][1];
      expect(newContent).toContain('---');
      expect(newContent).toContain('## Continuation');
      expect(newContent).toContain('![[photo.jpg]]');
      expect(newContent).toContain('OCR text');
    });
  });

  describe('testConnection()', () => {
    it('should return true on successful connection', async () => {
      mockAxiosInstance.get.mockResolvedValue({ status: 200 });

      const result = await client.testConnection();
      expect(result).toBe(true);
    });

    it('should return false on connection failure', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });
});
