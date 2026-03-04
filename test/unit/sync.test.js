const fs = require('fs');
const path = require('path');

const SyncWorker = require('../../src/sync');

describe('SyncWorker', () => {
  let worker;
  let mockScriberr;
  let mockNotion;

  beforeEach(() => {
    vi.clearAllMocks();

    // Spy on fs methods instead of vi.mock('fs') (CJS built-in modules
    // cannot be mocked with vi.mock in Vitest v3)
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

    // Mock Scriberr client
    mockScriberr = {
      getJobs: vi.fn().mockResolvedValue([]),
      getJob: vi.fn().mockResolvedValue({}),
      getTranscript: vi.fn().mockResolvedValue({ text: 'transcript', language: 'en' }),
      downloadAudioFile: vi.fn().mockResolvedValue(null),
      healthCheck: vi.fn().mockResolvedValue(true),
    };

    // Mock Notion client
    mockNotion = {
      uploadFile: vi.fn().mockResolvedValue('upload-id'),
      createTranscriptPage: vi.fn().mockResolvedValue('page-id'),
      testConnection: vi.fn().mockResolvedValue(true),
    };

    worker = new SyncWorker(mockScriberr, mockNotion, 30000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should store injected clients', () => {
      expect(worker.scriberr).toBe(mockScriberr);
      expect(worker.notion).toBe(mockNotion);
    });

    it('should use default pollInterval of 30000ms', () => {
      const w = new SyncWorker(mockScriberr, mockNotion);
      expect(w.pollInterval).toBe(30000);
    });

    it('should accept custom pollInterval', () => {
      expect(worker.pollInterval).toBe(30000);
    });

    it('should initialize syncedJobs as empty Set', () => {
      expect(worker.syncedJobs).toBeInstanceOf(Set);
      expect(worker.syncedJobs.size).toBe(0);
    });

    it('should initialize failedJobs as empty Map', () => {
      expect(worker.failedJobs).toBeInstanceOf(Map);
      expect(worker.failedJobs.size).toBe(0);
    });

    it('should set maxRetries to 3', () => {
      expect(worker.maxRetries).toBe(3);
    });
  });

  describe('loadState()', () => {
    it('should create state directory if it does not exist', () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes('.sync-state.json')) return false;
        return false;
      });

      worker.loadState();

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    it('should load syncedJobs from state file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        syncedJobs: ['job-1', 'job-2'],
        failedJobs: {},
      }));

      worker.loadState();

      expect(worker.syncedJobs.size).toBe(2);
      expect(worker.syncedJobs.has('job-1')).toBe(true);
      expect(worker.syncedJobs.has('job-2')).toBe(true);
    });

    it('should load failedJobs from state file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        syncedJobs: [],
        failedJobs: { 'job-3': 2 },
      }));

      worker.loadState();

      expect(worker.failedJobs.size).toBe(1);
      expect(worker.failedJobs.get('job-3')).toBe(2);
    });

    it('should handle missing state file gracefully', () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes('.sync-state.json')) return false;
        return true;
      });

      worker.loadState();

      expect(worker.syncedJobs.size).toBe(0);
      expect(worker.failedJobs.size).toBe(0);
    });

    it('should handle corrupt state file gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not valid json');

      worker.loadState();

      expect(worker.syncedJobs.size).toBe(0);
      expect(worker.failedJobs.size).toBe(0);
    });

    it('should handle state file without failedJobs key', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        syncedJobs: ['job-1'],
      }));

      worker.loadState();

      expect(worker.syncedJobs.size).toBe(1);
      expect(worker.failedJobs.size).toBe(0);
    });
  });

  describe('saveState()', () => {
    it('should create state directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      worker.saveState();

      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('should write JSON with syncedJobs and failedJobs', () => {
      worker.syncedJobs.add('job-1');
      worker.failedJobs.set('job-2', 1);

      worker.saveState();

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.syncedJobs).toEqual(['job-1']);
      expect(written.failedJobs).toEqual({ 'job-2': 1 });
    });

    it('should include lastSync ISO timestamp', () => {
      worker.saveState();

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.lastSync).toBeDefined();
      expect(new Date(written.lastSync).toISOString()).toBe(written.lastSync);
    });

    it('should not throw on write error', () => {
      fs.writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      // Should not throw
      expect(() => worker.saveState()).not.toThrow();
    });
  });

  describe('cleanupTempFile()', () => {
    it('should delete file when it exists', () => {
      fs.existsSync.mockReturnValue(true);

      worker.cleanupTempFile('/tmp/audio.mp3');

      expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/audio.mp3');
    });

    it('should do nothing when filePath is null', () => {
      worker.cleanupTempFile(null);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should do nothing when file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      worker.cleanupTempFile('/tmp/missing.mp3');

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should not throw when unlinkSync fails', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => { throw new Error('EPERM'); });

      expect(() => worker.cleanupTempFile('/tmp/locked.mp3')).not.toThrow();
    });
  });

  describe('sync()', () => {
    beforeEach(() => {
      worker.isRunning = true;
    });

    it('should return immediately when isRunning is false', async () => {
      worker.isRunning = false;

      await worker.sync();

      expect(mockScriberr.getJobs).not.toHaveBeenCalled();
    });

    it('should call scriberr.getJobs("completed")', async () => {
      mockScriberr.getJobs.mockResolvedValue([]);

      await worker.sync();

      expect(mockScriberr.getJobs).toHaveBeenCalledWith('completed');
    });

    it('should return early when no completed jobs found', async () => {
      mockScriberr.getJobs.mockResolvedValue(null);

      await worker.sync();

      expect(mockNotion.createTranscriptPage).not.toHaveBeenCalled();
    });

    it('should skip jobs already in syncedJobs set', async () => {
      worker.syncedJobs.add('job-1');
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', status: 'completed' },
      ]);

      await worker.sync();

      expect(mockScriberr.getTranscript).not.toHaveBeenCalled();
    });

    it('should skip jobs that exceeded maxRetries', async () => {
      worker.failedJobs.set('job-1', 3); // maxRetries = 3
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', status: 'completed' },
      ]);

      await worker.sync();

      expect(mockScriberr.getTranscript).not.toHaveBeenCalled();
    });

    it('should call syncJob for each new job', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test.mp3' },
        { id: 'job-2', filename: 'test2.mp3' },
      ]);

      const syncJobSpy = vi.spyOn(worker, 'syncJob').mockResolvedValue();

      await worker.sync();

      expect(syncJobSpy).toHaveBeenCalledTimes(2);
    });

    it('should add successful job ID to syncedJobs', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob').mockResolvedValue();

      await worker.sync();

      expect(worker.syncedJobs.has('job-1')).toBe(true);
    });

    it('should remove successful job from failedJobs', async () => {
      worker.failedJobs.set('job-1', 1);
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob').mockResolvedValue();

      await worker.sync();

      expect(worker.failedJobs.has('job-1')).toBe(false);
    });

    it('should increment retry count on failure', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob').mockRejectedValue(new Error('sync failed'));

      await worker.sync();

      expect(worker.failedJobs.get('job-1')).toBe(1);
    });

    it('should call saveState after processing', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob').mockResolvedValue();
      const saveSpy = vi.spyOn(worker, 'saveState');

      await worker.sync();

      expect(saveSpy).toHaveBeenCalled();
    });

    it('should catch and log top-level errors without crashing', async () => {
      mockScriberr.getJobs.mockRejectedValue(new Error('network error'));

      // Should not throw
      await worker.sync();
    });

    it('should not add job to syncedJobs when transcript is empty', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-empty', filename: 'test.mp3' },
      ]);
      mockScriberr.getTranscript.mockResolvedValue({ text: '', language: 'en' });

      await worker.sync();

      expect(worker.syncedJobs.has('job-empty')).toBe(false);
    });

    it('should increment failedJobs when transcript is empty', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-empty', filename: 'test.mp3' },
      ]);
      mockScriberr.getTranscript.mockResolvedValue({ text: '', language: 'en' });

      await worker.sync();

      expect(worker.failedJobs.get('job-empty')).toBe(1);
    });

    it('should save state after each successful job sync', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test1.mp3' },
        { id: 'job-2', filename: 'test2.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob').mockResolvedValue();
      const saveSpy = vi.spyOn(worker, 'saveState');

      await worker.sync();

      expect(saveSpy).toHaveBeenCalledTimes(2);
    });

    it('should save state after failed job to persist retry count', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob').mockRejectedValue(new Error('failed'));
      const saveSpy = vi.spyOn(worker, 'saveState');

      await worker.sync();

      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('should preserve first job in syncedJobs if second job fails', async () => {
      mockScriberr.getJobs.mockResolvedValue([
        { id: 'job-1', filename: 'test1.mp3' },
        { id: 'job-2', filename: 'test2.mp3' },
      ]);
      vi.spyOn(worker, 'syncJob')
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('fail'));

      await worker.sync();

      expect(worker.syncedJobs.has('job-1')).toBe(true);
      expect(worker.syncedJobs.has('job-2')).toBe(false);
      expect(worker.failedJobs.get('job-2')).toBe(1);
    });
  });

  describe('syncJob()', () => {
    const mockJob = {
      id: 'job-1',
      filename: 'recording.mp3',
      duration: 120,
      language: 'en',
    };

    it('should fetch transcript via scriberr.getTranscript', async () => {
      await worker.syncJob(mockJob);

      expect(mockScriberr.getTranscript).toHaveBeenCalledWith('job-1');
    });

    it('should call notion.createTranscriptPage', async () => {
      await worker.syncJob(mockJob);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.any(String),
          transcript: 'transcript',
          source: 'Audio',
          sourceFilename: 'recording.mp3',
        })
      );
    });

    it('should continue without audio when downloadAudioFile fails', async () => {
      mockScriberr.downloadAudioFile.mockRejectedValue(new Error('download failed'));

      await worker.syncJob(mockJob);

      // Should still create page
      expect(mockNotion.createTranscriptPage).toHaveBeenCalled();
    });

    it('should continue without audio when uploadFile fails', async () => {
      mockScriberr.downloadAudioFile.mockResolvedValue({
        filePath: '/tmp/audio.mp3',
        filename: 'audio.mp3',
        contentType: 'audio/mpeg',
      });
      mockNotion.uploadFile.mockRejectedValue(new Error('upload failed'));

      await worker.syncJob(mockJob);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalled();
    });

    it('should clean up temp file in finally block', async () => {
      mockScriberr.downloadAudioFile.mockResolvedValue({
        filePath: '/tmp/audio.mp3',
        filename: 'audio.mp3',
        contentType: 'audio/mpeg',
      });

      await worker.syncJob(mockJob);

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should use job._id when job.id is missing', async () => {
      const jobWithUnderscore = { _id: 'job-alt', filename: 'test.mp3' };

      await worker.syncJob(jobWithUnderscore);

      expect(mockScriberr.getTranscript).toHaveBeenCalledWith('job-alt');
    });

    it('should default filename when job.filename is missing', async () => {
      const jobNoName = { id: 'job-noname' };

      await worker.syncJob(jobNoName);

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFilename: expect.stringContaining('Transcript'),
        })
      );
    });

    it('should throw when transcript text is empty', async () => {
      mockScriberr.getTranscript.mockResolvedValue({ text: '', language: 'en' });

      await expect(worker.syncJob({ id: 'job-empty', filename: 'test.mp3' }))
        .rejects.toThrow('empty transcript');
    });

    it('should throw when transcript text is null', async () => {
      mockScriberr.getTranscript.mockResolvedValue({ text: null, language: 'en' });

      await expect(worker.syncJob({ id: 'job-null', filename: 'test.mp3' }))
        .rejects.toThrow('empty transcript');
    });

    it('should not create Notion page when transcript is empty', async () => {
      mockScriberr.getTranscript.mockResolvedValue({ text: '', language: 'en' });

      await worker.syncJob({ id: 'job-empty', filename: 'test.mp3' }).catch(() => {});

      expect(mockNotion.createTranscriptPage).not.toHaveBeenCalled();
    });
  });

  describe('getSourceType() - pure logic', () => {
    it('should return "Video" for .mp4 files', () => {
      expect(worker.getSourceType('video.mp4')).toBe('Video');
    });

    it('should return "Video" for .mov files', () => {
      expect(worker.getSourceType('video.mov')).toBe('Video');
    });

    it('should return "Video" for .avi files', () => {
      expect(worker.getSourceType('video.avi')).toBe('Video');
    });

    it('should return "Video" for .mkv files', () => {
      expect(worker.getSourceType('video.mkv')).toBe('Video');
    });

    it('should return "Video" for .webm files', () => {
      expect(worker.getSourceType('video.webm')).toBe('Video');
    });

    it('should return "Video" for .m4v files', () => {
      expect(worker.getSourceType('video.m4v')).toBe('Video');
    });

    it('should return "Audio" for .mp3 files', () => {
      expect(worker.getSourceType('audio.mp3')).toBe('Audio');
    });

    it('should return "Audio" for .wav files', () => {
      expect(worker.getSourceType('audio.wav')).toBe('Audio');
    });

    it('should return "Audio" for files with no extension', () => {
      expect(worker.getSourceType('noext')).toBe('Audio');
    });

    it('should return "Audio" for null input', () => {
      expect(worker.getSourceType(null)).toBe('Audio');
    });
  });

  describe('cleanTitle() - pure logic', () => {
    it('should remove file extension', () => {
      expect(worker.cleanTitle('recording.mp3')).toBe('recording');
    });

    it('should replace underscores with spaces', () => {
      expect(worker.cleanTitle('my_recording.mp3')).toBe('my recording');
    });

    it('should replace dashes with spaces', () => {
      expect(worker.cleanTitle('my-recording.mp3')).toBe('my recording');
    });

    it('should truncate to 200 characters', () => {
      const longName = 'a'.repeat(250) + '.mp3';
      expect(worker.cleanTitle(longName).length).toBeLessThanOrEqual(200);
    });

    it('should return timestamp-based title for null input', () => {
      const result = worker.cleanTitle(null);
      expect(result).toContain('Transcript');
    });

    it('should handle filenames with multiple dots', () => {
      expect(worker.cleanTitle('my.file.name.mp3')).toBe('my.file.name');
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      worker.stop();
    });

    it('should call loadState', async () => {
      const loadSpy = vi.spyOn(worker, 'loadState');
      vi.spyOn(worker, 'sync').mockResolvedValue();

      await worker.start();

      expect(loadSpy).toHaveBeenCalled();
    });

    it('should call scriberr.healthCheck', async () => {
      vi.spyOn(worker, 'sync').mockResolvedValue();

      await worker.start();

      expect(mockScriberr.healthCheck).toHaveBeenCalled();
    });

    it('should call notion.testConnection', async () => {
      vi.spyOn(worker, 'sync').mockResolvedValue();

      await worker.start();

      expect(mockNotion.testConnection).toHaveBeenCalled();
    });

    it('should set isRunning to true', async () => {
      vi.spyOn(worker, 'sync').mockResolvedValue();

      await worker.start();

      expect(worker.isRunning).toBe(true);
    });

    it('should call sync immediately', async () => {
      const syncSpy = vi.spyOn(worker, 'sync').mockResolvedValue();

      await worker.start();

      expect(syncSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('should set isRunning to false', () => {
      worker.isRunning = true;

      worker.stop();

      expect(worker.isRunning).toBe(false);
    });

    it('should clear interval', () => {
      worker.interval = setInterval(() => {}, 1000);

      worker.stop();

      expect(worker.interval).toBeNull();
    });

    it('should call saveState', () => {
      const saveSpy = vi.spyOn(worker, 'saveState');

      worker.stop();

      expect(saveSpy).toHaveBeenCalled();
    });

    it('should handle case where interval is already null', () => {
      worker.interval = null;

      expect(() => worker.stop()).not.toThrow();
    });
  });
});
