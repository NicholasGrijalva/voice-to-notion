/**
 * Content Router -- Regex-based URL classification
 *
 * Detects content type from URL patterns and routes to the correct extractor.
 * No LLM calls -- pure pattern matching for speed and determinism.
 */

class ContentRouter {
  /**
   * Detect content type from a URL.
   *
   * @param {string} url
   * @returns {{ type: string, id: string|null }}
   *   type: youtube | twitter | pdf | perplexity | linkedin | webpage
   *   id: extracted content ID if applicable (video ID, tweet ID, etc.)
   */
  static detect(url) {
    if (!url) return { type: 'unsupported', id: null };

    // YouTube
    const ytMatch = url.match(
      /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
    );
    if (ytMatch) return { type: 'youtube', id: ytMatch[1] };

    // Twitter / X.com
    const tweetMatch = url.match(
      /(?:twitter\.com|x\.com)\/\w+\/status(?:es)?\/(\d+)/
    );
    if (tweetMatch) return { type: 'twitter', id: tweetMatch[1] };

    // PDF (by extension)
    if (url.match(/\.pdf(\?|#|$)/i)) return { type: 'pdf', id: null };

    // Perplexity
    if (url.match(/perplexity\.ai\//)) return { type: 'perplexity', id: null };

    // LinkedIn post
    if (url.match(/linkedin\.com\/posts\//)) return { type: 'linkedin', id: null };

    // General web URL
    if (url.match(/^https?:\/\//)) return { type: 'webpage', id: null };

    return { type: 'unsupported', id: null };
  }

  /**
   * Check if URL is a media type that yt-dlp can handle.
   * Returns true for YouTube and known video/audio platforms.
   */
  static isMediaUrl(url) {
    const mediaPatterns = [
      /youtube\.com|youtu\.be/,
      /vimeo\.com/,
      /soundcloud\.com/,
      // Spotify removed: yt-dlp extractor is broken (wontfix upstream).
      // Spotify URLs route through web scraper for metadata capture instead.
      /tiktok\.com/,
      /twitch\.tv/,
      /podcasts\.apple\.com/,
      /\.(mp3|mp4|m4a|wav|ogg|opus|webm|mkv|avi|mov)(\?|#|$)/i,
    ];
    return mediaPatterns.some(p => p.test(url));
  }

  /**
   * Map content type to Notion "Type" select value.
   */
  static toNotionType(contentType) {
    const map = {
      youtube: 'YouTube',
      twitter: 'Post',
      pdf: 'Idea',
      perplexity: 'Idea',
      linkedin: 'Post',
      webpage: 'Idea',
      audio: 'Audio',
      video: 'Video',
    };
    return map[contentType] || 'Idea';
  }
}

module.exports = ContentRouter;
