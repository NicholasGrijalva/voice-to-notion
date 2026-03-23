const axios = require('axios');

const Summarizer = require('../../src/summarizer');

describe('Summarizer', () => {
  let summarizer;

  beforeEach(() => {
    summarizer = new Summarizer('test-groq-key');
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Test Title',
              key_points: ['Point 1', 'Point 2'],
              summary: 'A test summary of the content.',
              tags: ['productivity']
            })
          }
        }]
      }
    });
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should store apiKey', () => {
      expect(summarizer.apiKey).toBe('test-groq-key');
    });

    it('should use default model llama-3.3-70b-versatile', () => {
      expect(summarizer.model).toBe('llama-3.3-70b-versatile');
    });

    it('should accept custom model', () => {
      const custom = new Summarizer('key', { model: 'custom-model' });
      expect(custom.model).toBe('custom-model');
    });

    it('should use default timeout of 30000ms', () => {
      expect(summarizer.timeout).toBe(30000);
    });

    it('should accept custom timeout', () => {
      const custom = new Summarizer('key', { timeout: 60000 });
      expect(custom.timeout).toBe(60000);
    });

    it('should use default maxInputChars of 12000', () => {
      expect(summarizer.maxInputChars).toBe(12000);
    });

    it('should accept custom maxInputChars', () => {
      const custom = new Summarizer('key', { maxInputChars: 5000 });
      expect(custom.maxInputChars).toBe(5000);
    });
  });

  describe('summarize()', () => {
    const validContent = 'A'.repeat(200); // Well above 100 char minimum

    it('should return null when apiKey is not set', async () => {
      const noKey = new Summarizer(null);
      const result = await noKey.summarize(validContent, 'article');
      expect(result).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should return null when apiKey is empty string', async () => {
      const noKey = new Summarizer('');
      const result = await noKey.summarize(validContent, 'article');
      expect(result).toBeNull();
    });

    it('should return null for null content', async () => {
      const result = await summarizer.summarize(null, 'article');
      expect(result).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should return null for empty content', async () => {
      const result = await summarizer.summarize('', 'article');
      expect(result).toBeNull();
    });

    it('should return null for content shorter than 100 chars', async () => {
      const result = await summarizer.summarize('Short text under limit', 'article');
      expect(result).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should send POST to Groq chat completions URL', async () => {
      await summarizer.summarize(validContent, 'article');

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1/chat/completions',
        expect.any(Object),
        expect.objectContaining({
          headers: { 'Authorization': 'Bearer test-groq-key' },
          timeout: 30000,
        })
      );
    });

    it('should send correct model and temperature in request body', async () => {
      await summarizer.summarize(validContent, 'article');

      const requestBody = axios.post.mock.calls[0][1];
      expect(requestBody.model).toBe('llama-3.3-70b-versatile');
      expect(requestBody.temperature).toBe(0.2);
      expect(requestBody.max_tokens).toBe(800);
      expect(requestBody.response_format).toEqual({ type: 'json_object' });
    });

    it('should include system and user messages', async () => {
      await summarizer.summarize(validContent, 'article');

      const requestBody = axios.post.mock.calls[0][1];
      expect(requestBody.messages).toHaveLength(2);
      expect(requestBody.messages[0].role).toBe('system');
      expect(requestBody.messages[1].role).toBe('user');
    });

    it('should truncate content to maxInputChars', async () => {
      const longContent = 'X'.repeat(20000);
      const custom = new Summarizer('key', { maxInputChars: 5000 });
      vi.spyOn(custom, 'buildPrompt');

      await custom.summarize(longContent, 'article');

      // buildPrompt should receive truncated content
      expect(custom.buildPrompt).toHaveBeenCalledWith(
        'X'.repeat(5000),
        'article',
        {}
      );
    });

    it('should return parsed title, keyPoints, summary, and tags', async () => {
      const result = await summarizer.summarize(validContent, 'article');

      expect(result).toEqual({
        title: 'Test Title',
        keyPoints: ['Point 1', 'Point 2'],
        summary: 'A test summary of the content.',
        tags: ['productivity']
      });
    });

    it('should truncate title to 200 chars', async () => {
      axios.post.mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'T'.repeat(300),
                key_points: [],
                summary: 'Summary'
              })
            }
          }]
        }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result.title).toHaveLength(200);
    });

    it('should limit key_points to 7 entries', async () => {
      axios.post.mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Title',
                key_points: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
                summary: 'Summary'
              })
            }
          }]
        }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result.keyPoints).toHaveLength(7);
    });

    it('should default keyPoints to empty array when key_points is not an array', async () => {
      axios.post.mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Title',
                key_points: 'not an array',
                summary: 'Summary'
              })
            }
          }]
        }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result.keyPoints).toEqual([]);
    });

    it('should use meta.title as fallback when parsed title is empty', async () => {
      axios.post.mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: '',
                key_points: [],
                summary: 'Summary'
              })
            }
          }]
        }
      });

      const result = await summarizer.summarize(validContent, 'article', { title: 'Fallback Title' });
      expect(result.title).toBe('Fallback Title');
    });

    it('should accept concise_summary as fallback for summary field', async () => {
      axios.post.mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Title',
                key_points: [],
                concise_summary: 'A concise version'
              })
            }
          }]
        }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result.summary).toBe('A concise version');
    });

    it('should default tags to empty array when not an array', async () => {
      axios.post.mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Title',
                key_points: [],
                summary: 'Summary',
                tags: 'not-array'
              })
            }
          }]
        }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result.tags).toEqual([]);
    });

    it('should return null when response has no choices', async () => {
      axios.post.mockResolvedValue({ data: { choices: [] } });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result).toBeNull();
    });

    it('should return null when response message content is empty', async () => {
      axios.post.mockResolvedValue({
        data: { choices: [{ message: { content: '' } }] }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result).toBeNull();
    });

    it('should return null on API error without throwing', async () => {
      axios.post.mockRejectedValue(new Error('API rate limit'));

      const result = await summarizer.summarize(validContent, 'article');
      expect(result).toBeNull();
    });

    it('should return null on JSON parse error without throwing', async () => {
      axios.post.mockResolvedValue({
        data: { choices: [{ message: { content: 'not valid json{{{' } }] }
      });

      const result = await summarizer.summarize(validContent, 'article');
      expect(result).toBeNull();
    });

    it('should pass meta to buildPrompt', async () => {
      vi.spyOn(summarizer, 'buildPrompt');
      const meta = { title: 'My Article', author: 'Author Name' };

      await summarizer.summarize(validContent, 'youtube', meta);

      expect(summarizer.buildPrompt).toHaveBeenCalledWith(
        expect.any(String),
        'youtube',
        meta
      );
    });

    it('should default contentType to article', async () => {
      vi.spyOn(summarizer, 'buildPrompt');

      await summarizer.summarize(validContent);

      expect(summarizer.buildPrompt).toHaveBeenCalledWith(
        expect.any(String),
        'article',
        {}
      );
    });
  });

  describe('buildPrompt()', () => {
    it('should return object with system and user properties', () => {
      const prompt = summarizer.buildPrompt('content', 'article', {});
      expect(prompt).toHaveProperty('system');
      expect(prompt).toHaveProperty('user');
      expect(typeof prompt.system).toBe('string');
      expect(typeof prompt.user).toBe('string');
    });

    it('should include youtube-specific instruction for youtube type', () => {
      const prompt = summarizer.buildPrompt('content', 'youtube', {});
      expect(prompt.user).toContain('YouTube video transcript');
    });

    it('should include tweet-specific instruction for tweet type', () => {
      const prompt = summarizer.buildPrompt('content', 'tweet', {});
      expect(prompt.user).toContain('tweet');
    });

    it('should include pdf-specific instruction for pdf type', () => {
      const prompt = summarizer.buildPrompt('content', 'pdf', {});
      expect(prompt.user).toContain('PDF document');
    });

    it('should include audio-specific instruction for audio type', () => {
      const prompt = summarizer.buildPrompt('content', 'audio', {});
      expect(prompt.user).toContain('audio transcription');
    });

    it('should include perplexity-specific instruction for perplexity type', () => {
      const prompt = summarizer.buildPrompt('content', 'perplexity', {});
      expect(prompt.user).toContain('Perplexity AI');
    });

    it('should include linkedin-specific instruction for linkedin type', () => {
      const prompt = summarizer.buildPrompt('content', 'linkedin', {});
      expect(prompt.user).toContain('LinkedIn post');
    });

    it('should fall back to article instruction for unknown type', () => {
      const prompt = summarizer.buildPrompt('content', 'unknown_type', {});
      expect(prompt.user).toContain('web article or blog post');
    });

    it('should include meta title in user prompt when provided', () => {
      const prompt = summarizer.buildPrompt('content', 'article', { title: 'My Article' });
      expect(prompt.user).toContain('Original title: "My Article"');
    });

    it('should include meta author in user prompt when provided', () => {
      const prompt = summarizer.buildPrompt('content', 'article', { author: 'John Doe' });
      expect(prompt.user).toContain('Author/Source: John Doe');
    });

    it('should omit title line when meta.title is not provided', () => {
      const prompt = summarizer.buildPrompt('content', 'article', {});
      expect(prompt.user).not.toContain('Original title:');
    });

    it('should omit author line when meta.author is not provided', () => {
      const prompt = summarizer.buildPrompt('content', 'article', {});
      expect(prompt.user).not.toContain('Author/Source:');
    });

    it('should include the content in the user prompt', () => {
      const prompt = summarizer.buildPrompt('Here is the actual text', 'article', {});
      expect(prompt.user).toContain('Here is the actual text');
    });

    it('should include JSON schema instructions in system prompt', () => {
      const prompt = summarizer.buildPrompt('content', 'article', {});
      expect(prompt.system).toContain('"title"');
      expect(prompt.system).toContain('"key_points"');
      expect(prompt.system).toContain('"summary"');
      expect(prompt.system).toContain('"tags"');
    });
  });
});
