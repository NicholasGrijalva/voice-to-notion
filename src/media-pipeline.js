/**
 * Media Pipeline - Orchestrates media ingestion (URLs and local files)
 *
 * URL flow (.txt/.json/.url files):
 * 1. Watch inbox_media/ for URL files
 * 2. Download media via yt-dlp
 * 3. Try YouTube transcript first, fall back to Whisper
 * 4. Create Notion page with transcript + audio
 *
 * Local file flow (.mp3/.mp4/.mov/etc):
 * 1. Watch inbox_media/ for media files
 * 2. Extract audio from video via ffmpeg (if needed)
 * 3. Submit to Scriberr for Whisper transcription
 * 4. Create Notion page with transcript + audio
 */

const fs = require('fs');
const path = require('path');
const MediaDownloader = require('./media-downloader');
const AudioExtractor = require('./audio-extractor');
const YouTubeTranscript = require('./yt-transcript');

class MediaPipeline {
  constructor({ notionClient, scriberrClient, groqTranscriber, config = {} }) {
    this.notion = notionClient;
    this.scriberr = scriberrClient;
    this.groq = groqTranscriber || null;

    // Directories
    this.inboxDir = config.inboxDir || '/app/data/inbox_media';
    this.processedDir = config.processedDir || '/app/data/processed';
    this.tempDir = config.tempDir || '/tmp/media-pipeline';

    // Settings
    this.pollInterval = config.pollInterval || 15000; // 15s for file watching
    this.audioFormat = config.audioFormat || 'mp3';
    this.skipTranscript = config.skipTranscript || false;

    // Components
    this.downloader = new MediaDownloader({
      outputDir: path.join(this.tempDir, 'downloads')
    });

    this.extractor = new AudioExtractor({
      outputDir: path.join(this.tempDir, 'extracted')
    });

    this.ytTranscript = new YouTubeTranscript({
      outputDir: path.join(this.tempDir, 'transcripts')
    });

    this.isRunning = false;
    this.interval = null;
    this.processing = new Set(); // Track files currently being processed
  }

