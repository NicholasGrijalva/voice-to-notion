/**
 * Groq Whisper API Client
 * Cloud transcription fallback — ~164x real-time speed
 *
 * Free tier: 8 hours of audio/day, 25MB file limit
 * API docs: https://console.groq.com/docs/speech-to-text
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB limit

class GroqTranscriber {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'whisper-large-v3-turbo';
    this.timeout = options.timeout || 120000;
  }

  /**
   * Transcribe an audio file via Groq's Whisper API
   *
   * @param {string} filePath - Path to audio file
   * @param {string} language - Language code (default: 'en')
   * @returns {Promise<{text: string, language: string}>}
   * @throws {Error} If file too large or API fails
   */
  async transcribe(filePath, language = 'en') {
    const fileSize = fs.statSync(filePath).size;

    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(`File too large for Groq (${(fileSize / 1024 / 1024).toFixed(1)}MB > 25MB limit)`);
    }

    const filename = path.basename(filePath);
    console.log(`[Groq] Transcribing: ${filename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename });
    form.append('model', this.model);
    form.append('language', language);
    form.append('response_format', 'verbose_json');

    const startTime = Date.now();

    try {
      const response = await axios.post(GROQ_API_URL, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: this.timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const text = response.data?.text || '';
      const detectedLang = response.data?.language || language;

      console.log(`[Groq] Done in ${elapsed}s (${text.length} chars, lang: ${detectedLang})`);

      return { text, language: detectedLang };
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.response?.data || error.message || 'unknown error';
      throw new Error(`Groq API error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
    }
  }
}

module.exports = GroqTranscriber;
