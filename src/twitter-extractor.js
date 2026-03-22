/**
 * Twitter/X Thread Extractor via FxTwitter API
 *
 * Uses the free FxTwitter API (api.fxtwitter.com) to extract tweet text,
 * thread content, and media info. No API key required.
 */

const axios = require('axios');

const FXTWITTER_API = 'https://api.fxtwitter.com';

class TwitterExtractor {
  constructor(options = {}) {
    this.timeout = options.timeout || 15000;
  }

  /**
   * Extract tweet/thread content.
   *
   * @param {string} url - Twitter/X URL
   * @param {string} tweetId - Tweet ID (from content-router)
   * @returns {Promise<{ title: string, content: string, author: string, isThread: boolean } | null>}
   */
  async extract(url, tweetId) {
    console.log(`[TwitterExtractor] Extracting tweet: ${tweetId}`);

    try {
      // Extract username from URL
      const userMatch = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status/);
      const username = userMatch ? userMatch[1] : 'unknown';

      const response = await axios.get(`${FXTWITTER_API}/${username}/status/${tweetId}`, {
        timeout: this.timeout,
        headers: { 'Accept': 'application/json' },
      });

      const tweet = response.data?.tweet;
      if (!tweet) {
        console.warn('[TwitterExtractor] No tweet data in response');
        return null;
      }

      const author = tweet.author?.name || username;
      const handle = tweet.author?.screen_name || username;
      const text = tweet.text || '';
      const created = tweet.created_at || '';

      // Build content
      const parts = [];
      parts.push(`@${handle} (${author})`);
      if (created) parts.push(`Posted: ${created}`);
      parts.push('');
      parts.push(text);

      // Include media descriptions if present
      if (tweet.media?.all?.length > 0) {
        parts.push('');
        parts.push(`[${tweet.media.all.length} media attachment(s)]`);
        for (const media of tweet.media.all) {
          if (media.altText) parts.push(`Alt text: ${media.altText}`);
        }
      }

      // Include quote tweet if present
      if (tweet.quote) {
        parts.push('');
        parts.push(`--- Quoted tweet from @${tweet.quote.author?.screen_name || 'unknown'} ---`);
        parts.push(tweet.quote.text || '');
      }

      // Check engagement
      const likes = tweet.likes || 0;
      const retweets = tweet.retweets || 0;
      const replies = tweet.replies || 0;
      if (likes > 0 || retweets > 0) {
        parts.push('');
        parts.push(`Engagement: ${likes} likes, ${retweets} retweets, ${replies} replies`);
      }

      const title = `@${handle}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`;

      console.log(`[TwitterExtractor] Extracted tweet from @${handle} (${text.length} chars)`);

      return {
        title,
        content: parts.join('\n'),
        author: `@${handle}`,
        isThread: false, // FxTwitter returns single tweets; thread detection below
        url,
      };

    } catch (error) {
      // FxTwitter may not support all tweet types
      console.error(`[TwitterExtractor] Failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = TwitterExtractor;