  /**
   * Ensure all directories exist
   */
  ensureDirs() {
    for (const dir of [this.inboxDir, this.processedDir, this.tempDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Start the media pipeline polling loop
   */
  async start() {
    console.log('[MediaPipeline] Starting...');
    console.log(`[MediaPipeline] Inbox: ${this.inboxDir}`);
    console.log(`[MediaPipeline] Processed: ${this.processedDir}`);

    this.ensureDirs();
    this.isRunning = true;

    // Process any existing files immediately
    await this.scan();

    // Start polling
    this.interval = setInterval(() => this.scan(), this.pollInterval);
    console.log(`[MediaPipeline] Running with ${this.pollInterval / 1000}s poll interval`);
  }

  /**
   * Stop the pipeline
   */
  stop() {
    console.log('[MediaPipeline] Stopping...');
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // Media file extensions recognized for direct ingestion
  static MEDIA_EXTS = /\.(mp3|mp4|m4a|mov|wav|flac|ogg|opus|webm|mkv|avi|m4v|aac|wma)$/i;
  static URL_EXTS = /\.(txt|json|url)$/i;

  /**
   * Scan inbox directory for URL files and media files
   */
  async scan() {
    if (!this.isRunning) return;

    try {
      const files = fs.readdirSync(this.inboxDir)
        .filter(f => MediaPipeline.URL_EXTS.test(f) || MediaPipeline.MEDIA_EXTS.test(f))
        .filter(f => !f.startsWith('.'))
        .filter(f => !this.processing.has(f));

      if (files.length === 0) return;

      console.log(`[MediaPipeline] Found ${files.length} file(s) in inbox`);

      for (const file of files) {
        if (!this.isRunning) break;
        this.processing.add(file);

        try {
          await this.processFile(file);
          // Move to processed
          this.moveToProcessed(file);
          console.log(`[MediaPipeline] ✓ Processed: ${file}`);
        } catch (error) {
          console.error(`[MediaPipeline] ✗ Failed to process ${file}:`, error.message);
          // Move to processed with error suffix so it doesn't retry forever
          this.moveToProcessed(file, true);
        } finally {
          this.processing.delete(file);
        }
      }
    } catch (error) {
      console.error('[MediaPipeline] Scan error:', error.message);
    }
  }

  /**
   * Process a single file from inbox
   */
  async processFile(filename) {
    const filePath = path.join(this.inboxDir, filename);

    // Route: media file -> direct ingestion, URL file -> URL pipeline
    if (MediaPipeline.MEDIA_EXTS.test(filename)) {
      await this.ingestFile(filePath);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8').trim();

    if (filename.endsWith('.json')) {
      const jobs = JSON.parse(content);
      const items = Array.isArray(jobs) ? jobs : [jobs];
      for (const item of items) {
        await this.ingest(item.url, item.options || {});
      }
    } else {
      // .txt or .url — one URL per line
      const urls = content.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.startsWith('http'));

      for (const url of urls) {
        await this.ingest(url);
      }
    }
  }

  /**
   * Ingest a single URL through the full pipeline
   *
   * @param {string} url - URL to download and process
   * @param {Object} opts - Override options
   * @param {boolean} opts.skipTranscript - Skip YouTube transcript fetch
   * @param {boolean} opts.audioOnly - Download audio only (default: true)
   * @param {string[]} opts.tags - Tags to add to Notion page
   */
  async ingest(url, opts = {}) {
    const startTime = Date.now();
    console.log(`\n[MediaPipeline] ═══ Ingesting: ${url} ═══`);

    let downloadResult = null;
    let transcript = null;
    let audioResult = null;
    let audioFileUploadId = null;

    try {
      // Step 1: Try YouTube transcript first (fast, avoids downloading)
      if (!opts.skipTranscript && !this.skipTranscript) {
        transcript = await this.ytTranscript.fetch(url);
        if (transcript) {
          console.log(`[MediaPipeline] Got ${transcript.source} transcript (${transcript.text.length} chars)`);
        }
      }

      // Step 2: Download media
      downloadResult = await this.downloader.download(url, {
        audioOnly: opts.audioOnly !== false,
        format: this.audioFormat
      });

      // Step 3: If no transcript yet, we need Whisper transcription
      if (!transcript) {
        // Check if download result is audio or video
        const isAudio = await this.extractor.isAudioOnly(downloadResult.filePath)
          .catch(() => downloadResult.filePath.endsWith(`.${this.audioFormat}`));

        let audioPath = downloadResult.filePath;

        // Extract audio from video if needed
        if (!isAudio) {
          audioResult = await this.extractor.extract(downloadResult.filePath, {
            format: this.audioFormat
          });
          audioPath = audioResult.filePath;
        }

        // Submit to Scriberr for transcription
        if (this.scriberr) {
          console.log(`[MediaPipeline] Submitting to Scriberr for transcription...`);
          transcript = await this.transcribeViaScriberr(audioPath, downloadResult.filename);
        } else {
          console.warn(`[MediaPipeline] No Scriberr client — skipping transcription`);
          transcript = { text: '[Transcription not available — no Scriberr configured]', language: 'en' };
        }
      }

      // Step 4: Upload audio to Notion
      const audioPath = audioResult?.filePath || downloadResult.filePath;
      try {
        audioFileUploadId = await this.notion.uploadFile(
          audioPath,
          `${downloadResult.title}.${this.audioFormat}`,
          this.extractor.getMimeType(this.audioFormat)
        );
      } catch (error) {
        console.warn(`[MediaPipeline] Audio upload to Notion failed:`, error.message);
      }

      // Step 5: Create Notion page
      const processingTime = (Date.now() - startTime) / 1000;
      const sourceUrl = downloadResult.sourceUrl || url;
      const pageId = await this.notion.createTranscriptPage({
        title: downloadResult.title,
        transcript: transcript.text,
        source: this.getSourceCategory(downloadResult),
        sourceFilename: downloadResult.filename,
        sourceRef: sourceUrl,
        audioFileUploadId,
        metadata: {
          duration: downloadResult.duration,
          language: transcript.language || 'en',
          processingTime: Math.round(processingTime),
          url: sourceUrl
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
      console.log(`[MediaPipeline] ═══ Complete: ${downloadResult.title} (${elapsed}s) → ${notionUrl} ═══\n`);

      return { pageId, notionUrl, title: downloadResult.title, url };

    } finally {
      // Cleanup temp files
      this.cleanupTemp(downloadResult?.filePath);
      this.cleanupTemp(audioResult?.filePath);
    }
  }

  /**
   * Ingest a local media file (mp3, mp4, mov, wav, etc.)
   *
   * @param {string} filePath - Absolute path to the media file
   * @param {Object} opts - Optional overrides
   * @param {string} opts.title - Override title (instead of deriving from filename)
   * @returns {Promise<{pageId: string, title: string}>}
   */
  async ingestFile(filePath, opts = {}) {
    const startTime = Date.now();
    const filename = path.basename(filePath);
    let title = opts.title || filename.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
    console.log(`\n[MediaPipeline] ═══ Ingesting file: ${filename} ═══`);

    let audioPath = null;
    let extractedPath = null;
    let audioFileUploadId = null;

    try {
      // Step 1: Determine if audio or video
      const isAudio = await this.extractor.isAudioOnly(filePath)
        .catch(() => /\.(mp3|m4a|wav|flac|ogg|opus|aac|wma)$/i.test(filename));

      if (isAudio) {
        console.log(`[MediaPipeline] Audio file detected`);
        // Convert to target format if different
        const ext = path.extname(filename).slice(1).toLowerCase();
        if (ext !== this.audioFormat) {
          const converted = await this.extractor.convert(filePath, { format: this.audioFormat });
          audioPath = converted.filePath;
          extractedPath = converted.filePath;
        } else {
          audioPath = filePath;
        }
      } else {
        console.log(`[MediaPipeline] Video file detected, extracting audio...`);
        const extracted = await this.extractor.extract(filePath, { format: this.audioFormat });
        audioPath = extracted.filePath;
        extractedPath = extracted.filePath;
      }

      // Step 2: Transcribe via Scriberr
      let transcript;
      if (this.scriberr) {
        console.log(`[MediaPipeline] Submitting to Scriberr for transcription...`);
        transcript = await this.transcribeViaScriberr(audioPath, filename);
      } else {
        transcript = { text: '[Transcription not available — no Scriberr configured]', language: 'en' };
      }

      // Step 3: Generate title from transcript if we don't have a good one
      if (this.groq && transcript.text.length > 50) {
        try {
          const generatedTitle = await this.groq.generateTitle(transcript.text);
          if (generatedTitle) title = generatedTitle;
        } catch (e) {
          // Non-fatal, keep existing title
        }
      }

      // Step 4: Upload audio to Notion
      try {
        audioFileUploadId = await this.notion.uploadFile(
          audioPath,
          `${title}.${this.audioFormat}`,
          this.extractor.getMimeType(this.audioFormat)
        );
      } catch (error) {
        console.warn(`[MediaPipeline] Audio upload to Notion failed:`, error.message);
      }

      // Step 5: Create Notion page
      const processingTime = (Date.now() - startTime) / 1000;
      const source = isAudio ? 'Audio' : 'Video';
      const pageId = await this.notion.createTranscriptPage({
        title,
        transcript: transcript.text,
        source,
        sourceFilename: filename,
        sourceRef: filePath,
        audioFileUploadId,
        metadata: {
          duration: null,
          language: transcript.language || 'en',
          processingTime: Math.round(processingTime),
          url: null
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
      console.log(`[MediaPipeline] ═══ Complete: ${title} (${elapsed}s) → ${notionUrl} ═══\n`);

      return { pageId, notionUrl, title };

    } finally {
      // Only clean up extracted/converted temp files, not the original inbox file
      this.cleanupTemp(extractedPath);
    }
  }

  /**
   * Transcribe audio — tries Groq first (fast cloud), falls back to Scriberr (local)
   */
  async transcribeViaScriberr(audioPath, filename) {
    // Try Groq first if configured
    if (this.groq) {
      try {
        return await this.groq.transcribe(audioPath);
      } catch (error) {
        console.warn(`[MediaPipeline] Groq failed, falling back to Scriberr: ${error.message}`);
      }
    }

    // Fall back to local Scriberr
    const jobId = await this.scriberr.submitFile(audioPath, filename);
    console.log(`[MediaPipeline] Scriberr job created: ${jobId}`);

    // Poll for completion (max 30 minutes)
    const maxWait = 30 * 60 * 1000;
    const pollInterval = 10000; // 10s
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await this.sleep(pollInterval);

      const job = await this.scriberr.getJob(jobId);
      const status = job?.status || job?.state;

      if (status === 'completed' || status === 'done') {
        const transcript = await this.scriberr.getTranscript(jobId);
        return {
          text: transcript.text || '',
          language: transcript.language || 'en'
        };
      }

      if (status === 'failed' || status === 'error') {
        throw new Error(`Scriberr transcription failed for job ${jobId}`);
      }

      console.log(`[MediaPipeline] Waiting for Scriberr (${status})...`);
    }

    throw new Error(`Scriberr transcription timed out after ${maxWait / 1000}s`);
  }

  /**
   * Determine Notion source category
   */
  getSourceCategory(downloadResult) {
    if (downloadResult.sourceType === 'youtube') return 'YouTube';
    const videoTypes = ['vimeo', 'twitch', 'tiktok', 'direct_video'];
    if (videoTypes.includes(downloadResult.sourceType)) return 'Video';
    return 'Audio';
  }

  /**
   * Move file from inbox to processed
   */
  moveToProcessed(filename, failed = false) {
    try {
      const src = path.join(this.inboxDir, filename);
      const suffix = failed ? '.failed' : '';
      const dest = path.join(this.processedDir, `${filename}${suffix}`);

      if (fs.existsSync(src)) {
        // Use copy+delete instead of rename to handle cross-device mounts
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      }
    } catch (error) {
      console.warn(`[MediaPipeline] Could not move ${filename}:`, error.message);
    }
  }

  cleanupTemp(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = MediaPipeline;
