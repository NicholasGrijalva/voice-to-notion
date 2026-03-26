/**
 * Sync Worker - Polls Scriberr and syncs completed transcripts to Notion
 * Handles both transcript text and audio file uploads
 */

const fs = require('fs');
const path = require('path');
const ScriberrClient = require('./scriberr');
const NotionClient = require('./notion');

// State file for tracking synced jobs
const STATE_FILE = process.env.STATE_FILE || './data/.sync-state.json';
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/audio-downloads';

class SyncWorker {
  constructor(scriberrClient, notionClient, pollInterval = 30000) {
    this.scriberr = scriberrClient;
    this.notion = notionClient;
    this.pollInterval = pollInterval;
    this.syncedJobs = new Set();
    this.failedJobs = new Map(); // Track failed jobs with retry count and next-retry time
    this.maxRetries = parseInt(process.env.MAX_SYNC_RETRIES, 10) || 0; // 0 = unlimited (exponential backoff)
    this.baseBackoffMs = pollInterval; // first retry waits 1 cycle
    this.isRunning = false;
    this.interval = null;
  }

  /**
   * Load previously synced job IDs from state file
   */
  loadState() {
    try {
      // Ensure state directory exists
      const stateDir = path.dirname(STATE_FILE);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }

      if (fs.existsSync(STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.syncedJobs = new Set(state.syncedJobs || []);

        // Load failed jobs with their retry state
        if (state.failedJobs) {
          for (const [id, val] of Object.entries(state.failedJobs)) {
            // Migrate old format (plain number) to new format ({ count, nextRetry })
            if (typeof val === 'number') {
              this.failedJobs.set(id, { count: val, nextRetry: 0 }); // retry immediately
            } else {
              this.failedJobs.set(id, val);
            }
          }
        }

        console.log(`[SyncWorker] Loaded state: ${this.syncedJobs.size} synced, ${this.failedJobs.size} failed`);
      }
    } catch (error) {
      console.warn('[SyncWorker] Could not load state:', error.message);
      this.syncedJobs = new Set();
      this.failedJobs = new Map();
    }
  }

