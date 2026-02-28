/**
 * YouTube Transcript Fetcher
 * Attempts to fetch existing YouTube transcripts/subtitles before falling back to Whisper
 * Uses yt-dlp --write-auto-subs as the primary method (most reliable)
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

class YouTubeTranscript {
  constructor(options = {}) {
    this.ytdlpPath = options.ytdlpPath || 'yt-dlp';
    this.outputDir = options.outputDir || '/tmp/yt-transcripts';
    this.timeout = options.timeout || 60000; // 1 min
    this.preferredLangs = options.preferredLangs || ['en', 'en-US', 'en-GB'];
    this.ensureDir(this.outputDir);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Try to fetch YouTube transcript for a URL
   * Returns null if not available (caller should fall back to Whisper)
   *
   * @param {string} url - YouTube URL
   * @returns {Promise<{text: string, language: string, source: 'manual'|'auto'} | null>}
   */
  async fetch(url) {
    if (!this.isYouTubeUrl(url)) {
      return null;
    }

    console.log(`[YTTranscript] Attempting to fetch transcript for: ${url}`);

    // Try manual subtitles first (human-made, higher quality)
    const manual = await this.fetchSubtitles(url, false);
    if (manual) {
      console.log(`[YTTranscript] Found manual subtitles (${manual.language})`);
      return { ...manual, source: 'manual' };
    }

    // Fall back to auto-generated subtitles
    const auto = await this.fetchSubtitles(url, true);
    if (auto) {
      console.log(`[YTTranscript] Found auto-generated subtitles (${auto.language})`);
      return { ...auto, source: 'auto' };
    }

    console.log(`[YTTranscript] No subtitles available for: ${url}`);
    return null;
  }

  /**
   * Download subtitles using yt-dlp
   */
  async fetchSubtitles(url, autoSubs = false) {
    const videoId = this.extractVideoId(url);
    if (!videoId) return null;

    const subPrefix = path.join(this.outputDir, videoId);
    const langList = this.preferredLangs.join(',');

    const args = [
      '--no-playlist',
      '--skip-download',
      '--sub-langs', langList,
      '--sub-format', 'vtt/srt/best',
      '--output', subPrefix,
    ];

    if (autoSubs) {
      args.push('--write-auto-subs');
    } else {
      args.push('--write-subs');
    }

    args.push(url);

    try {
      await this.exec(args);

      // Find the downloaded subtitle file
      const subFile = this.findSubtitleFile(subPrefix);
      if (!subFile) return null;

      const rawText = fs.readFileSync(subFile.path, 'utf8');
      const cleanText = this.parseSubtitles(rawText, subFile.format);

      // Clean up subtitle file
      try { fs.unlinkSync(subFile.path); } catch {}

      if (!cleanText || cleanText.length < 50) {
        return null; // Too short, probably garbage
      }

      return {
        text: cleanText,
        language: subFile.lang || 'en'
      };
    } catch (error) {
      console.log(`[YTTranscript] Subtitle fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Find downloaded subtitle file (yt-dlp adds lang and format suffixes)
   */
  findSubtitleFile(prefix) {
    const dir = path.dirname(prefix);
    const base = path.basename(prefix);

    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(base) && (f.endsWith('.vtt') || f.endsWith('.srt')));

      if (files.length === 0) return null;

      // Prefer manual subs, then pick first available
      const file = files[0];
      const format = file.endsWith('.vtt') ? 'vtt' : 'srt';

      // Extract language from filename pattern: videoId.en.vtt
      const parts = file.replace(`.${format}`, '').split('.');
      const lang = parts.length > 1 ? parts[parts.length - 1] : 'en';

      return {
        path: path.join(dir, file),
        format,
        lang
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse VTT/SRT subtitle text into clean transcript
   * Removes timestamps, formatting tags, and deduplicates lines
   */
  parseSubtitles(raw, format = 'vtt') {
    let lines = raw.split('\n');

    // Remove VTT header
    if (format === 'vtt') {
      const headerEnd = lines.findIndex(l => l.includes('-->'));
      if (headerEnd > 0) {
        lines = lines.slice(headerEnd);
      }
    }

    const textLines = [];
    let prevLine = '';

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines, timestamps, sequence numbers, and VTT headers
      if (!trimmed) continue;
      if (trimmed.includes('-->')) continue;
      if (/^\d+$/.test(trimmed)) continue;
      if (trimmed.startsWith('WEBVTT')) continue;
      if (trimmed.startsWith('Kind:') || trimmed.startsWith('Language:')) continue;
      if (trimmed.startsWith('NOTE')) continue;

      // Remove HTML/VTT formatting tags
      let clean = trimmed
        .replace(/<[^>]+>/g, '')     // HTML tags
        .replace(/\{[^}]+\}/g, '')   // SSA/ASS tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

      if (!clean) continue;

      // Deduplicate consecutive identical lines (common in auto-subs)
      if (clean === prevLine) continue;
      prevLine = clean;

      textLines.push(clean);
    }

    return textLines.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract YouTube video ID from URL
   */
  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  /**
   * Check if URL is a YouTube URL
   */
  isYouTubeUrl(url) {
    return /youtube\.com|youtu\.be/i.test(url);
  }

  exec(args) {
    return new Promise((resolve, reject) => {
      execFile(this.ytdlpPath, args, {
        timeout: this.timeout,
        maxBuffer: 5 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`yt-dlp subs failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }
}

module.exports = YouTubeTranscript;
