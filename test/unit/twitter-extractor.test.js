const axios = require('axios');

const TwitterExtractor = require('../../src/twitter-extractor');

describe('TwitterExtractor', () => {
  let extractor;

  beforeEach(() => {
    extractor = new TwitterExtractor();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default timeout of 15000ms', () => {
      expect(extractor.timeout).toBe(15000);
    });

    it('should accept custom timeout', () => {
      const custom = new TwitterExtractor({ timeout: 5000 });
      expect(custom.timeout).toBe(5000);
    });
  });

  describe('extract()', () => {
    const sampleUrl = 'https://twitter.com/elonmusk/status/1234567890';
    const sampleTweetId = '1234567890';

    const baseTweetResponse = {
      data: {
        tweet: {
          text: 'This is a sample tweet with some content',
          author: {
            name: 'Elon Musk',
            screen_name: 'elonmusk',
          },
          created_at: '2024-01-15T10:30:00.000Z',
          likes: 1500,
          retweets: 300,
          replies: 50,
        },
      },
    };

    it('should call FxTwitter API with correct URL', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      await extractor.extract(sampleUrl, sampleTweetId);

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.fxtwitter.com/elonmusk/status/1234567890',
        expect.objectContaining({
          timeout: 15000,
          headers: { 'Accept': 'application/json' },
        })
      );
    });

    it('should extract username from twitter.com URL', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      await extractor.extract('https://twitter.com/testuser/status/999', '999');

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.fxtwitter.com/testuser/status/999',
        expect.any(Object)
      );
    });

    it('should extract username from x.com URL', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      await extractor.extract('https://x.com/openai/status/555', '555');

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.fxtwitter.com/openai/status/555',
        expect.any(Object)
      );
    });

    it('should return result with title, content, author, isThread, and url', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('author');
      expect(result).toHaveProperty('isThread');
      expect(result).toHaveProperty('url');
    });

    it('should set author as @handle format', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.author).toBe('@elonmusk');
    });

    it('should build title from handle and truncated tweet text', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.title).toContain('@elonmusk:');
      expect(result.title).toContain('This is a sample tweet');
    });

    it('should truncate title text at 80 chars with ellipsis', async () => {
      const longTweetResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            text: 'A'.repeat(120),
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(longTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.title).toContain('...');
    });

    it('should not add ellipsis when text is 80 chars or less', async () => {
      const shortTweetResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            text: 'Short tweet',
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(shortTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.title).not.toContain('...');
    });

    it('should include handle and author name in content', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('@elonmusk (Elon Musk)');
    });

    it('should include tweet text in content', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('This is a sample tweet with some content');
    });

    it('should include created_at date in content', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('Posted: 2024-01-15');
    });

    it('should include engagement stats in content when present', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('1500 likes');
      expect(result.content).toContain('300 retweets');
      expect(result.content).toContain('50 replies');
    });

    it('should omit engagement line when likes and retweets are 0', async () => {
      const noEngagementResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            likes: 0,
            retweets: 0,
            replies: 0,
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(noEngagementResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).not.toContain('Engagement:');
    });

    it('should include media attachment count when media is present', async () => {
      const mediaResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            media: {
              all: [
                { type: 'photo', url: 'https://pbs.twimg.com/1.jpg' },
                { type: 'photo', url: 'https://pbs.twimg.com/2.jpg', altText: 'A description' },
              ],
            },
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(mediaResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('2 media attachment(s)');
    });

    it('should include alt text for media when available', async () => {
      const mediaResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            media: {
              all: [
                { type: 'photo', altText: 'A cat sitting on a keyboard' },
              ],
            },
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(mediaResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('Alt text: A cat sitting on a keyboard');
    });

    it('should include quoted tweet content when present', async () => {
      const quoteResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            quote: {
              text: 'This is the quoted tweet text',
              author: { screen_name: 'quoteduser' },
            },
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(quoteResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('Quoted tweet from @quoteduser');
      expect(result.content).toContain('This is the quoted tweet text');
    });

    it('should use "unknown" when quoted tweet author is missing', async () => {
      const quoteResponse = {
        data: {
          tweet: {
            ...baseTweetResponse.data.tweet,
            quote: {
              text: 'Quoted without author info',
              author: {},
            },
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(quoteResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.content).toContain('Quoted tweet from @unknown');
    });

    it('should set isThread to false (single tweet extraction)', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.isThread).toBe(false);
    });

    it('should preserve the original URL in result', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.url).toBe(sampleUrl);
    });

    it('should return null when tweet data is missing from response', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: {} });

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result).toBeNull();
    });

    it('should return null when response has no data', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: null });

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result).toBeNull();
    });

    it('should return null on API error without throwing', async () => {
      vi.spyOn(axios, 'get').mockRejectedValue(new Error('FxTwitter API down'));

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result).toBeNull();
    });

    it('should use username from URL when author data is missing', async () => {
      const noAuthorResponse = {
        data: {
          tweet: {
            text: 'Tweet without author details',
            created_at: '2024-01-15',
            likes: 0,
            retweets: 0,
            replies: 0,
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(noAuthorResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result.author).toBe('@elonmusk');
      expect(result.content).toContain('@elonmusk');
    });

    it('should use "unknown" when URL does not match username pattern', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue(baseTweetResponse);

      await extractor.extract('https://some-proxy.com/tweet/123', '123');

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.fxtwitter.com/unknown/status/123',
        expect.any(Object)
      );
    });

    it('should handle tweet with empty text gracefully', async () => {
      const emptyTextResponse = {
        data: {
          tweet: {
            text: '',
            author: { name: 'Test', screen_name: 'test' },
            likes: 0,
            retweets: 0,
            replies: 0,
          },
        },
      };
      vi.spyOn(axios, 'get').mockResolvedValue(emptyTextResponse);

      const result = await extractor.extract(sampleUrl, sampleTweetId);

      expect(result).not.toBeNull();
      expect(result.title).toContain('@test:');
    });
  });
});
