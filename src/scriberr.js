/**
 * Scriberr API Client (v1 API — JWT auth)
 * Handles communication with self-hosted Scriberr transcription server
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

class ScriberrClient {
  constructor(apiUrl, username, password) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.accessToken = null;
    this.refreshToken = null;

    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000
    });

    // Attach token to every request
    this.client.interceptors.request.use((config) => {
      if (this.accessToken) {
        config.headers['Authorization'] = `Bearer ${this.accessToken}`;
      }
      return config;
    });

    // Auto-refresh on 401
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const original = error.config;
        if (error.response?.status === 401 && !original._retried) {
          original._retried = true;
          await this.login();
          return this.client(original);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Authenticate and store JWT tokens
   */
  async login() {
    try {
      const response = await axios.post(`${this.apiUrl}/api/v1/auth/login`, {
        username: this.username,
        password: this.password
      });

      this.accessToken = response.data.token || response.data.access_token;
      this.refreshToken = response.data.refresh_token || null;

      console.log('[Scriberr] Authenticated successfully');
      return true;
    } catch (error) {
      console.error('[Scriberr] Login failed:', error.response?.data?.error || error.message);
      throw new Error(`Scriberr login failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Register a new account (first-time setup only)
   */
  async register() {
    try {
      const response = await axios.post(`${this.apiUrl}/api/v1/auth/register`, {
        username: this.username,
        password: this.password,
        confirmPassword: this.password
      });
      console.log('[Scriberr] Registered successfully');
      // Login after registration
      await this.login();
      return true;
    } catch (error) {
      if (error.response?.data?.error?.includes('already exists')) {
        console.log('[Scriberr] Admin already exists, logging in...');
        return this.login();
      }
      throw error;
    }
  }

  /**
   * Initialize — register if needed, then login
   */
  async init() {
    try {
      // Check if registration is open (first-time setup)
      const regStatus = await axios.get(`${this.apiUrl}/api/v1/auth/registration-status`);
      if (regStatus.data.registration_enabled !== false) {
        return this.register();
      }
    } catch {
      // Registration check failed, try login directly
    }

    // Try to register first (handles fresh installs), fall back to login
    try {
      await this.register();
    } catch {
      await this.login();
    }
  }

  /**
   * Get all transcription jobs
   * @param {string|null} status - Filter by status (applied client-side)
   * @returns {Promise<Array>} List of jobs
   */
  async getJobs(status = null) {
    try {
      const response = await this.client.get('/api/v1/transcription/list');
      let jobs = response.data || [];

      // Normalize to array
      if (!Array.isArray(jobs)) {
        jobs = jobs.jobs || jobs.transcriptions || jobs.items || jobs.data || [];
      }

      // Client-side status filter
      if (status && Array.isArray(jobs)) {
        jobs = jobs.filter(j => {
          const jobStatus = (j.status || j.state || '').toLowerCase();
          return jobStatus === status.toLowerCase();
        });
      }

      return jobs;
    } catch (error) {
      console.error('[Scriberr] Error fetching jobs:', error.message);
      throw error;
    }
  }

  /**
   * Get specific job details
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Job details
   */
  async getJob(jobId) {
    try {
      const response = await this.client.get(`/api/v1/transcription/${jobId}`);
      return response.data;
    } catch (error) {
      console.error(`[Scriberr] Error fetching job ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get job status
   * @param {string} jobId - Job ID
   * @returns {Promise<string>} Status string
   */
  async getJobStatus(jobId) {
    try {
      const response = await this.client.get(`/api/v1/transcription/${jobId}/status`);
      return response.data.status || response.data.state || response.data;
    } catch (error) {
      // Fall back to full job fetch
      const job = await this.getJob(jobId);
      return job.status || job.state;
    }
  }

  /**
   * Get transcript for completed job
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Transcript data with text, segments, etc.
   */
  async getTranscript(jobId) {
    try {
      const response = await this.client.get(`/api/v1/transcription/${jobId}/transcript`);
      const data = response.data;

      // Normalize: Scriberr returns { transcript: { text, language, segments, ... } }
      const transcriptObj = data.transcript || data;
      const text = typeof transcriptObj === 'string' ? transcriptObj : (transcriptObj?.text || '');
      const language = transcriptObj?.language || data.language || 'en';

      return { text, language };
    } catch (error) {
      console.error(`[Scriberr] Error fetching transcript ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Download the audio file for a job
   * @param {string} jobId - Job ID
   * @param {string} outputDir - Directory to save the file
   * @returns {Promise<{filePath: string, filename: string, contentType: string}|null>}
   */
  async downloadAudioFile(jobId, outputDir = '/tmp') {
    try {
      const job = await this.getJob(jobId);
      const filename = job.filename || job.title || `audio_${jobId}`;

      const response = await this.client.get(`/api/v1/transcription/${jobId}/audio`, {
        responseType: 'arraybuffer',
        timeout: 120000
      });

      const contentType = response.headers['content-type'] || 'audio/mpeg';
      let ext = path.extname(filename);
      if (!ext) {
        const typeMap = {
          'audio/mpeg': '.mp3',
          'audio/mp4': '.m4a',
          'audio/x-m4a': '.m4a',
          'audio/wav': '.wav',
          'audio/webm': '.webm',
          'video/mp4': '.mp4',
          'video/quicktime': '.mov'
        };
        ext = typeMap[contentType] || '.audio';
      }

      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalFilename = path.extname(safeFilename) ? safeFilename : safeFilename + ext;
      const outputPath = path.join(outputDir, finalFilename);

      fs.writeFileSync(outputPath, Buffer.from(response.data));

      console.log(`[Scriberr] Downloaded audio to ${outputPath}`);
      return { filePath: outputPath, filename: finalFilename, contentType };
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`[Scriberr] No audio file available for job ${jobId}`);
        return null;
      }
      console.error(`[Scriberr] Error downloading audio for ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Submit a local audio file for transcription
   * @param {string} filePath - Path to audio file
   * @param {string} filename - Original filename
   * @param {string} language - Language code (default: 'en')
   * @returns {Promise<string>} Job ID
   */
  async submitFile(filePath, filename, language = 'en') {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('audio', fs.createReadStream(filePath), { filename });
    form.append('language', language);

    try {
      const response = await this.client.post('/api/v1/transcription/submit', form, {
        headers: form.getHeaders(),
        timeout: 300000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const jobId = response.data?.id;
      if (!jobId) {
        throw new Error(`Scriberr did not return a job ID: ${JSON.stringify(response.data)}`);
      }

      console.log(`[Scriberr] Submitted file ${filename}, job ID: ${jobId}`);
      return jobId;
    } catch (error) {
      console.error('[Scriberr] Submit failed:', error.response?.status, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Health check
   * @returns {Promise<boolean>} True if Scriberr is healthy
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

module.exports = ScriberrClient;
