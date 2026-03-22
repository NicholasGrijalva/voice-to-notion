/**
 * Content Summarizer -- LLM-powered summarization via Groq
 *
 * Uses Llama 3.3 70B to generate structured summaries with content-type-aware
 * prompts (paper vs blog vs video vs tweet). Returns { title, keyPoints[], summary }.
 *
 * Reuses existing GROQ_API_KEY from environment.
 */

const axios = require('axios');

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

class Summarizer {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'llama-3.3-70b-versatile';
    this.timeout = options.timeout || 30000;
    this.maxInputChars = options.maxInputChars || 12000; // ~3k tokens
  }

  /**
   * Summarize content with content-type-aware prompting.
   *
   * @param {string} content - Raw text content to summarize
   * @param {string} contentType - One of: youtube, article, tweet, pdf, audio, video, idea
   * @param {Object} meta - Optional metadata (title, url, author)
   * @returns {Promise<{ title: string, keyPoints: string[], summary: string } | null>}
   */
  async summarize(content, contentType = 'article', meta = {}) {
    if (!this.apiKey) return null;
    if (!content || content.length < 100) return null;

    const truncated = content.slice(0, this.maxInputChars);
    const prompt = this.buildPrompt(truncated, contentType, meta);

    try {
      const response = await axios.post(GROQ_CHAT_URL, {
        model: this.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 800,
        temperature: 0.2
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: this.timeout
      });

      const raw = response.data.choices?.[0]?.message?.content;
      if (!raw) return null;

      const parsed = JSON.parse(raw);

      const result = {
        title: (parsed.title || meta.title || '').slice(0, 200),
        keyPoints: Array.isArray(parsed.key_points) ? parsed.key_points.slice(0, 7) : [],
        summary: parsed.summary || parsed.concise_summary || '',
        tags: Array.isArray(parsed.tags) ? parsed.tags : []
      };

      console.log(`[Summarizer] Generated summary: "${result.title}" (${result.keyPoints.length} key points)`);
      return result;

    } catch (error) {
      console.warn(`[Summarizer] Failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Build content-type-aware prompt.
   */
  buildPrompt(content, contentType, meta) {
    const typeInstructions = {
      youtube: 'This is a YouTube video transcript. Summarize the speaker\'s main argument, key points, and takeaways. Mention the speaker/channel if known.',
      article: 'This is a web article or blog post. Explain what the article is about and its main arguments.',
      tweet: 'This is a tweet or Twitter/X thread. Capture the main point, any arguments made, and notable reactions or context.',
      pdf: 'This is text extracted from a PDF document. If it appears to be a paper, explain what problem it addresses and how. If a report or document, summarize its purpose and key findings.',
      audio: 'This is an audio transcription (voice note, podcast, or recording). Summarize the main topics discussed and key points made.',
      video: 'This is a video transcription. Summarize the main content, arguments, and takeaways.',
      idea: 'This is a captured idea or note. Distill the core concept and any supporting points.',
      perplexity: 'This is content from a Perplexity AI research page. Summarize the question being answered, the key findings, and source citations if present.',
      linkedin: 'This is a LinkedIn post. Summarize the professional insight or argument being made.'
    };

    const instruction = typeInstructions[contentType] || typeInstructions.article;
    const metaContext = meta.title ? `\nOriginal title: "${meta.title}"` : '';
    const authorContext = meta.author ? `\nAuthor/Source: ${meta.author}` : '';

    return {
      system: `You are a precise summarization engine. Your output must be valid JSON matching this exact schema:
{
  "title": "Descriptive title, max 10 words",
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "summary": "Concise 50-100 word summary",
  "tags": ["tag1", "tag2"]
}

Rules:
- 3-7 key points, each a single clear sentence
- Summary should be 50-100 words, standalone (reader hasn't seen the source)
- Title should be descriptive and specific, not generic
- Only use information present in the provided content
- Do not include meta-commentary about the summarization process
- tags: pick 0-3 from ONLY these options: "knowledge management", "information synthesis", "productivity", "cognitive load", "structured thinking". Only include tags that genuinely apply. If none fit, return an empty array.`,

      user: `${instruction}${metaContext}${authorContext}

Content to summarize:
---
${content}
---

Respond with JSON only.`
    };
  }
}

module.exports = Summarizer;
