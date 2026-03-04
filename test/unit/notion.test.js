
const fs = require('fs');
const axios = require('axios');

// Mock form-data with factory since it's a constructor (new FormData())
vi.mock('form-data', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      append: vi.fn(),
      getHeaders: vi.fn(() => ({ 'content-type': 'multipart/form-data' })),
    })),
  };
});

const FormData = require('form-data');
const NotionClient = require('../../src/notion');

describe('NotionClient', () => {
  let notion;
  let mockClient;

  beforeEach(() => {
    vi.clearAllMocks();

    // Spy-based mocking for CJS modules
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
    };

    vi.spyOn(axios, 'create').mockReturnValue(mockClient);
    vi.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 5 * 1024 * 1024 });
    vi.spyOn(fs, 'createReadStream').mockReturnValue('mock-stream');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.alloc(10 * 1024 * 1024));

    notion = new NotionClient('secret_test_key', 'db-123-456');
  });

  describe('constructor', () => {
    it('should create axios client with correct headers', () => {
      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.notion.com/v1',
          headers: expect.objectContaining({
            'Authorization': 'Bearer secret_test_key',
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should store databaseId', () => {
      expect(notion.databaseId).toBe('db-123-456');
    });
  });

  describe('uploadFile()', () => {
    it('should create file upload object via POST /file_uploads', async () => {
      fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 }); // 5MB

      mockClient.post.mockResolvedValue({
        data: { id: 'upload-1', upload_url: 'https://upload.example.com' },
      });

      await notion.uploadFile('/path/to/audio.mp3', 'audio.mp3', 'audio/mpeg');

      expect(mockClient.post).toHaveBeenCalledWith(
        '/file_uploads',
        expect.objectContaining({ filename: 'audio.mp3', content_type: 'audio/mpeg' })
      );
    });

    it('should use single-part upload for files under 20MB', async () => {
      fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024 }); // 10MB

      mockClient.post.mockResolvedValue({
        data: { id: 'upload-1', upload_url: 'https://upload.example.com' },
      });

      await notion.uploadFile('/path/to/audio.mp3', 'audio.mp3');

      // Should NOT include mode: 'multi_part'
      const createCall = mockClient.post.mock.calls[0];
      expect(createCall[1]).not.toHaveProperty('mode');
    });

    it('should use multi-part upload for files over 20MB', async () => {
      fs.statSync.mockReturnValue({ size: 25 * 1024 * 1024 }); // 25MB

      mockClient.post.mockResolvedValueOnce({
        data: {
          id: 'upload-1',
          upload_url: 'https://upload.example.com',
        },
      });
      mockClient.post.mockResolvedValue({ data: {} }); // complete

      fs.readFileSync.mockReturnValue(Buffer.alloc(25 * 1024 * 1024));

      await notion.uploadFile('/path/to/large.mp3', 'large.mp3');

      const createCall = mockClient.post.mock.calls[0];
      expect(createCall[1]).toHaveProperty('mode', 'multi_part');
    });

    it('should return file upload ID', async () => {
      fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 });

      mockClient.post.mockResolvedValue({
        data: { id: 'upload-xyz', upload_url: 'https://upload.example.com' },
      });

      const id = await notion.uploadFile('/path/to/audio.mp3', 'audio.mp3');
      expect(id).toBe('upload-xyz');
    });

    it('should rethrow errors from API', async () => {
      fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 });
      mockClient.post.mockRejectedValue(new Error('API error'));

      await expect(notion.uploadFile('/path/to/audio.mp3', 'audio.mp3'))
        .rejects.toThrow('API error');
    });
  });

  describe('createTranscriptPage()', () => {
    beforeEach(() => {
      mockClient.post.mockResolvedValue({
        data: { id: 'page-abc-123' },
      });
    });

    it('should POST to /pages with correct parent database_id', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'Hello world',
      });

      expect(mockClient.post).toHaveBeenCalledWith(
        '/pages',
        expect.objectContaining({
          parent: { type: 'database_id', database_id: 'db-123-456' },
        })
      );
    });

    it('should set Title property truncated to 2000 chars', async () => {
      const longTitle = 'a'.repeat(3000);
      await notion.createTranscriptPage({ title: longTitle, transcript: 'text' });

      const call = mockClient.post.mock.calls[0];
      const titleContent = call[1].properties['Title'].title[0].text.content;
      expect(titleContent.length).toBe(2000);
    });

    it('should set Status to "New"', async () => {
      await notion.createTranscriptPage({ title: 'Test', transcript: 'text' });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Status'].select.name).toBe('New');
    });

    it('should set Date Added to ISO timestamp', async () => {
      await notion.createTranscriptPage({ title: 'Test', transcript: 'text' });

      const call = mockClient.post.mock.calls[0];
      const dateStr = call[1].properties['Date Added'].date.start;
      expect(new Date(dateStr).toISOString()).toBe(dateStr);
    });

    it('should set Type to provided source value', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        source: 'Video',
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Type'].select.name).toBe('Video');
    });

    it('should not include Transcript in page properties', async () => {
      await notion.createTranscriptPage({ title: 'Test', transcript: 'some text' });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Transcript']).toBeUndefined();
    });

    it('should set Source Filename when provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        sourceFilename: 'recording.mp3',
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Source Filename'].rich_text[0].text.content).toBe('recording.mp3');
    });

    it('should not set Source Filename when null', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        sourceFilename: null,
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Source Filename']).toBeUndefined();
    });

    it('should set Source property when sourceRef provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        sourceRef: '/recordings/audio.mp3',
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Source'].rich_text[0].text.content).toBe('/recordings/audio.mp3');
    });

    it('should not set Source property when sourceRef is null', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        sourceRef: null,
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Source']).toBeUndefined();
    });

    it('should set Processing Time when metadata.processingTime provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        metadata: { processingTime: 45 },
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['Processing Time (s)'].number).toBe(45);
    });

    it('should set URL when metadata.url provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        metadata: { url: 'https://example.com' },
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].properties['URL'].url).toBe('https://example.com');
    });

    it('should split transcript into paragraph blocks of max 1900 chars', async () => {
      const longTranscript = 'word '.repeat(500); // ~2500 chars
      await notion.createTranscriptPage({ title: 'Test', transcript: longTranscript });

      const call = mockClient.post.mock.calls[0];
      const paragraphs = call[1].children.filter(b => b.type === 'paragraph');
      expect(paragraphs.length).toBeGreaterThan(1);

      for (const p of paragraphs) {
        expect(p.paragraph.rich_text[0].text.content.length).toBeLessThanOrEqual(1900);
      }
    });

    it('should prepend audio block when audioFileUploadId provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        audioFileUploadId: 'upload-123',
      });

      const call = mockClient.post.mock.calls[0];
      const audioBlocks = call[1].children.filter(b => b.type === 'audio');
      expect(audioBlocks).toHaveLength(1);
      expect(audioBlocks[0].audio.file_upload.id).toBe('upload-123');
    });

    it('should not include audio block when audioFileUploadId is null', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        audioFileUploadId: null,
      });

      const call = mockClient.post.mock.calls[0];
      const audioBlocks = call[1].children.filter(b => b.type === 'audio');
      expect(audioBlocks).toHaveLength(0);
    });

    it('should prepend image block when imageFileUploadId provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        imageFileUploadId: 'img-upload-123',
      });

      const call = mockClient.post.mock.calls[0];
      const imageBlocks = call[1].children.filter(b => b.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0].image.file_upload.id).toBe('img-upload-123');
    });

    it('should prepend heading_2 with title when imageFileUploadId provided', async () => {
      await notion.createTranscriptPage({
        title: 'Shopping List',
        transcript: 'text',
        imageFileUploadId: 'img-upload-123',
      });

      const call = mockClient.post.mock.calls[0];
      const headings = call[1].children.filter(b => b.type === 'heading_2');
      expect(headings).toHaveLength(1);
      expect(headings[0].heading_2.rich_text[0].text.content).toBe('Shopping List');
    });

    it('should order children as heading_2, image, paragraphs when imageFileUploadId provided', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'OCR text',
        imageFileUploadId: 'img-upload-123',
      });

      const call = mockClient.post.mock.calls[0];
      const types = call[1].children.map(b => b.type);
      expect(types[0]).toBe('heading_2');
      expect(types[1]).toBe('image');
      expect(types[2]).toBe('paragraph');
    });

    it('should not include image or heading_2 blocks when imageFileUploadId is null', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        imageFileUploadId: null,
      });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].children.filter(b => b.type === 'image')).toHaveLength(0);
      expect(call[1].children.filter(b => b.type === 'heading_2')).toHaveLength(0);
    });

    it('should truncate image heading title to 2000 chars', async () => {
      const longTitle = 'a'.repeat(3000);
      await notion.createTranscriptPage({
        title: longTitle,
        transcript: 'text',
        imageFileUploadId: 'img-upload-123',
      });

      const call = mockClient.post.mock.calls[0];
      const heading = call[1].children.find(b => b.type === 'heading_2');
      expect(heading.heading_2.rich_text[0].text.content.length).toBe(2000);
    });

    it('should prepend callout block with metadata', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        metadata: { duration: 120, language: 'en' },
      });

      const call = mockClient.post.mock.calls[0];
      const callouts = call[1].children.filter(b => b.type === 'callout');
      expect(callouts).toHaveLength(1);
      expect(callouts[0].callout.rich_text[0].text.content).toContain('Duration:');
      expect(callouts[0].callout.rich_text[0].text.content).toContain('Language: en');
    });

    it('should not include callout when neither duration nor language', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
        metadata: {},
      });

      const call = mockClient.post.mock.calls[0];
      const callouts = call[1].children.filter(b => b.type === 'callout');
      expect(callouts).toHaveLength(0);
    });

    it('should limit children to 100 blocks per initial request', async () => {
      // Create a transcript that will generate >100 blocks
      const longTranscript = ('x'.repeat(1800) + '. ').repeat(110);

      mockClient.patch.mockResolvedValue({ data: {} });

      await notion.createTranscriptPage({ title: 'Test', transcript: longTranscript });

      const call = mockClient.post.mock.calls[0];
      expect(call[1].children.length).toBeLessThanOrEqual(100);
    });

    it('should call appendBlocks for overflow blocks beyond 100', async () => {
      const longTranscript = ('x'.repeat(1800) + '. ').repeat(110);

      mockClient.patch.mockResolvedValue({ data: {} });

      await notion.createTranscriptPage({ title: 'Test', transcript: longTranscript });

      // appendBlocks should have been called for overflow
      expect(mockClient.patch).toHaveBeenCalled();
    });

    it('should coerce non-string transcript to string', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: 12345,
      });

      const call = mockClient.post.mock.calls[0];
      const paragraphs = call[1].children.filter(b => b.type === 'paragraph');
      expect(typeof paragraphs[0].paragraph.rich_text[0].text.content).toBe('string');
    });

    it('should handle null transcript gracefully', async () => {
      await notion.createTranscriptPage({
        title: 'Test',
        transcript: null,
      });

      const call = mockClient.post.mock.calls[0];
      // Transcript goes into body blocks, not properties - Transcript property should not exist
      expect(call[1].properties['Transcript']).toBeUndefined();
      // Should still produce at least one paragraph block (empty string)
      const paragraphs = call[1].children.filter(b => b.type === 'paragraph');
      expect(paragraphs.length).toBeGreaterThanOrEqual(1);
    });

    it('should return page ID from response', async () => {
      const pageId = await notion.createTranscriptPage({
        title: 'Test',
        transcript: 'text',
      });

      expect(pageId).toBe('page-abc-123');
    });
  });

  describe('appendBlocks()', () => {
    it('should PATCH /blocks/{pageId}/children', async () => {
      mockClient.patch.mockResolvedValue({ data: {} });

      const blocks = [{ type: 'paragraph', paragraph: { rich_text: [] } }];
      await notion.appendBlocks('page-1', blocks);

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/blocks/page-1/children',
        { children: blocks }
      );
    });

    it('should batch blocks in groups of 100', async () => {
      mockClient.patch.mockResolvedValue({ data: {} });

      const blocks = Array.from({ length: 250 }, (_, i) => ({
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: `Block ${i}` } }] },
      }));

      await notion.appendBlocks('page-1', blocks);

      expect(mockClient.patch).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    });
  });

  describe('splitText() - pure logic', () => {
    it('should return [""] for empty input', () => {
      expect(notion.splitText('')).toEqual(['']);
      expect(notion.splitText(null)).toEqual(['']);
    });

    it('should return text as-is when under maxLength', () => {
      const text = 'Short text';
      expect(notion.splitText(text, 1900)).toEqual(['Short text']);
    });

    it('should split at sentence boundary', () => {
      const text = 'First sentence. Second sentence. Third sentence.';
      const chunks = notion.splitText(text, 20);

      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be valid
      chunks.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(20);
      });
    });

    it('should split at newline when no sentence boundary', () => {
      const text = 'word'.repeat(30) + '\n' + 'more'.repeat(10);
      const chunks = notion.splitText(text, 50);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should split at space when no newline', () => {
      const text = 'word word word word word word word word word word word word';
      const chunks = notion.splitText(text, 20);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should hard-split when no space found', () => {
      const text = 'a'.repeat(100);
      const chunks = notion.splitText(text, 20);

      expect(chunks.length).toBe(5);
      chunks.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(21); // +1 for trim behavior
      });
    });

    it('should handle text that is exactly maxLength', () => {
      const text = 'a'.repeat(50);
      const chunks = notion.splitText(text, 50);

      expect(chunks).toEqual([text]);
    });
  });

  describe('formatDuration() - pure logic', () => {
    it('should return "" for null/undefined/0', () => {
      expect(notion.formatDuration(null)).toBe('');
      expect(notion.formatDuration(undefined)).toBe('');
      expect(notion.formatDuration(0)).toBe('');
    });

    it('should format as "Xm Xs" for durations under 1 hour', () => {
      expect(notion.formatDuration(125)).toBe('2m 5s');
    });

    it('should format as "Xh Xm Xs" for durations over 1 hour', () => {
      expect(notion.formatDuration(3725)).toBe('1h 2m 5s');
    });

    it('should handle exact minute boundaries', () => {
      expect(notion.formatDuration(60)).toBe('1m 0s');
      expect(notion.formatDuration(120)).toBe('2m 0s');
    });

    it('should floor seconds and minutes', () => {
      expect(notion.formatDuration(65.7)).toBe('1m 5s');
    });
  });

  describe('ensureTypeOptions()', () => {
    it('should GET database schema', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          properties: {
            'Type': {
              type: 'select',
              select: {
                options: [
                  { name: 'Audio', color: 'purple' },
                  { name: 'Video', color: 'orange' },
                  { name: 'YouTube', color: 'red' },
                ],
              },
            },
            'Source': { type: 'rich_text' },
          },
        },
      });

      await notion.ensureTypeOptions();

      expect(mockClient.get).toHaveBeenCalledWith('/databases/db-123-456');
    });

    it('should PATCH to add missing type options and Source property', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          properties: {
            'Type': {
              type: 'select',
              select: { options: [{ name: 'Idea', color: 'blue' }] },
            },
          },
        },
      });
      mockClient.patch.mockResolvedValue({ data: {} });

      await notion.ensureTypeOptions();

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/databases/db-123-456',
        expect.objectContaining({
          properties: expect.objectContaining({
            'Type': {
              select: {
                options: expect.arrayContaining([
                  expect.objectContaining({ name: 'Audio' }),
                  expect.objectContaining({ name: 'Video' }),
                  expect.objectContaining({ name: 'YouTube' }),
                  expect.objectContaining({ name: 'Idea' }),
                ]),
              },
            },
            'Source': { rich_text: {} },
          }),
        })
      );
    });

    it('should not PATCH when all options exist and Source property present', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          properties: {
            'Type': {
              type: 'select',
              select: {
                options: [
                  { name: 'Audio', color: 'purple' },
                  { name: 'Video', color: 'orange' },
                  { name: 'YouTube', color: 'red' },
                ],
              },
            },
            'Source': { type: 'rich_text' },
          },
        },
      });

      await notion.ensureTypeOptions();

      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should PATCH to create Source property even when type options exist', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          properties: {
            'Type': {
              type: 'select',
              select: {
                options: [
                  { name: 'Audio', color: 'purple' },
                  { name: 'Video', color: 'orange' },
                  { name: 'YouTube', color: 'red' },
                ],
              },
            },
            // No 'Source' property
          },
        },
      });
      mockClient.patch.mockResolvedValue({ data: {} });

      await notion.ensureTypeOptions();

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/databases/db-123-456',
        expect.objectContaining({
          properties: {
            'Source': { rich_text: {} },
          },
        })
      );
    });

    it('should not throw on error (non-fatal)', async () => {
      mockClient.get.mockRejectedValue(new Error('API error'));

      // Should not throw
      await notion.ensureTypeOptions();
    });

    it('should handle missing Type property', async () => {
      mockClient.get.mockResolvedValue({
        data: { properties: { 'Source': { type: 'rich_text' } } },
      });

      // Should not throw - no Type means no type patch, Source already exists means no Source patch
      await notion.ensureTypeOptions();
      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should handle non-select Type property', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          properties: {
            'Type': { type: 'multi_select' },
            'Source': { type: 'rich_text' },
          },
        },
      });

      await notion.ensureTypeOptions();
      expect(mockClient.patch).not.toHaveBeenCalled();
    });
  });

  describe('testConnection()', () => {
    it('should GET /databases/{databaseId}', async () => {
      mockClient.get.mockResolvedValue({
        data: { title: [{ plain_text: 'My DB' }] },
      });
      vi.spyOn(notion, 'ensureTypeOptions').mockResolvedValue();

      await notion.testConnection();

      expect(mockClient.get).toHaveBeenCalledWith('/databases/db-123-456');
    });

    it('should call ensureTypeOptions on success', async () => {
      mockClient.get.mockResolvedValue({
        data: { title: [{ plain_text: 'My DB' }] },
      });
      const spy = vi.spyOn(notion, 'ensureTypeOptions').mockResolvedValue();

      await notion.testConnection();

      expect(spy).toHaveBeenCalled();
    });

    it('should return true on success', async () => {
      mockClient.get.mockResolvedValue({
        data: { title: [{ plain_text: 'My DB' }] },
      });
      vi.spyOn(notion, 'ensureTypeOptions').mockResolvedValue();

      const result = await notion.testConnection();
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      mockClient.get.mockRejectedValue(new Error('Unauthorized'));

      const result = await notion.testConnection();
      expect(result).toBe(false);
    });
  });
});
