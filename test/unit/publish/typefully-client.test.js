const axios = require('axios');

const TypefullyClient = require('../../../src/publish/typefully-client');

describe('TypefullyClient', () => {
  let client;
  const TEST_API_KEY = 'test-typefully-key';
  const TEST_SOCIAL_SET_ID = 'social-set-123';

  beforeEach(() => {
    client = new TypefullyClient(TEST_API_KEY, TEST_SOCIAL_SET_ID);
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { id: 'draft-001' } });
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { drafts: [] } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should store apiKey and socialSetId', () => {
      expect(client.apiKey).toBe(TEST_API_KEY);
      expect(client.socialSetId).toBe(TEST_SOCIAL_SET_ID);
    });

    it('should use default baseUrl', () => {
      expect(client.baseUrl).toBe('https://api.typefully.com/v2');
    });

    it('should use default timeout of 15000ms', () => {
      expect(client.timeout).toBe(15000);
    });

    it('should allow custom options to override defaults', () => {
      const custom = new TypefullyClient('key', 'set-id', {
        baseUrl: 'https://custom.api.com/v1',
        timeout: 30000,
      });
      expect(custom.baseUrl).toBe('https://custom.api.com/v1');
      expect(custom.timeout).toBe(30000);
    });
  });

  describe('createDraft()', () => {
    it('should POST to the correct URL with auth headers', async () => {
      await client.createDraft('Hello world', {
        platforms: { twitter: true },
      });

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.typefully.com/v2/social-sets/social-set-123/drafts',
        expect.any(Object),
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer test-typefully-key',
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        })
      );
    });

    it('should send single post body for a single-post draft', async () => {
      await client.createDraft('Hello world', {
        platforms: { twitter: true },
      });

      const body = axios.post.mock.calls[0][1];
      expect(body.platforms.twitter).toEqual({
        enabled: true,
        posts: [{ text: 'Hello world' }],
      });
    });

    it('should send thread posts array per platform', async () => {
      const threads = ['First tweet', 'Second tweet', 'Third tweet'];
      await client.createDraft('ignored', {
        platforms: { twitter: true, linkedin: true },
        threadPosts: threads,
      });

      const body = axios.post.mock.calls[0][1];
      const expectedPosts = [
        { text: 'First tweet' },
        { text: 'Second tweet' },
        { text: 'Third tweet' },
      ];
      expect(body.platforms.twitter.posts).toEqual(expectedPosts);
      expect(body.platforms.linkedin.posts).toEqual(expectedPosts);
    });

    it('should use per-platform text when provided', async () => {
      await client.createDraft('default text', {
        platforms: { twitter: true, linkedin: true },
        perPlatformText: {
          twitter: 'Short for Twitter',
          linkedin: 'Longer professional post for LinkedIn audience',
        },
      });

      const body = axios.post.mock.calls[0][1];
      expect(body.platforms.twitter.posts).toEqual([
        { text: 'Short for Twitter' },
      ]);
      expect(body.platforms.linkedin.posts).toEqual([
        { text: 'Longer professional post for LinkedIn audience' },
      ]);
    });

    it('should fall back to default text when perPlatformText lacks a platform', async () => {
      await client.createDraft('fallback text', {
        platforms: { twitter: true, linkedin: true },
        perPlatformText: { twitter: 'Short version' },
      });

      const body = axios.post.mock.calls[0][1];
      expect(body.platforms.twitter.posts[0].text).toBe('Short version');
      expect(body.platforms.linkedin.posts[0].text).toBe('fallback text');
    });

    it('should include publish_at "now" in body', async () => {
      await client.createDraft('Post now', {
        platforms: { twitter: true },
        publishAt: 'now',
      });

      const body = axios.post.mock.calls[0][1];
      expect(body.publish_at).toBe('now');
    });

    it('should include publish_at "next-free-slot" in body', async () => {
      await client.createDraft('Queue it', {
        platforms: { twitter: true },
        publishAt: 'next-free-slot',
      });

      const body = axios.post.mock.calls[0][1];
      expect(body.publish_at).toBe('next-free-slot');
    });

    it('should omit publish_at when publishAt is null (draft only)', async () => {
      await client.createDraft('Just a draft', {
        platforms: { twitter: true },
        publishAt: null,
      });

      const body = axios.post.mock.calls[0][1];
      expect(body).not.toHaveProperty('publish_at');
    });

    it('should exclude disabled platforms from payload', async () => {
      await client.createDraft('Selective post', {
        platforms: { twitter: true, linkedin: false, threads: true },
      });

      const body = axios.post.mock.calls[0][1];
      expect(body.platforms).toHaveProperty('twitter');
      expect(body.platforms).not.toHaveProperty('linkedin');
      expect(body.platforms).toHaveProperty('threads');
    });

    it('should return draftId from response data.id', async () => {
      axios.post.mockResolvedValue({ data: { id: 'draft-abc' } });

      const result = await client.createDraft('Test', {
        platforms: { twitter: true },
      });

      expect(result).toEqual({ draftId: 'draft-abc' });
    });

    it('should return draftId from response data.draft_id as fallback', async () => {
      axios.post.mockResolvedValue({ data: { draft_id: 'draft-xyz' } });

      const result = await client.createDraft('Test', {
        platforms: { twitter: true },
      });

      expect(result).toEqual({ draftId: 'draft-xyz' });
    });

    it('should throw on API error', async () => {
      axios.post.mockRejectedValue(new Error('403 Forbidden'));

      await expect(
        client.createDraft('Fail', { platforms: { twitter: true } })
      ).rejects.toThrow('403 Forbidden');
    });

    it('should throw on network timeout', async () => {
      const timeoutErr = new Error('timeout of 15000ms exceeded');
      timeoutErr.code = 'ECONNABORTED';
      axios.post.mockRejectedValue(timeoutErr);

      await expect(
        client.createDraft('Timeout', { platforms: { twitter: true } })
      ).rejects.toThrow('timeout of 15000ms exceeded');
    });
  });

  describe('getPublished()', () => {
    it('should send GET with correct URL and params', async () => {
      await client.getPublished(10);

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.typefully.com/v2/social-sets/social-set-123/drafts',
        expect.objectContaining({
          params: { status: 'published', limit: 10 },
          headers: { 'Authorization': 'Bearer test-typefully-key' },
          timeout: 15000,
        })
      );
    });

    it('should return drafts array from response', async () => {
      const drafts = [
        { id: 'd1', text: 'First' },
        { id: 'd2', text: 'Second' },
      ];
      axios.get.mockResolvedValue({ data: { drafts } });

      const result = await client.getPublished();

      expect(result).toEqual(drafts);
    });

    it('should fall back to data itself when drafts key is absent', async () => {
      const rawData = [{ id: 'r1' }, { id: 'r2' }];
      axios.get.mockResolvedValue({ data: rawData });

      const result = await client.getPublished();

      expect(result).toEqual(rawData);
    });

    it('should default limit to 20', async () => {
      await client.getPublished();

      const callArgs = axios.get.mock.calls[0][1];
      expect(callArgs.params.limit).toBe(20);
    });
  });

  describe('testConnection()', () => {
    it('should return true on successful GET', async () => {
      axios.get.mockResolvedValue({ data: { id: TEST_SOCIAL_SET_ID } });

      const result = await client.testConnection();

      expect(result).toBe(true);
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.typefully.com/v2/social-sets/social-set-123',
        expect.objectContaining({
          headers: { 'Authorization': 'Bearer test-typefully-key' },
          timeout: 15000,
        })
      );
    });

    it('should return false and log error on failure', async () => {
      const err = new Error('Network Error');
      err.response = { data: { error: 'Unauthorized' } };
      axios.get.mockRejectedValue(err);

      const result = await client.testConnection();

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        '[Typefully] Connection failed:',
        { error: 'Unauthorized' }
      );
    });

    it('should log error.message when response data is absent', async () => {
      axios.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.testConnection();

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        '[Typefully] Connection failed:',
        'ECONNREFUSED'
      );
    });
  });
});
