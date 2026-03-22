/**
 * Media Downloader - yt-dlp wrapper for downloading videos/podcasts from URLs
 * Supports YouTube, podcast feeds, and any yt-dlp compatible source
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

class MediaDownloader {
  constructor(options = {}) {
    this.outputDir = options.outputDir || '/tmp/media-downloads';
    this.ytdlpPath = options.ytdlpPath || 'yt-dlp';
    this.maxFileSize = options.maxFileSize || '500M';
    this.timeout = options.timeout || 600000; // 10 min default
    this.ensureDir(this.outputDir);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Download media from a URL using yt-dlp
   * Returns metadata + path to downloaded file
   *
   * @param {string} url - URL to download from
   * @param {Object} opts
   * @param {boolean} opts.audioOnly - Extract audio only (default: true)
   * @param {string} opts.format - Audio format: mp3, m4a, wav (default: mp3)
   * @param {string} opts.quality - Audio quality: 0 (best) - 9 (worst) (default: 0)
   * @returns {Promise<{filePath: string, filename: string, title: string, duration: number, url: string, sourceType: string}>}
   */
  async download(url, opts = {}) {
    const {
      audioOnly = true,
      format = 'mp3',
      quality = '0'
    } = opts;

    // Generate a unique output template
    const outputTemplate = path.join(this.outputDir, '%(id)s.%(ext)s');

    const args = [
      '--no-playlist',           // Single video only (no playlist expansion)
      '--max-filesize', this.maxFileSize,
      '--no-overwrites',
      '--output', outputTemplate,
      '--print-json',            // Output JSON metadata to stdout
      '--no-simulate',           // Actually download (--print-json implies simulate otherwise)
      '--restrict-filenames',    // Safe filenames
      '--impersonate', 'chrome',  // Bypass Cloudflare anti-bot
    ];

    if (audioOnly) {
      args.push(
        '--extract-audio',
        '--audio-format', format,
        '--audio-quality', quality,
      );
    }

    args.push(url);

    console.log(`[MediaDownloader] Downloading: ${url}`);
    console.log(`[MediaDownloader] Audio only: ${audioOnly}, Format: ${format}`);

    const result = await this.exec(args);
    const metadata = JSON.parse(result.stdout);

    // yt-dlp with --extract-audio changes the extension
    const expectedExt = audioOnly ? format : (metadata.ext || 'mp4');
    const filePath = path.join(this.outputDir, `${metadata.id}.${expectedExt}`);

    // Verify file exists
    if (!fs.existsSync(filePath)) {
      // Try the original extension path
      const altPath = path.join(this.outputDir, `${metadata.id}.${metadata.ext}`);
      if (fs.existsSync(altPath)) {
        return this.buildResult(altPath, metadata, url);
      }
      // Search for any file matching the ID
      const files = fs.readdirSync(this.outputDir).filter(f => f.startsWith(metadata.id));
      if (files.length > 0) {
        return this.buildResult(path.join(this.outputDir, files[0]), metadata, url);
      }
      throw new Error(`Downloaded file not found at ${filePath}`);
    }

    return this.buildResult(filePath, metadata, url);
  }

  buildResult(filePath, metadata, url) {
    const fileSize = fs.statSync(filePath).size;
    console.log(`[MediaDownloader] Downloaded: ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    return {
      filePath,
      filename: path.basename(filePath),
      title: metadata.title || metadata.fulltitle || 'Untitled',
      duration: metadata.duration || null,
      url: url,
      sourceUrl: metadata.webpage_url || url,
      sourceType: this.detectSourceType(url),
      uploader: metadata.uploader || metadata.channel || null,
      description: metadata.description ? metadata.description.slice(0, 500) : null,
      fileSize
    };
  }

  /**
   * Get video/audio metadata without downloading
   */
  async getMetadata(url) {
    const args = [
      '--no-playlist',
      '--dump-json',
      '--no-download',
      url
    ];

    const result = await this.exec(args);
    return JSON.parse(result.stdout);
  }

  /**
   * Check if subtitles/transcripts are available
   */
  async listSubtitles(url) {
    const args = [
      '--no-playlist',
      '--list-subs',
      '--skip-download',
      url
    ];

    try {
      const result = await this.exec(args);
      return result.stdout;
    } catch {
      return null;
    }
  }

  /**
   * Detect source type from URL
   */
  detectSourceType(url) {
    if (!url) return 'unknown';
    const u = url.toLowerCase();
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('spotify.com')) return 'spotify';
    if (u.includes('podcasts.apple.com')) return 'apple_podcast';
    if (u.includes('soundcloud.com')) return 'soundcloud';
    if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
    if (u.includes('tiktok.com')) return 'tiktok';
    if (u.includes('vimeo.com')) return 'vimeo';
    if (u.includes('twitch.tv')) return 'twitch';
    if (u.match(/\.(mp3|m4a|wav|ogg|flac)$/)) return 'direct_audio';
    if (u.match(/\.(mp4|mkv|webm|mov)$/)) return 'direct_video';
    return 'other';
  }

  /**
   * Execute yt-dlp command
   */
  exec(args) {
    return new Promise((resolve, reject) => {
      const proc = execFile(this.ytdlpPath, args, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB stdout buffer
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[MediaDownloader] yt-dlp error:`, stderr || error.message);
          reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }
}

module.exports = MediaDownloader;
