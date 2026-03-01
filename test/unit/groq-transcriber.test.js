const fs = require('fs');
const axios = require('axios');

const GroqTranscriber = require('../../src/groq-transcriber');

describe('GroqTranscriber', () => {
  let groq;

  beforeEach(() => {
    groq = new GroqTranscriber('test-api-key');
  });

  describe('constructor', () => {
    it('should store apiKey', () => {
      expect(groq.apiKey).toBe('test-api-key');
    });

    it('should use default model whisper-large-v3-turbo', () => {
      expect(groq.model).toBe('whisper-large-v3-turbo');
    });

    it('should accept custom model name', () => {
      const custom = new GroqTranscriber('key', { model: 'whisper-large-v3' });
      expect(custom.model).toBe('whisper-large-v3');
    });

    it('should use default timeout of 120000ms', () => {
      expect(groq.timeout).toBe(120000);
    });

    it('should accept custom timeout', () => {
      const custom = new GroqTranscriber('key', { timeout: 60000 });
      expect(custom.timeout).toBe(60000);
    });
  });

  describe('transcribe()', () => {
    beforeEach(() => {
      vi.spyOn(fs, 'statSync').mockReturnValue({ size: 10 * 1024 * 1024 });
      vi.spyOn(fs, 'createReadStream').mockReturnValue('mock-stream');
      vi.spyOn(axios, 'post').mockResolvedValue({ data: { text: 'hello', language: 'en' } });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should throw when file exceeds 25MB limit', async () => {
      fs.statSync.mockReturnValue({ size: 30 * 1024 * 1024 });

      await expect(groq.transcribe('/path/to/large.mp3'))
        .rejects.toThrow('File too large for Groq');
    });

    it('should include file size in error message when too large', async () => {
      fs.statSync.mockReturnValue({ size: 30 * 1024 * 1024 });

      await expect(groq.transcribe('/path/to/large.mp3'))
        .rejects.toThrow('30.0MB > 25MB limit');
    });

    it('should send POST to Groq API URL with correct Authorization header', async () => {
      await groq.transcribe('/path/to/audio.mp3');

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key',
          }),
          timeout: 120000,
        })
      );
    });

    it('should return { text, language } from response', async () => {
      axios.post.mockResolvedValue({
        data: { text: 'transcribed text', language: 'en' },
      });

      const result = await groq.transcribe('/path/to/audio.mp3');
      expect(result).toEqual({ text: 'transcribed text', language: 'en' });
    });

    it('should use detected language from response', async () => {
      axios.post.mockResolvedValue({
        data: { text: 'bonjour', language: 'fr' },
      });

      const result = await groq.transcribe('/path/to/audio.mp3', 'en');
      expect(result.language).toBe('fr');
    });

    it('should default to input language when response has no language', async () => {
      axios.post.mockResolvedValue({ data: { text: 'hello' } });

      const result = await groq.transcribe('/path/to/audio.mp3', 'es');
      expect(result.language).toBe('es');
    });

    it('should propagate axios errors', async () => {
      axios.post.mockRejectedValue(new Error('Network error'));

      await expect(groq.transcribe('/path/to/audio.mp3'))
        .rejects.toThrow('Network error');
    });
  });
});
