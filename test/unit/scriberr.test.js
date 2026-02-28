const { describe, it, expect, vi, beforeEach } = require('vitest') || global;

// Mock dependencies
vi.mock('fs');
vi.mock('axios');
vi.mock('form-data');

const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const ScriberrClient = require('../../src/scriberr');

describe('ScriberrClient', () => {
  let client;
  let mockAxiosClient;
  let requestInterceptor;
  let responseInterceptors;

  beforeEach(() => {
    vi.clearAllMocks();

    // Capture interceptors when axios.create is called
    requestInterceptor = null;
    responseInterceptors = { onFulfilled: null, onRejected: null };

    mockAxiosClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      interceptors: {
        request: {
          use: vi.fn((fn) => { requestInterceptor = fn; }),
        },
        response: {
          use: vi.fn((onFulfilled, onRejected) => {
            responseInterceptors.onFulfilled = onFulfilled;
            responseInterceptors.onRejected = onRejected;
          }),
        },
      },
    };

    axios.create.mockReturnValue(mockAxiosClient);

    client = new ScriberrClient('http://localhost:8080/', 'admin', 'password123');
  });

  describe('constructor', () => {
    it('should strip trailing slash from apiUrl', () => {
      expect(client.apiUrl).toBe('http://localhost:8080');
    });

    it('should store credentials', () => {
      expect(client.username).toBe('admin');
      expect(client.password).toBe('password123');
    });

    it('should create axios client with baseURL and timeout', () => {
      expect(axios.create).toHaveBeenCalledWith({
        baseURL: 'http://localhost:8080',
        timeout: 30000,
      });
    });

    it('should configure request interceptor', () => {
      expect(mockAxiosClient.interceptors.request.use).toHaveBeenCalledTimes(1);
    });

    it('should configure response interceptor', () => {
      expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalledTimes(1);
    });
  });

  describe('request interceptor', () => {
    it('should add Authorization header when accessToken is set', () => {
      client.accessToken = 'my-token';
      const config = { headers: {} };

      const result = requestInterceptor(config);

      expect(result.headers['Authorization']).toBe('Bearer my-token');
    });

    it('should not add Authorization header when accessToken is null', () => {
      const config = { headers: {} };

      const result = requestInterceptor(config);

      expect(result.headers['Authorization']).toBeUndefined();
    });
  });

  describe('response interceptor', () => {
    it('should pass through successful responses', () => {
      const response = { data: 'ok', status: 200 };
      const result = responseInterceptors.onFulfilled(response);
      expect(result).toBe(response);
    });

    it('should call login and retry on first 401', async () => {
      const loginSpy = vi.spyOn(client, 'login').mockResolvedValue(true);
      const originalConfig = { url: '/test', _retried: undefined };

      const error = {
        response: { status: 401 },
        config: originalConfig,
      };

      mockAxiosClient.mockImplementation = vi.fn();

      // The interceptor calls this.client(original) to retry
      // We need to mock the client itself as a callable
      const retryResponse = { data: 'retried', status: 200 };

      // Mock the retry by making mockAxiosClient callable
      // In the real code, this.client is the axios instance which is callable
      // We simulate by checking that login was called and _retried was set
      await responseInterceptors.onRejected(error).catch(() => {});

      expect(loginSpy).toHaveBeenCalled();
      expect(originalConfig._retried).toBe(true);
    });

    it('should not retry on second 401 (prevents infinite loop)', async () => {
      const loginSpy = vi.spyOn(client, 'login');
      const error = {
        response: { status: 401 },
        config: { _retried: true },
      };

      await expect(responseInterceptors.onRejected(error))
        .rejects.toBe(error);

      expect(loginSpy).not.toHaveBeenCalled();
    });

    it('should reject non-401 errors unchanged', async () => {
      const error = {
        response: { status: 500 },
        config: {},
      };

      await expect(responseInterceptors.onRejected(error))
        .rejects.toBe(error);
    });
  });

  describe('login()', () => {
    it('should POST credentials to /api/v1/auth/login', async () => {
      axios.post.mockResolvedValue({
        data: { token: 'new-token', refresh_token: 'refresh' },
      });

      await client.login();

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/login',
        { username: 'admin', password: 'password123' }
      );
    });

    it('should store access token from response.data.token', async () => {
      axios.post.mockResolvedValue({
        data: { token: 'jwt-token-123' },
      });

      await client.login();

      expect(client.accessToken).toBe('jwt-token-123');
    });

    it('should store access token from response.data.access_token', async () => {
      axios.post.mockResolvedValue({
        data: { access_token: 'alt-token-456' },
      });

      await client.login();

      expect(client.accessToken).toBe('alt-token-456');
    });

    it('should store refresh_token when present', async () => {
      axios.post.mockResolvedValue({
        data: { token: 'tok', refresh_token: 'refresh-tok' },
      });

      await client.login();

      expect(client.refreshToken).toBe('refresh-tok');
    });

    it('should throw with descriptive message on login failure', async () => {
      axios.post.mockRejectedValue({
        response: { data: { error: 'Invalid credentials' } },
        message: 'Request failed',
      });

      await expect(client.login())
        .rejects.toThrow('Scriberr login failed: Invalid credentials');
    });
  });

  describe('register()', () => {
    it('should POST credentials with confirmPassword', async () => {
      axios.post.mockResolvedValueOnce({ data: {} }); // register
      axios.post.mockResolvedValueOnce({ data: { token: 'tok' } }); // login

      await client.register();

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/register',
        { username: 'admin', password: 'password123', confirmPassword: 'password123' }
      );
    });

    it('should call login() after successful registration', async () => {
      axios.post.mockResolvedValueOnce({ data: {} }); // register
      const loginSpy = vi.spyOn(client, 'login').mockResolvedValue(true);

      await client.register();

      expect(loginSpy).toHaveBeenCalled();
    });

    it('should fall back to login when "already exists" error', async () => {
      axios.post.mockRejectedValueOnce({
        response: { data: { error: 'Admin already exists' } },
      });

      const loginSpy = vi.spyOn(client, 'login').mockResolvedValue(true);

      await client.register();

      expect(loginSpy).toHaveBeenCalled();
    });

    it('should rethrow non-"already exists" errors', async () => {
      const error = new Error('Network error');
      error.response = { data: { error: 'Server crashed' } };
      axios.post.mockRejectedValue(error);

      await expect(client.register()).rejects.toThrow();
    });
  });

  describe('init()', () => {
    it('should check registration status endpoint first', async () => {
      axios.get.mockResolvedValue({ data: { registration_enabled: true } });
      vi.spyOn(client, 'register').mockResolvedValue(true);

      await client.init();

      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/registration-status'
      );
    });

    it('should call register when registration is enabled', async () => {
      axios.get.mockResolvedValue({ data: { registration_enabled: true } });
      const registerSpy = vi.spyOn(client, 'register').mockResolvedValue(true);

      await client.init();

      expect(registerSpy).toHaveBeenCalled();
    });

    it('should try register then fall back to login when registration check fails', async () => {
      axios.get.mockRejectedValue(new Error('endpoint not found'));
      const registerSpy = vi.spyOn(client, 'register').mockRejectedValue(new Error('failed'));
      const loginSpy = vi.spyOn(client, 'login').mockResolvedValue(true);

      await client.init();

      expect(registerSpy).toHaveBeenCalled();
      expect(loginSpy).toHaveBeenCalled();
    });
  });

  describe('getJobs()', () => {
    it('should GET /api/v1/transcription/list', async () => {
      mockAxiosClient.get.mockResolvedValue({ data: [] });

      await client.getJobs();

      expect(mockAxiosClient.get).toHaveBeenCalledWith('/api/v1/transcription/list');
    });

    it('should normalize response with .jobs key', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { jobs: [{ id: '1', status: 'completed' }] },
      });

      const jobs = await client.getJobs();
      expect(jobs).toHaveLength(1);
    });

    it('should normalize response with .transcriptions key', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { transcriptions: [{ id: '1' }] },
      });

      const jobs = await client.getJobs();
      expect(jobs).toHaveLength(1);
    });

    it('should normalize response with .items key', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { items: [{ id: '1' }, { id: '2' }] },
      });

      const jobs = await client.getJobs();
      expect(jobs).toHaveLength(2);
    });

    it('should normalize response with .data key', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { data: [{ id: '1' }] },
      });

      const jobs = await client.getJobs();
      expect(jobs).toHaveLength(1);
    });

    it('should return empty array when no recognized keys', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { unknownKey: 'value' },
      });

      const jobs = await client.getJobs();
      expect(jobs).toEqual([]);
    });

    it('should filter jobs by status when provided', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'pending' },
          { id: '3', status: 'completed' },
        ],
      });

      const jobs = await client.getJobs('completed');
      expect(jobs).toHaveLength(2);
      expect(jobs.every(j => j.status === 'completed')).toBe(true);
    });

    it('should filter case-insensitively', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: [
          { id: '1', status: 'Completed' },
          { id: '2', state: 'COMPLETED' },
        ],
      });

      const jobs = await client.getJobs('completed');
      expect(jobs).toHaveLength(2);
    });

    it('should return all jobs when status is null', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: [{ id: '1' }, { id: '2' }],
      });

      const jobs = await client.getJobs(null);
      expect(jobs).toHaveLength(2);
    });

    it('should rethrow errors', async () => {
      mockAxiosClient.get.mockRejectedValue(new Error('network error'));

      await expect(client.getJobs()).rejects.toThrow('network error');
    });
  });

  describe('getJob()', () => {
    it('should GET /api/v1/transcription/{jobId}', async () => {
      mockAxiosClient.get.mockResolvedValue({ data: { id: 'job-1' } });

      await client.getJob('job-1');

      expect(mockAxiosClient.get).toHaveBeenCalledWith('/api/v1/transcription/job-1');
    });

    it('should return response.data', async () => {
      mockAxiosClient.get.mockResolvedValue({ data: { id: 'job-1', status: 'completed' } });

      const job = await client.getJob('job-1');
      expect(job).toEqual({ id: 'job-1', status: 'completed' });
    });

    it('should rethrow errors', async () => {
      mockAxiosClient.get.mockRejectedValue(new Error('not found'));
      await expect(client.getJob('bad')).rejects.toThrow('not found');
    });
  });

  describe('getJobStatus()', () => {
    it('should GET /api/v1/transcription/{jobId}/status', async () => {
      mockAxiosClient.get.mockResolvedValue({ data: { status: 'completed' } });

      await client.getJobStatus('job-1');

      expect(mockAxiosClient.get).toHaveBeenCalledWith('/api/v1/transcription/job-1/status');
    });

    it('should return status from response.data.status', async () => {
      mockAxiosClient.get.mockResolvedValue({ data: { status: 'completed' } });

      const status = await client.getJobStatus('job-1');
      expect(status).toBe('completed');
    });

    it('should return state when status missing', async () => {
      mockAxiosClient.get.mockResolvedValue({ data: { state: 'done' } });

      const status = await client.getJobStatus('job-1');
      expect(status).toBe('done');
    });

    it('should fall back to getJob() on error', async () => {
      mockAxiosClient.get
        .mockRejectedValueOnce(new Error('no status endpoint'))
        .mockResolvedValueOnce({ data: { id: 'job-1', status: 'completed' } });

      const status = await client.getJobStatus('job-1');
      expect(status).toBe('completed');
    });
  });

  describe('getTranscript()', () => {
    it('should GET /api/v1/transcription/{jobId}/transcript', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { transcript: { text: 'hello', language: 'en' } },
      });

      await client.getTranscript('job-1');

      expect(mockAxiosClient.get).toHaveBeenCalledWith('/api/v1/transcription/job-1/transcript');
    });

    it('should normalize when response has .transcript.text', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { transcript: { text: 'transcript text', language: 'fr' } },
      });

      const result = await client.getTranscript('job-1');
      expect(result).toEqual({ text: 'transcript text', language: 'fr' });
    });

    it('should normalize when response has .transcript as string', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { transcript: 'raw transcript string' },
      });

      const result = await client.getTranscript('job-1');
      expect(result.text).toBe('raw transcript string');
    });

    it('should default language to "en" when not present', async () => {
      mockAxiosClient.get.mockResolvedValue({
        data: { text: 'some text' },
      });

      const result = await client.getTranscript('job-1');
      expect(result.language).toBe('en');
    });
  });

  describe('downloadAudioFile()', () => {
    it('should call getJob() to get filename', async () => {
      mockAxiosClient.get
        .mockResolvedValueOnce({ data: { filename: 'audio.mp3' } }) // getJob
        .mockResolvedValueOnce({
          data: Buffer.from('audio data'),
          headers: { 'content-type': 'audio/mpeg' },
        }); // audio download

      fs.writeFileSync.mockReturnValue(undefined);

      await client.downloadAudioFile('job-1', '/tmp');

      expect(mockAxiosClient.get).toHaveBeenCalledWith('/api/v1/transcription/job-1');
    });

    it('should GET audio endpoint with arraybuffer responseType', async () => {
      mockAxiosClient.get
        .mockResolvedValueOnce({ data: { filename: 'audio.mp3' } })
        .mockResolvedValueOnce({
          data: Buffer.from('audio data'),
          headers: { 'content-type': 'audio/mpeg' },
        });

      fs.writeFileSync.mockReturnValue(undefined);

      await client.downloadAudioFile('job-1', '/tmp');

      expect(mockAxiosClient.get).toHaveBeenCalledWith(
        '/api/v1/transcription/job-1/audio',
        expect.objectContaining({ responseType: 'arraybuffer' })
      );
    });

    it('should sanitize filename', async () => {
      mockAxiosClient.get
        .mockResolvedValueOnce({ data: { filename: 'my file (1).mp3' } })
        .mockResolvedValueOnce({
          data: Buffer.from('data'),
          headers: { 'content-type': 'audio/mpeg' },
        });

      fs.writeFileSync.mockReturnValue(undefined);

      const result = await client.downloadAudioFile('job-1', '/tmp');

      // Non-alphanumeric chars (except . _ -) replaced with _
      expect(result.filename).not.toContain(' ');
      expect(result.filename).not.toContain('(');
    });

    it('should return null on 404 response', async () => {
      mockAxiosClient.get
        .mockResolvedValueOnce({ data: { filename: 'audio.mp3' } })
        .mockRejectedValueOnce({ response: { status: 404 } });

      const result = await client.downloadAudioFile('job-1', '/tmp');
      expect(result).toBeNull();
    });

    it('should rethrow non-404 errors', async () => {
      mockAxiosClient.get
        .mockResolvedValueOnce({ data: { filename: 'audio.mp3' } })
        .mockRejectedValueOnce({ response: { status: 500 }, message: 'Server error' });

      await expect(client.downloadAudioFile('job-1', '/tmp'))
        .rejects.toEqual(expect.objectContaining({ message: 'Server error' }));
    });

    it('should default filename when job has none', async () => {
      mockAxiosClient.get
        .mockResolvedValueOnce({ data: {} }) // no filename
        .mockResolvedValueOnce({
          data: Buffer.from('data'),
          headers: { 'content-type': 'audio/mpeg' },
        });

      fs.writeFileSync.mockReturnValue(undefined);

      const result = await client.downloadAudioFile('job-1', '/tmp');
      expect(result.filename).toContain('audio_job-1');
    });
  });

  describe('submitFile()', () => {
    const mockFormInstance = {
      append: vi.fn(),
      getHeaders: vi.fn(() => ({ 'content-type': 'multipart/form-data' })),
    };

    beforeEach(() => {
      FormData.mockImplementation(() => mockFormInstance);
      fs.createReadStream.mockReturnValue('mock-stream');
    });

    it('should create FormData with audio file stream and language', async () => {
      mockAxiosClient.post.mockResolvedValue({ data: { id: 'new-job-1' } });

      await client.submitFile('/path/to/audio.mp3', 'audio.mp3', 'en');

      expect(mockFormInstance.append).toHaveBeenCalledWith(
        'audio', 'mock-stream', { filename: 'audio.mp3' }
      );
      expect(mockFormInstance.append).toHaveBeenCalledWith('language', 'en');
    });

    it('should POST to /api/v1/transcription/submit', async () => {
      mockAxiosClient.post.mockResolvedValue({ data: { id: 'new-job-1' } });

      await client.submitFile('/path/to/audio.mp3', 'audio.mp3');

      expect(mockAxiosClient.post).toHaveBeenCalledWith(
        '/api/v1/transcription/submit',
        mockFormInstance,
        expect.any(Object)
      );
    });

    it('should return job ID from response', async () => {
      mockAxiosClient.post.mockResolvedValue({ data: { id: 'job-xyz' } });

      const jobId = await client.submitFile('/path/to/audio.mp3', 'audio.mp3');
      expect(jobId).toBe('job-xyz');
    });

    it('should throw when response has no job ID', async () => {
      mockAxiosClient.post.mockResolvedValue({ data: {} });

      await expect(client.submitFile('/path/to/audio.mp3', 'audio.mp3'))
        .rejects.toThrow('Scriberr did not return a job ID');
    });

    it('should rethrow errors', async () => {
      mockAxiosClient.post.mockRejectedValue(new Error('upload failed'));

      await expect(client.submitFile('/path/to/audio.mp3', 'audio.mp3'))
        .rejects.toThrow('upload failed');
    });
  });

  describe('healthCheck()', () => {
    it('should GET /health endpoint', async () => {
      axios.get.mockResolvedValue({ status: 200 });

      await client.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:8080/health',
        { timeout: 5000 }
      );
    });

    it('should return true when status is 200', async () => {
      axios.get.mockResolvedValue({ status: 200 });

      const result = await client.healthCheck();
      expect(result).toBe(true);
    });

    it('should return false when request fails', async () => {
      axios.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.healthCheck();
      expect(result).toBe(false);
    });
  });
});
