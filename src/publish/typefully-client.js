/**
 * Typefully v2 API Client
 *
 * Wraps the Typefully REST API for creating drafts, publishing posts,
 * and fetching published post data. Follows the same pattern as summarizer.js.
 *
 * API docs: https://typefully.com/docs/api
 */

const axios = require('axios');

const TYPEFULLY_BASE = 'https://api.typefully.com/v2';

class TypefullyClient {
  constructor(apiKey, socialSetId, options = {}) {
    this.apiKey = apiKey;
    this.socialSetId = socialSetId;
    this.baseUrl = options.baseUrl || TYPEFULLY_BASE;
    this.timeout = options.timeout || 15000;
  }

  /**
   * Create a draft on Typefully, optionally publishing it immediately.
   *
   * @param {string} text - Post text (used for all platforms unless perPlatformText overrides)
   * @param {Object} opts
   * @param {Object} opts.platforms - { twitter: true, linkedin: true, ... }
   * @param {string|null} opts.publishAt - "now", "next-free-slot", ISO 8601, or null (draft only)
   * @param {string[]|null} opts.threadPosts - If set, creates a thread instead of single post
   * @param {Object|null} opts.perPlatformText - { twitter: "short", linkedin: "long" }
   * @returns {Promise<{ draftId: string }>}
   */
  async createDraft(text, opts = {}) {
    const { platforms = {}, publishAt = null, threadPosts = null, perPlatformText = null } = opts;

    const platformPayload = {};
    for (const [key, enabled] of Object.entries(platforms)) {
      if (!enabled) continue;

      let posts;
      if (threadPosts && threadPosts.length > 1) {
        // Thread mode: each element becomes a post in the thread
        posts = threadPosts.map(t => ({ text: t }));
      } else {
        // Single post mode, with optional per-platform text
        const postText = perPlatformText?.[key] || text;
        posts = [{ text: postText }];
      }

      platformPayload[key] = { enabled: true, posts };
    }

    const body = { platforms: platformPayload };
    if (publishAt) body.publish_at = publishAt;

    const response = await axios.post(
      `${this.baseUrl}/social-sets/${this.socialSetId}/drafts`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: this.timeout,
      }
    );

    return { draftId: response.data.id || response.data.draft_id || null };
  }

  /**
   * Fetch recently published posts (for stats/engagement tracking).
   *
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getPublished(limit = 20) {
    const response = await axios.get(
      `${this.baseUrl}/social-sets/${this.socialSetId}/drafts`,
      {
        params: { status: 'published', limit },
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: this.timeout,
      }
    );
    return response.data.drafts || response.data || [];
  }

  /**
   * Test API connection.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      await axios.get(`${this.baseUrl}/social-sets/${this.socialSetId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: this.timeout,
      });
      console.log('[Typefully] Connection OK');
      return true;
    } catch (error) {
      console.error('[Typefully] Connection failed:', error.response?.data || error.message);
      return false;
    }
  }
}

module.exports = TypefullyClient;
