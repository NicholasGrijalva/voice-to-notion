/**
 * Web Scraper -- Article/webpage content extraction
 *
 * Uses Mozilla Readability + jsdom for clean article extraction.
 * Handles Perplexity, blog posts, articles, and general web pages.
 * Falls back to raw text extraction if Readability can't parse.
 */

const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

class WebScraper {
  constructor(options = {}) {
    this.timeout = options.timeout || 15000;
    this.maxContentLength = options.maxContentLength || 5 * 1024 * 1024; // 5MB
    this.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /**
   * Extract readable content from a URL.
   *
   * @param {string} url
   * @returns {Promise<{ title: string, content: string, excerpt: string, author: string|null, siteName: string|null } | null>}
   */
  async extract(url) {
    console.log(`[WebScraper] Extracting: ${url}`);

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: this.timeout,
        maxContentLength: this.maxContentLength,
        responseType: 'text',
      });

      const html = response.data;
      if (!html || typeof html !== 'string') {
        console.warn('[WebScraper] Empty or non-string response');
        return null;
      }

      // Parse with JSDOM + Readability
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article && article.textContent && article.textContent.length > 100) {
        console.log(`[WebScraper] Extracted: "${article.title}" (${article.textContent.length} chars)`);
        return {
          title: article.title || this.titleFromUrl(url),
          content: article.textContent.trim(),
          excerpt: (article.excerpt || '').trim(),
          author: article.byline || null,
          siteName: article.siteName || null,
        };
      }

      // Fallback: extract text from body
      const body = dom.window.document.body;
      if (body) {
        // Remove script, style, nav, footer
        for (const tag of ['script', 'style', 'nav', 'footer', 'header']) {
          body.querySelectorAll(tag).forEach(el => el.remove());
        }
        const text = body.textContent.replace(/\s+/g, ' ').trim();
        if (text.length > 100) {
          console.log(`[WebScraper] Fallback extraction: ${text.length} chars`);
          return {
            title: dom.window.document.title || this.titleFromUrl(url),
            content: text,
            excerpt: text.slice(0, 200),
            author: null,
            siteName: null,
          };
        }
      }

      console.warn('[WebScraper] Could not extract meaningful content');
      return null;

    } catch (error) {
      console.error(`[WebScraper] Failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract PDF text from a URL (downloads and parses).
   *
   * @param {string} url
   * @returns {Promise<{ title: string, content: string } | null>}
   */
  async extractPdf(url) {
    console.log(`[WebScraper] Extracting PDF: ${url}`);

    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024, // 50MB for PDFs
        responseType: 'arraybuffer',
      });

      // Validate content type
      const contentType = (response.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('pdf') && !url.match(/\.pdf(\?|#|$)/i)) {
        console.warn(`[WebScraper] URL does not appear to be a PDF (Content-Type: ${contentType})`);
        return null;
      }

      const pdfParse = require('pdf-parse');
      const data = await pdfParse(Buffer.from(response.data));

      if (!data.text || data.text.length < 50) {
        console.warn('[WebScraper] PDF has no extractable text (may be image-based)');
        return null;
      }

      // Try to extract title from PDF metadata or first line
      const title = data.info?.Title
        || data.text.split('\n').find(l => l.trim().length > 5)?.trim().slice(0, 150)
        || this.titleFromUrl(url);

      console.log(`[WebScraper] PDF extracted: "${title}" (${data.text.length} chars, ${data.numpages} pages)`);

      return {
        title,
        content: data.text.trim(),
        pages: data.numpages,
        author: data.info?.Author || null,
      };

    } catch (error) {
      console.error(`[WebScraper] PDF extraction failed: ${error.message}`);
      return null;
    }
  }

  titleFromUrl(url) {
    try {
      const u = new URL(url);
      const pathParts = u.pathname.split('/').filter(Boolean);
      const last = pathParts[pathParts.length - 1] || u.hostname;
      return decodeURIComponent(last).replace(/[-_]/g, ' ').replace(/\.\w+$/, '');
    } catch {
      return 'Untitled';
    }
  }
}

module.exports = WebScraper;
