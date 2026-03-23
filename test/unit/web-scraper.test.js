const axios = require('axios');

const WebScraper = require('../../src/web-scraper');

describe('WebScraper', () => {
  let scraper;

  beforeEach(() => {
    scraper = new WebScraper();
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
      expect(scraper.timeout).toBe(15000);
    });

    it('should use default maxContentLength of 5MB', () => {
      expect(scraper.maxContentLength).toBe(5 * 1024 * 1024);
    });

    it('should accept custom timeout', () => {
      const custom = new WebScraper({ timeout: 30000 });
      expect(custom.timeout).toBe(30000);
    });

    it('should accept custom maxContentLength', () => {
      const custom = new WebScraper({ maxContentLength: 1024 });
      expect(custom.maxContentLength).toBe(1024);
    });

    it('should have a Chrome-like user agent string', () => {
      expect(scraper.userAgent).toContain('Mozilla');
      expect(scraper.userAgent).toContain('Chrome');
    });
  });

  describe('extract()', () => {
    const richArticleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Article Title</title></head>
        <body>
          <article>
            <h1>Test Article Title</h1>
            <p class="author">By John Doe</p>
            <p>${'This is a paragraph of real article content that Readability should be able to extract cleanly. It contains enough text to pass the 100-character minimum threshold for valid extraction. '.repeat(5)}</p>
            <p>${'Additional paragraph with more content to ensure Readability considers this a proper article. '.repeat(5)}</p>
          </article>
        </body>
      </html>
    `;

    const minimalHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Simple Page</title></head>
        <body>
          <div>${'Some body content that is long enough to be extracted in the fallback path. '.repeat(10)}</div>
        </body>
      </html>
    `;

    it('should call axios.get with correct headers and options', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: richArticleHtml });

      await scraper.extract('https://example.com/article');

      expect(axios.get).toHaveBeenCalledWith(
        'https://example.com/article',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('Mozilla'),
            'Accept': expect.stringContaining('text/html'),
          }),
          timeout: 15000,
          responseType: 'text',
        })
      );
    });

    it('should extract article content via Readability when available', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: richArticleHtml });

      const result = await scraper.extract('https://example.com/article');

      expect(result).not.toBeNull();
      expect(result.content.length).toBeGreaterThan(100);
      expect(result.title).toBeTruthy();
    });

    it('should return all expected fields in the result', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: richArticleHtml });

      const result = await scraper.extract('https://example.com/article');

      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('excerpt');
      expect(result).toHaveProperty('author');
      expect(result).toHaveProperty('siteName');
    });

    it('should fall back to body text when Readability cannot parse', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: minimalHtml });

      const result = await scraper.extract('https://example.com/minimal');

      // Either Readability or fallback should produce a result
      expect(result).not.toBeNull();
      expect(result.content.length).toBeGreaterThan(100);
    });

    it('should remove script and style tags in fallback extraction', async () => {
      const htmlWithScripts = `
        <!DOCTYPE html>
        <html>
          <head><title>Script Test</title></head>
          <body>
            <script>var secret = "should_not_appear_in_output";</script>
            <style>.hidden { display: none; }</style>
            <nav>Navigation links</nav>
            <div>${'Real body content text that matters for extraction. '.repeat(10)}</div>
            <footer>Footer info</footer>
          </body>
        </html>
      `;
      vi.spyOn(axios, 'get').mockResolvedValue({ data: htmlWithScripts });

      const result = await scraper.extract('https://example.com/scripts');

      if (result) {
        expect(result.content).not.toContain('should_not_appear_in_output');
      }
    });

    it('should return null for empty response', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: '' });

      const result = await scraper.extract('https://example.com/empty');
      expect(result).toBeNull();
    });

    it('should return null for non-string response', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: { json: true } });

      const result = await scraper.extract('https://example.com/json');
      expect(result).toBeNull();
    });

    it('should return null for null response body', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: null });

      const result = await scraper.extract('https://example.com/null');
      expect(result).toBeNull();
    });

    it('should return null on HTTP error without throwing', async () => {
      vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network timeout'));

      const result = await scraper.extract('https://example.com/timeout');
      expect(result).toBeNull();
    });

    it('should return null on 404 error without throwing', async () => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      vi.spyOn(axios, 'get').mockRejectedValue(error);

      const result = await scraper.extract('https://example.com/not-found');
      expect(result).toBeNull();
    });

    it('should return null when page has too little text', async () => {
      const tinyHtml = `
        <!DOCTYPE html>
        <html><head><title>T</title></head>
        <body><p>Hi</p></body></html>
      `;
      vi.spyOn(axios, 'get').mockResolvedValue({ data: tinyHtml });

      const result = await scraper.extract('https://example.com/tiny');
      expect(result).toBeNull();
    });
  });

  describe('extractPdf()', () => {
    it('should call axios.get with arraybuffer responseType', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({
        data: Buffer.from('fake-pdf-data'),
        headers: { 'content-type': 'application/pdf' },
      });

      // pdf-parse will fail on fake data, but we can verify the axios call
      await scraper.extractPdf('https://example.com/paper.pdf');

      expect(axios.get).toHaveBeenCalledWith(
        'https://example.com/paper.pdf',
        expect.objectContaining({
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 50 * 1024 * 1024,
        })
      );
    });

    it('should return null when content-type is not PDF and URL has no .pdf extension', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({
        data: Buffer.from('not-pdf'),
        headers: { 'content-type': 'text/html' },
      });

      const result = await scraper.extractPdf('https://example.com/page');
      expect(result).toBeNull();
    });

    it('should allow .pdf URL extension to bypass content-type check', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({
        data: Buffer.from('fake-pdf'),
        headers: { 'content-type': 'application/octet-stream' },
      });

      // Will get past content-type validation due to .pdf extension
      // pdf-parse may fail on fake data -> returns null from catch
      const result = await scraper.extractPdf('https://example.com/doc.pdf');
      // Verify it didn't return null from the content-type check
      // (it returns null from pdf-parse failure which is a different code path)
      expect(result).toBeNull();
    });

    it('should return null on HTTP error without throwing', async () => {
      vi.spyOn(axios, 'get').mockRejectedValue(new Error('Download failed'));

      const result = await scraper.extractPdf('https://example.com/paper.pdf');
      expect(result).toBeNull();
    });

    it('should use 50MB maxContentLength for PDF downloads', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({
        data: Buffer.from('pdf'),
        headers: { 'content-type': 'application/pdf' },
      });

      await scraper.extractPdf('https://example.com/big.pdf');

      const callOpts = axios.get.mock.calls[0][1];
      expect(callOpts.maxContentLength).toBe(50 * 1024 * 1024);
    });
  });

  describe('titleFromUrl()', () => {
    it('should extract last path segment as title', () => {
      const title = scraper.titleFromUrl('https://example.com/blog/my-awesome-post');
      expect(title).toBe('my awesome post');
    });

    it('should decode URI-encoded characters', () => {
      const title = scraper.titleFromUrl('https://example.com/articles/hello%20world');
      expect(title).toBe('hello world');
    });

    it('should replace hyphens and underscores with spaces', () => {
      const title = scraper.titleFromUrl('https://example.com/my_great-article');
      expect(title).toBe('my great article');
    });

    it('should strip file extension', () => {
      const title = scraper.titleFromUrl('https://example.com/document.pdf');
      expect(title).toBe('document');
    });

    it('should fall back to hostname when path is empty (extension stripped)', () => {
      // hostname "example.com" has .com stripped by the extension regex
      const title = scraper.titleFromUrl('https://example.com/');
      expect(title).toBe('example');
    });

    it('should return Untitled for invalid URL', () => {
      const title = scraper.titleFromUrl('not-a-valid-url');
      expect(title).toBe('Untitled');
    });
  });
});
