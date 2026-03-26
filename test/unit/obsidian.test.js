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
