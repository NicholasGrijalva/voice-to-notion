/**
 * Platform definitions, character limits, preview formatting, and thread splitting.
 * Pure functions -- no external dependencies.
 */

const PLATFORMS = {
  twitter:  { name: 'X',        maxChars: 280,  supportsThreads: true  },
  linkedin: { name: 'LinkedIn', maxChars: 3000, supportsThreads: false },
  bluesky:  { name: 'Bluesky',  maxChars: 300,  supportsThreads: true  },
  threads:  { name: 'Threads',  maxChars: 500,  supportsThreads: true  },
  mastodon: { name: 'Mastodon', maxChars: 500,  supportsThreads: true  },
};

/**
 * Generate a preview showing character counts per platform.
 *
 * @param {string} text
 * @param {string[]} enabledPlatforms - e.g. ['twitter', 'linkedin', 'bluesky']
 * @returns {{ platforms: Object, overLimit: string[], needsThread: string[] }}
 */
function formatPreview(text, enabledPlatforms) {
  const chars = text.length;
  const platforms = {};
  const overLimit = [];
  const needsThread = [];

  for (const key of enabledPlatforms) {
    const p = PLATFORMS[key];
    if (!p) continue;
    const ok = chars <= p.maxChars;
    platforms[key] = { chars, maxChars: p.maxChars, ok };
    if (!ok) {
      overLimit.push(key);
      if (p.supportsThreads) needsThread.push(key);
    }
  }

  return { platforms, overLimit, needsThread };
}

/**
 * Split text into thread-sized posts.
 *
 * Strategy:
 * 1. Split on paragraph breaks (\n\n)
 * 2. If a paragraph exceeds maxChars, split on sentence boundaries (. )
 * 3. Greedily combine chunks into posts under maxChars
 * 4. If a single sentence exceeds maxChars, hard-break at word boundary
 *
 * @param {string} text
 * @param {number} maxChars - per-post limit (default 280)
 * @returns {string[]}
 */
function splitThread(text, maxChars = 280) {
  if (text.length <= maxChars) return [text];

  // Step 1: split into paragraphs
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  // Step 2: break long paragraphs into sentences
  const chunks = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      chunks.push(para);
    } else {
      // Split on sentence boundaries
      const sentences = para.match(/[^.!?]+[.!?]+\s*/g) || [para];
      for (const sent of sentences) {
        const trimmed = sent.trim();
        if (trimmed.length <= maxChars) {
          chunks.push(trimmed);
        } else {
          // Hard-break at word boundary
          const words = trimmed.split(/\s+/);
          let current = '';
          for (const word of words) {
            const next = current ? current + ' ' + word : word;
            if (next.length > maxChars) {
              if (current) chunks.push(current);
              current = word;
            } else {
              current = next;
            }
          }
          if (current) chunks.push(current);
        }
      }
    }
  }

  // Step 3: greedily combine chunks into posts
  const posts = [];
  let current = '';
  for (const chunk of chunks) {
    const separator = current ? '\n\n' : '';
    const combined = current + separator + chunk;
    if (combined.length <= maxChars) {
      current = combined;
    } else {
      if (current) posts.push(current);
      current = chunk;
    }
  }
  if (current) posts.push(current);

  return posts;
}

module.exports = { PLATFORMS, formatPreview, splitThread };
