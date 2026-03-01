const fs = require('fs');
const path = require('path');

const MediaPipeline = require('../../src/media-pipeline');

describe('MediaPipeline', () => {
  let pipeline;
  let mockNotion;
  let mockScriberr;
  let mockGroq;
  let mockDownloader;
  let mockExtractor;
  let mockYtTranscript;

  // Hold references to the real sub-component instances created by the constructor,
  // so constructor-argument tests can verify what was passed.
  let realDownloader;
  let realExtractor;
  let realYtTranscript;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();

    // Spy on all fs methods used by the source (and sub-component constructors).
    // These must be set up BEFORE creating the pipeline, because the sub-component
    // constructors call fs.existsSync / fs.mkdirSync in their ensureDir().
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('');
    vi.spyOn(fs, 'copyFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

    // Mock sub-component instances (these replace the real ones after construction)
    mockDownloader = {
      download: vi.fn().mockResolvedValue({
        filePath: '/tmp/downloads/video.mp3',
        filename: 'video.mp3',
        title: 'Test Video',
        duration: 120,
        url: 'https://youtube.com/watch?v=test',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceType: 'youtube',
      }),
    };

    mockExtractor = {
      isAudioOnly: vi.fn().mockResolvedValue(false),
      extract: vi.fn().mockResolvedValue({
        filePath: '/tmp/extracted/video.mp3',
        filename: 'video.mp3',
      }),
      convert: vi.fn().mockResolvedValue({
        filePath: '/tmp/extracted/audio.mp3',
        filename: 'audio.mp3',
      }),
      getMimeType: vi.fn().mockReturnValue('audio/mpeg'),
    };

    mockYtTranscript = {
      fetch: vi.fn().mockResolvedValue(null),
    };

    // Mock injected clients
    mockNotion = {
      uploadFile: vi.fn().mockResolvedValue('upload-id'),
      createTranscriptPage: vi.fn().mockResolvedValue('page-abc-123'),
    };

    mockScriberr = {
      submitFile: vi.fn().mockResolvedValue('scriberr-job-1'),
      getJob: vi.fn().mockResolvedValue({ status: 'completed' }),
      getTranscript: vi.fn().mockResolvedValue({ text: 'transcribed text', language: 'en' }),
    };

    mockGroq = {
      transcribe: vi.fn().mockResolvedValue({ text: 'groq text', language: 'en' }),
    };

    // Create the pipeline (real sub-component constructors will run, using fs spies)
    pipeline = new MediaPipeline({
      notionClient: mockNotion,
      scriberrClient: mockScriberr,
      groqTranscriber: mockGroq,
      config: {
        inboxDir: '/test/inbox',
        processedDir: '/test/processed',
        tempDir: '/test/temp',
        pollInterval: 5000,
        audioFormat: 'mp3',
      },
    });

    // Save the real sub-component instances for constructor tests
    realDownloader = pipeline.downloader;
    realExtractor = pipeline.extractor;
    realYtTranscript = pipeline.ytTranscript;

    // Replace with mocks for all behavioral tests
    pipeline.downloader = mockDownloader;
    pipeline.extractor = mockExtractor;
    pipeline.ytTranscript = mockYtTranscript;
  });

  afterEach(() => {
    vi.useRealTimers();
    pipeline.stop();
  });

  describe('constructor', () => {
    it('should store injected clients', () => {
      expect(pipeline.notion).toBe(mockNotion);
      expect(pipeline.scriberr).toBe(mockScriberr);
      expect(pipeline.groq).toBe(mockGroq);
    });

    it('should set groq to null when not provided', () => {
      const p = new MediaPipeline({
        notionClient: mockNotion,
        scriberrClient: mockScriberr,
      });
      expect(p.groq).toBeNull();
    });

    it('should use default directories when config empty', () => {
      const p = new MediaPipeline({
        notionClient: mockNotion,
        scriberrClient: mockScriberr,
      });
      expect(p.inboxDir).toBe('/app/data/inbox_media');
      expect(p.processedDir).toBe('/app/data/processed');
      expect(p.tempDir).toBe('/tmp/media-pipeline');
    });

    it('should use custom directories from config', () => {
      expect(pipeline.inboxDir).toBe('/test/inbox');
      expect(pipeline.processedDir).toBe('/test/processed');
      expect(pipeline.tempDir).toBe('/test/temp');
    });

    it('should create MediaDownloader with correct output dir', () => {
      expect(realDownloader.outputDir).toBe('/test/temp/downloads');
    });

    it('should create AudioExtractor with correct output dir', () => {
      expect(realExtractor.outputDir).toBe('/test/temp/extracted');
    });

    it('should create YouTubeTranscript with correct output dir', () => {
      expect(realYtTranscript.outputDir).toBe('/test/temp/transcripts');
    });

    it('should initialize processing Set as empty', () => {
      expect(pipeline.processing).toBeInstanceOf(Set);
      expect(pipeline.processing.size).toBe(0);
    });

    it('should default skipTranscript to false', () => {
      expect(pipeline.skipTranscript).toBe(false);
    });
  });

  describe('static properties', () => {
    it('MEDIA_EXTS should match common audio extensions', () => {
      const audioExts = ['file.mp3', 'file.m4a', 'file.wav', 'file.flac', 'file.ogg', 'file.opus', 'file.aac', 'file.wma'];
      for (const f of audioExts) {
        expect(MediaPipeline.MEDIA_EXTS.test(f)).toBe(true);
      }
    });

    it('MEDIA_EXTS should match common video extensions', () => {
      const videoExts = ['file.mp4', 'file.mov', 'file.webm', 'file.mkv', 'file.avi', 'file.m4v'];
      for (const f of videoExts) {
        expect(MediaPipeline.MEDIA_EXTS.test(f)).toBe(true);
      }
    });

    it('MEDIA_EXTS should be case-insensitive', () => {
      expect(MediaPipeline.MEDIA_EXTS.test('FILE.MP3')).toBe(true);
      expect(MediaPipeline.MEDIA_EXTS.test('file.Mp4')).toBe(true);
    });

    it('MEDIA_EXTS should not match non-media files', () => {
      expect(MediaPipeline.MEDIA_EXTS.test('file.pdf')).toBe(false);
      expect(MediaPipeline.MEDIA_EXTS.test('file.doc')).toBe(false);
      expect(MediaPipeline.MEDIA_EXTS.test('file.jpg')).toBe(false);
    });

    it('URL_EXTS should match .txt, .json, .url', () => {
      expect(MediaPipeline.URL_EXTS.test('file.txt')).toBe(true);
      expect(MediaPipeline.URL_EXTS.test('file.json')).toBe(true);
      expect(MediaPipeline.URL_EXTS.test('file.url')).toBe(true);
    });

    it('URL_EXTS should be case-insensitive', () => {
      expect(MediaPipeline.URL_EXTS.test('file.TXT')).toBe(true);
    });
  });

  describe('ensureDirs()', () => {
    it('should create directories when they do not exist', () => {
      fs.existsSync.mockReturnValue(false);

      pipeline.ensureDirs();

      expect(fs.mkdirSync).toHaveBeenCalledTimes(3);
    });

    it('should not create directories that already exist', () => {
      fs.existsSync.mockReturnValue(true);
      fs.mkdirSync.mockClear();

      pipeline.ensureDirs();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('start()', () => {
    it('should call ensureDirs', async () => {
      const spy = vi.spyOn(pipeline, 'ensureDirs');
      vi.spyOn(pipeline, 'scan').mockResolvedValue();

      await pipeline.start();

      expect(spy).toHaveBeenCalled();
    });

    it('should set isRunning to true', async () => {
      vi.spyOn(pipeline, 'scan').mockResolvedValue();

      await pipeline.start();

      expect(pipeline.isRunning).toBe(true);
    });

    it('should call scan immediately', async () => {
      const scanSpy = vi.spyOn(pipeline, 'scan').mockResolvedValue();

      await pipeline.start();

      expect(scanSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('should set isRunning to false', () => {
      pipeline.isRunning = true;
      pipeline.stop();
      expect(pipeline.isRunning).toBe(false);
    });

    it('should clear interval', () => {
      pipeline.interval = setInterval(() => {}, 1000);
      pipeline.stop();
      expect(pipeline.interval).toBeNull();
    });

    it('should handle null interval', () => {
      pipeline.interval = null;
      expect(() => pipeline.stop()).not.toThrow();
    });
  });

  describe('scan()', () => {
    beforeEach(() => {
      pipeline.isRunning = true;
    });

    it('should return immediately when isRunning is false', async () => {
      pipeline.isRunning = false;

      await pipeline.scan();

      expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it('should read inbox directory', async () => {
      fs.readdirSync.mockReturnValue([]);

      await pipeline.scan();

      expect(fs.readdirSync).toHaveBeenCalledWith('/test/inbox');
    });

    it('should filter for URL and media file extensions', async () => {
      fs.readdirSync.mockReturnValue(['video.mp4', 'urls.txt', 'readme.md', 'image.jpg']);

      const processSpy = vi.spyOn(pipeline, 'processFile').mockResolvedValue();

      await pipeline.scan();

      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(processSpy).toHaveBeenCalledWith('video.mp4');
      expect(processSpy).toHaveBeenCalledWith('urls.txt');
    });

    it('should exclude hidden files', async () => {
      fs.readdirSync.mockReturnValue(['.hidden.mp3', 'visible.mp3']);

      const processSpy = vi.spyOn(pipeline, 'processFile').mockResolvedValue();

      await pipeline.scan();

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('visible.mp3');
    });

    it('should exclude files currently in processing set', async () => {
      pipeline.processing.add('inprogress.mp3');
      fs.readdirSync.mockReturnValue(['inprogress.mp3', 'new.mp3']);

      const processSpy = vi.spyOn(pipeline, 'processFile').mockResolvedValue();

      await pipeline.scan();

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('new.mp3');
    });

    it('should return without action when no matching files', async () => {
      fs.readdirSync.mockReturnValue([]);

      const processSpy = vi.spyOn(pipeline, 'processFile');

      await pipeline.scan();

      expect(processSpy).not.toHaveBeenCalled();
    });

    it('should add file to processing set before processing', async () => {
      fs.readdirSync.mockReturnValue(['test.mp3']);
      vi.spyOn(pipeline, 'processFile').mockImplementation(async () => {
        expect(pipeline.processing.has('test.mp3')).toBe(true);
      });

      await pipeline.scan();
    });

    it('should remove file from processing set after success', async () => {
      fs.readdirSync.mockReturnValue(['test.mp3']);
      vi.spyOn(pipeline, 'processFile').mockResolvedValue();

      await pipeline.scan();

      expect(pipeline.processing.has('test.mp3')).toBe(false);
    });

    it('should remove file from processing set after failure', async () => {
      fs.readdirSync.mockReturnValue(['test.mp3']);
      vi.spyOn(pipeline, 'processFile').mockRejectedValue(new Error('fail'));

      await pipeline.scan();

      expect(pipeline.processing.has('test.mp3')).toBe(false);
    });

    it('should call moveToProcessed on success', async () => {
      fs.readdirSync.mockReturnValue(['test.mp3']);
      vi.spyOn(pipeline, 'processFile').mockResolvedValue();
      const moveSpy = vi.spyOn(pipeline, 'moveToProcessed');

      await pipeline.scan();

      expect(moveSpy).toHaveBeenCalledWith('test.mp3');
    });

    it('should call moveToProcessed with failed=true on error', async () => {
      fs.readdirSync.mockReturnValue(['test.mp3']);
      vi.spyOn(pipeline, 'processFile').mockRejectedValue(new Error('fail'));
      const moveSpy = vi.spyOn(pipeline, 'moveToProcessed');

      await pipeline.scan();

      expect(moveSpy).toHaveBeenCalledWith('test.mp3', true);
    });

    it('should catch and log scan-level errors without crashing', async () => {
      fs.readdirSync.mockImplementation(() => { throw new Error('ENOENT'); });

      await expect(pipeline.scan()).resolves.toBeUndefined();
    });
  });

  describe('processFile()', () => {
    it('should route media files to ingestFile', async () => {
      const ingestFileSpy = vi.spyOn(pipeline, 'ingestFile').mockResolvedValue();

      await pipeline.processFile('video.mp4');

      expect(ingestFileSpy).toHaveBeenCalledWith('/test/inbox/video.mp4');
    });

    it('should route .txt files to URL parsing and ingest per URL', async () => {
      fs.readFileSync.mockReturnValue('https://youtube.com/watch?v=test1\nhttps://youtube.com/watch?v=test2');
      const ingestSpy = vi.spyOn(pipeline, 'ingest').mockResolvedValue();

      await pipeline.processFile('urls.txt');

      expect(ingestSpy).toHaveBeenCalledTimes(2);
    });

    it('should route .json files to JSON parsing - array', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
      ]));
      const ingestSpy = vi.spyOn(pipeline, 'ingest').mockResolvedValue();

      await pipeline.processFile('batch.json');

      expect(ingestSpy).toHaveBeenCalledTimes(2);
    });

    it('should route .json files to JSON parsing - single object', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({ url: 'https://example.com/1' }));
      const ingestSpy = vi.spyOn(pipeline, 'ingest').mockResolvedValue();

      await pipeline.processFile('single.json');

      expect(ingestSpy).toHaveBeenCalledTimes(1);
    });

    it('should filter out empty lines, comments, and non-http lines', async () => {
      fs.readFileSync.mockReturnValue('https://valid.com\n\n# comment\nnot-a-url\nhttps://also-valid.com');
      const ingestSpy = vi.spyOn(pipeline, 'ingest').mockResolvedValue();

      await pipeline.processFile('urls.txt');

      expect(ingestSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('ingest()', () => {
    it('should try YouTube transcript first when not skipped', async () => {
      mockYtTranscript.fetch.mockResolvedValue({
        text: 'YouTube transcript text',
        language: 'en',
        source: 'manual',
      });

      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockYtTranscript.fetch).toHaveBeenCalledWith('https://youtube.com/watch?v=test');
    });

    it('should skip YouTube transcript when opts.skipTranscript is true', async () => {
      await pipeline.ingest('https://youtube.com/watch?v=test', { skipTranscript: true });

      expect(mockYtTranscript.fetch).not.toHaveBeenCalled();
    });

    it('should skip YouTube transcript when this.skipTranscript is true', async () => {
      pipeline.skipTranscript = true;

      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockYtTranscript.fetch).not.toHaveBeenCalled();
    });

    it('should call downloader.download with URL', async () => {
      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockDownloader.download).toHaveBeenCalledWith(
        'https://youtube.com/watch?v=test',
        expect.objectContaining({ audioOnly: true, format: 'mp3' })
      );
    });

    it('should use Whisper transcription when YouTube transcript not available', async () => {
      mockYtTranscript.fetch.mockResolvedValue(null);
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingest('https://youtube.com/watch?v=test');

      // Should have tried Groq (via transcribeViaScriberr)
      expect(mockGroq.transcribe).toHaveBeenCalled();
    });

    it('should extract audio when download is video', async () => {
      mockYtTranscript.fetch.mockResolvedValue(null);
      mockExtractor.isAudioOnly.mockResolvedValue(false);

      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockExtractor.extract).toHaveBeenCalled();
    });

    it('should not extract audio when download is already audio', async () => {
      mockYtTranscript.fetch.mockResolvedValue(null);
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockExtractor.extract).not.toHaveBeenCalled();
    });

    it('should upload audio to Notion', async () => {
      mockYtTranscript.fetch.mockResolvedValue({
        text: 'transcript',
        language: 'en',
        source: 'manual',
      });

      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockNotion.uploadFile).toHaveBeenCalled();
    });

    it('should continue when Notion audio upload fails', async () => {
      mockYtTranscript.fetch.mockResolvedValue({
        text: 'transcript',
        language: 'en',
        source: 'manual',
      });
      mockNotion.uploadFile.mockRejectedValue(new Error('upload failed'));

      // Should not throw
      const result = await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalled();
    });

    it('should create Notion page with correct arguments', async () => {
      mockYtTranscript.fetch.mockResolvedValue({
        text: 'transcript text',
        language: 'en',
        source: 'manual',
      });

      await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Video',
          transcript: 'transcript text',
          source: 'YouTube',
        })
      );
    });

    it('should return { pageId, notionUrl, title, url }', async () => {
      mockYtTranscript.fetch.mockResolvedValue({
        text: 'transcript',
        language: 'en',
        source: 'manual',
      });

      const result = await pipeline.ingest('https://youtube.com/watch?v=test');

      expect(result).toHaveProperty('pageId', 'page-abc-123');
      expect(result).toHaveProperty('notionUrl');
      expect(result).toHaveProperty('title', 'Test Video');
      expect(result).toHaveProperty('url');
    });

    it('should clean up temp files in finally block', async () => {
      mockYtTranscript.fetch.mockResolvedValue({
        text: 'transcript',
        language: 'en',
        source: 'manual',
      });

      await pipeline.ingest('https://youtube.com/watch?v=test');

      // cleanupTemp should have been called for download path
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should produce fallback transcript when no scriberr configured', async () => {
      mockYtTranscript.fetch.mockResolvedValue(null);
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      const pipelineNoScriberr = new MediaPipeline({
        notionClient: mockNotion,
        scriberrClient: null,
        groqTranscriber: null,
        config: {
          inboxDir: '/test/inbox',
          processedDir: '/test/processed',
          tempDir: '/test/temp',
        },
      });

      // Need to set up the sub-component mocks for the new pipeline
      pipelineNoScriberr.downloader = mockDownloader;
      pipelineNoScriberr.extractor = mockExtractor;
      pipelineNoScriberr.ytTranscript = mockYtTranscript;

      await pipelineNoScriberr.ingest('https://youtube.com/watch?v=test');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({
          transcript: expect.stringContaining('not available'),
        })
      );
    });
  });

  describe('ingestFile()', () => {
    it('should determine audio vs video via extractor.isAudioOnly', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockExtractor.isAudioOnly).toHaveBeenCalledWith('/test/inbox/audio.mp3');
    });

    it('should not convert when audio extension matches target format', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockExtractor.convert).not.toHaveBeenCalled();
    });

    it('should convert audio to target format when extension differs', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.wav');

      expect(mockExtractor.convert).toHaveBeenCalled();
    });

    it('should extract audio from video files', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(false);

      await pipeline.ingestFile('/test/inbox/video.mp4');

      expect(mockExtractor.extract).toHaveBeenCalled();
    });

    it('should create Notion page with source "Audio" for audio files', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'Audio' })
      );
    });

    it('should create Notion page with source "Video" for video files', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(false);

      await pipeline.ingestFile('/test/inbox/video.mp4');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'Video' })
      );
    });

    it('should derive title from filename', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/my_recording-file.mp3');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'my recording file' })
      );
    });

    it('should return { pageId, notionUrl, title }', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      const result = await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(result).toHaveProperty('pageId', 'page-abc-123');
      expect(result).toHaveProperty('notionUrl');
      expect(result).toHaveProperty('title');
    });

    it('should handle isAudioOnly failure by falling back to extension regex', async () => {
      mockExtractor.isAudioOnly.mockRejectedValue(new Error('ffprobe failed'));

      // .mp3 should be detected as audio via fallback regex
      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'Audio' })
      );
    });

    it('should use opts.title override instead of deriving from filename', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3', { title: 'Custom Title' });

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Custom Title' })
      );
    });

    it('should call groq.generateTitle when transcript > 50 chars', async () => {
      mockGroq.generateTitle = vi.fn().mockResolvedValue('AI Generated Title');
      mockGroq.transcribe.mockResolvedValue({ text: 'x'.repeat(60), language: 'en' });
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockGroq.generateTitle).toHaveBeenCalledWith('x'.repeat(60));
      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'AI Generated Title' })
      );
    });

    it('should keep derived title when groq.generateTitle returns null', async () => {
      mockGroq.generateTitle = vi.fn().mockResolvedValue(null);
      mockGroq.transcribe.mockResolvedValue({ text: 'x'.repeat(60), language: 'en' });
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/my_recording.mp3');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'my recording' })
      );
    });

    it('should not call groq.generateTitle when transcript <= 50 chars', async () => {
      mockGroq.generateTitle = vi.fn();
      mockGroq.transcribe.mockResolvedValue({ text: 'short', language: 'en' });
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockGroq.generateTitle).not.toHaveBeenCalled();
    });

    it('should skip title generation when groq is null', async () => {
      pipeline.groq = null;
      mockScriberr.getJob.mockResolvedValue({ status: 'completed' });
      mockScriberr.getTranscript.mockResolvedValue({ text: 'x'.repeat(60), language: 'en' });
      vi.spyOn(pipeline, 'sleep').mockResolvedValue();
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'audio' })
      );
    });

    it('should pass sourceRef (filePath) to createTranscriptPage', async () => {
      mockExtractor.isAudioOnly.mockResolvedValue(true);

      await pipeline.ingestFile('/test/inbox/audio.mp3');

      expect(mockNotion.createTranscriptPage).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRef: '/test/inbox/audio.mp3' })
      );
    });
  });

  describe('transcribeViaScriberr()', () => {
    it('should try Groq first when configured', async () => {
      await pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3');

      expect(mockGroq.transcribe).toHaveBeenCalledWith('/path/to/audio.mp3');
    });

    it('should return Groq result when successful', async () => {
      const result = await pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3');

      expect(result).toEqual({ text: 'groq text', language: 'en' });
    });

    it('should fall back to Scriberr when Groq fails', async () => {
      mockGroq.transcribe.mockRejectedValue(new Error('Groq error'));
      mockScriberr.getJob.mockResolvedValue({ status: 'completed' });
      mockScriberr.getTranscript.mockResolvedValue({ text: 'scriberr text', language: 'en' });

      // Mock sleep to avoid real delays
      vi.spyOn(pipeline, 'sleep').mockResolvedValue();

      const result = await pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3');

      expect(mockScriberr.submitFile).toHaveBeenCalled();
    });

    it('should skip Groq when groq client is null', async () => {
      pipeline.groq = null;
      mockScriberr.getJob.mockResolvedValue({ status: 'completed' });
      mockScriberr.getTranscript.mockResolvedValue({ text: 'text', language: 'en' });
      vi.spyOn(pipeline, 'sleep').mockResolvedValue();

      await pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3');

      expect(mockGroq.transcribe).not.toHaveBeenCalled();
      expect(mockScriberr.submitFile).toHaveBeenCalled();
    });

    it('should throw when job status is "failed"', async () => {
      pipeline.groq = null;
      mockScriberr.getJob.mockResolvedValue({ status: 'failed' });
      vi.spyOn(pipeline, 'sleep').mockResolvedValue();

      await expect(pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3'))
        .rejects.toThrow('Scriberr transcription failed');
    });

    it('should throw when job status is "error"', async () => {
      pipeline.groq = null;
      mockScriberr.getJob.mockResolvedValue({ status: 'error' });
      vi.spyOn(pipeline, 'sleep').mockResolvedValue();

      await expect(pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3'))
        .rejects.toThrow('Scriberr transcription failed');
    });

    it('should return transcript when job status is "done"', async () => {
      pipeline.groq = null;
      mockScriberr.getJob.mockResolvedValue({ status: 'done' });
      mockScriberr.getTranscript.mockResolvedValue({ text: 'done text', language: 'en' });
      vi.spyOn(pipeline, 'sleep').mockResolvedValue();

      const result = await pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3');

      expect(result.text).toBe('done text');
    });

    it('should throw on timeout', async () => {
      pipeline.groq = null;
      mockScriberr.getJob.mockResolvedValue({ status: 'processing' });

      // Make Date.now return values that exceed 30 min timeout
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        if (callCount === 1) return 0; // Initial startTime
        return 31 * 60 * 1000; // 31 minutes later
      });

      vi.spyOn(pipeline, 'sleep').mockResolvedValue();

      await expect(pipeline.transcribeViaScriberr('/path/to/audio.mp3', 'audio.mp3'))
        .rejects.toThrow('timed out');
    });
  });

  describe('getSourceCategory() - pure logic', () => {
    it('should return "YouTube" for youtube sourceType', () => {
      expect(pipeline.getSourceCategory({ sourceType: 'youtube' })).toBe('YouTube');
    });

    it('should return "Video" for vimeo sourceType', () => {
      expect(pipeline.getSourceCategory({ sourceType: 'vimeo' })).toBe('Video');
    });

    it('should return "Video" for twitch sourceType', () => {
      expect(pipeline.getSourceCategory({ sourceType: 'twitch' })).toBe('Video');
    });

    it('should return "Video" for tiktok sourceType', () => {
      expect(pipeline.getSourceCategory({ sourceType: 'tiktok' })).toBe('Video');
    });

    it('should return "Video" for direct_video sourceType', () => {
      expect(pipeline.getSourceCategory({ sourceType: 'direct_video' })).toBe('Video');
    });

    it('should return "Audio" for other sourceType', () => {
      expect(pipeline.getSourceCategory({ sourceType: 'spotify' })).toBe('Audio');
      expect(pipeline.getSourceCategory({ sourceType: 'soundcloud' })).toBe('Audio');
      expect(pipeline.getSourceCategory({ sourceType: 'other' })).toBe('Audio');
    });
  });

  describe('moveToProcessed()', () => {
    it('should copy file from inbox to processed directory', () => {
      pipeline.moveToProcessed('test.mp3');

      expect(fs.copyFileSync).toHaveBeenCalledWith(
        '/test/inbox/test.mp3',
        '/test/processed/test.mp3'
      );
    });

    it('should delete original file after copy', () => {
      pipeline.moveToProcessed('test.mp3');

      expect(fs.unlinkSync).toHaveBeenCalledWith('/test/inbox/test.mp3');
    });

    it('should append ".failed" suffix when failed=true', () => {
      pipeline.moveToProcessed('test.mp3', true);

      expect(fs.copyFileSync).toHaveBeenCalledWith(
        '/test/inbox/test.mp3',
        '/test/processed/test.mp3.failed'
      );
    });

    it('should do nothing when source file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      pipeline.moveToProcessed('missing.mp3');

      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('should not throw on copy/delete errors', () => {
      fs.copyFileSync.mockImplementation(() => { throw new Error('EPERM'); });

      expect(() => pipeline.moveToProcessed('test.mp3')).not.toThrow();
    });
  });

  describe('cleanupTemp()', () => {
    it('should delete file when it exists', () => {
      fs.existsSync.mockReturnValue(true);

      pipeline.cleanupTemp('/tmp/file.mp3');

      expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/file.mp3');
    });

    it('should do nothing when filePath is null', () => {
      fs.unlinkSync.mockClear();
      pipeline.cleanupTemp(null);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should do nothing when file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      pipeline.cleanupTemp('/tmp/missing.mp3');

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should not throw on unlink errors', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => { throw new Error('EPERM'); });

      expect(() => pipeline.cleanupTemp('/tmp/locked.mp3')).not.toThrow();
    });
  });

  describe('sleep()', () => {
    it('should return a Promise that resolves', async () => {
      const promise = pipeline.sleep(100);
      vi.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
    });
  });
});