  /**
   * Save state to file
   */
  saveState() {
    try {
      const stateDir = path.dirname(STATE_FILE);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }

      const state = {
        syncedJobs: Array.from(this.syncedJobs),
        failedJobs: Object.fromEntries(this.failedJobs),
        lastSync: new Date().toISOString()
      };

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('[SyncWorker] Error saving state:', error.message);
    }
  }

  /**
   * Ensure temp directory exists
   */
  ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
  }

  /**
   * Clean up a temp file
   */
  cleanupTempFile(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[SyncWorker] Cleaned up temp file: ${filePath}`);
      }
    } catch (error) {
      console.warn(`[SyncWorker] Could not clean up ${filePath}:`, error.message);
    }
  }

  /**
   * Main sync function - runs on each poll cycle
   */
  async sync() {
    if (!this.isRunning) return;

    const startTime = Date.now();
    console.log(`\n[SyncWorker] ═══ Sync cycle started at ${new Date().toISOString()} ═══`);

    try {
      // Fetch completed jobs from Scriberr
      const jobs = await this.scriberr.getJobs('completed');

      if (!jobs || jobs.length === 0) {
        console.log('[SyncWorker] No completed jobs found');
        return;
      }

      console.log(`[SyncWorker] Found ${jobs.length} completed job(s)`);

      // Process each job
      let synced = 0;
      let skipped = 0;
      let failed = 0;

      for (const job of jobs) {
        const jobId = job.id || job._id;

        // Skip if already synced
        if (this.syncedJobs.has(jobId)) {
          skipped++;
          continue;
        }

        // Check retry state: exponential backoff (or hard cap if MAX_SYNC_RETRIES > 0)
        const failState = this.failedJobs.get(jobId);
        if (failState) {
          if (this.maxRetries > 0 && failState.count >= this.maxRetries) {
            console.log(`[SyncWorker] Job ${jobId} exceeded retry limit (${this.maxRetries}), skipping`);
            skipped++;
            continue;
          }
          if (Date.now() < failState.nextRetry) {
            skipped++; // backoff period not elapsed yet, silently skip
            continue;
          }
        }
        const retryCount = failState?.count || 0;

        try {
          await this.syncJob(job);
          this.syncedJobs.add(jobId);
          this.failedJobs.delete(jobId);
          synced++;
          this.saveState();
          console.log(`[SyncWorker] ✓ Synced job ${jobId}`);
        } catch (error) {
          const newCount = retryCount + 1;
          const backoff = Math.min(this.baseBackoffMs * Math.pow(2, newCount - 1), 3600000); // cap at 1hr
          console.error(`[SyncWorker] ✗ Failed to sync job ${jobId} (attempt ${newCount}, next retry in ${Math.round(backoff / 1000)}s):`, error.message);
          this.failedJobs.set(jobId, { count: newCount, nextRetry: Date.now() + backoff });
          this.saveState();
          failed++;
        }
      }

      const elapsed = Date.now() - startTime;
      console.log(`[SyncWorker] ═══ Sync complete: ${synced} synced, ${skipped} skipped, ${failed} failed (${elapsed}ms) ═══\n`);

    } catch (error) {
      console.error('[SyncWorker] Sync cycle failed:', error.message);
    }
  }

  /**
   * Sync a single job to Notion
   */
  async syncJob(job) {
    const jobId = job.id || job._id;
    console.log(`[SyncWorker] Processing job ${jobId}: ${job.filename || 'unnamed'}`);

    // Fetch full transcript (getTranscript returns normalized { text, language })
    const transcript = await this.scriberr.getTranscript(jobId);
    const transcriptText = transcript.text || '';

    if (!transcriptText) {
      throw new Error(`Job ${jobId} has empty transcript (will retry)`);
    }

    // Determine source type
    const filename = job.filename || `Transcript ${jobId}`;
    const source = this.getSourceType(filename);

    // Try to download and upload audio file
    let audioFileUploadId = null;
    let tempFilePath = null;

    try {
      this.ensureTempDir();
      const audioFile = await this.scriberr.downloadAudioFile(jobId, TEMP_DIR);

      if (audioFile && audioFile.filePath) {
        tempFilePath = audioFile.filePath;

        // Upload to Notion
        audioFileUploadId = await this.notion.uploadFile(
          audioFile.filePath,
          audioFile.filename,
          audioFile.contentType
        );

        console.log(`[SyncWorker] Audio uploaded to Notion: ${audioFileUploadId}`);
      }
    } catch (error) {
      console.warn(`[SyncWorker] Could not upload audio for ${jobId}:`, error.message);
      // Continue without audio - transcript is still valuable
    }

    // Create Notion page
    try {
      const pageId = await this.notion.createTranscriptPage({
        title: this.cleanTitle(filename),
        transcript: transcriptText,
        source: source,
        sourceFilename: filename,
        audioFileUploadId: audioFileUploadId,
        metadata: {
          duration: transcript.duration || job.duration,
          language: transcript.language || job.language || 'en',
          processingTime: transcript.processing_time || job.processing_time || null,
          url: job.source_url || null
        }
      });

      console.log(`[SyncWorker] Created Notion page: ${pageId}`);
    } finally {
      // Always clean up temp file
      this.cleanupTempFile(tempFilePath);
    }
  }

  /**
   * Determine if source is Audio or Video based on filename
   */
  getSourceType(filename) {
    if (!filename) return 'Audio';
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
    const ext = path.extname(filename).toLowerCase();
    return videoExts.includes(ext) ? 'Video' : 'Audio';
  }

  /**
   * Clean up filename for use as title
   */
  cleanTitle(filename) {
    if (!filename) return `Transcript ${new Date().toISOString()}`;
    // Remove extension and clean up
    return filename
      .replace(/\.[^/.]+$/, '') // Remove extension
      .replace(/_/g, ' ')       // Replace underscores with spaces
      .replace(/-/g, ' ')       // Replace dashes with spaces
      .slice(0, 200);           // Limit length
  }

  /**
   * Start the polling loop
   */
  async start() {
    console.log('[SyncWorker] Starting...');

    // Load previous state
    this.loadState();

    // Test connections
    const scriberrOk = await this.scriberr.healthCheck();
    if (!scriberrOk) {
      console.warn('[SyncWorker] ⚠️ Scriberr health check failed - will retry');
    }

    const notionOk = await this.notion.testConnection();
    if (!notionOk) {
      console.error('[SyncWorker] ❌ Notion connection failed - check API key and database ID');
      process.exit(1);
    }

    this.isRunning = true;
    console.log(`[SyncWorker] Running with ${this.pollInterval / 1000}s poll interval`);

    // Run immediately
    await this.sync();

    // Start polling
    this.interval = setInterval(() => this.sync(), this.pollInterval);
  }

  /**
   * Stop the polling loop
   */
  stop() {
    console.log('[SyncWorker] Stopping...');
    this.isRunning = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Save final state
    this.saveState();
    console.log('[SyncWorker] Stopped');
  }
}

module.exports = SyncWorker;
