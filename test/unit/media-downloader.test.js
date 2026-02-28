const { describe, it, expect, vi, beforeEach } = require('vitest') || global;

// Mock dependencies
vi.mock('fs');
vi.mock('child_process');

const fs = require('fs');
const { execFile } = require('child_process');

const MediaDownloader = require('../../src/media-downloader');
const { SAMPLE_YT_METADATA } = require('../helpers/fixtures');

describe('MediaDownloader', () => {
  let downloader;

  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.statSync.mockReturnValue({ size: 5000000 });
    fs.readdirSync.mockReturnValue([]);

    downloader = new MediaDownloader();
  });

  describe('constructor', () => {
    it('should use default outputDir when none provided', () => {
      expect(downloader.outputDir).toBe('/tmp/media-downloads');
    });

    it('should use custom outputDir when provided', () => {
      const custom = new MediaDownloader({ outputDir: '/custom/downloads' });
      expect(custom.outputDir).toBe('/custom/downloads');
    });

    it('should use custom ytdlpPath when provided', () => {
      const custom = new MediaDownloader({ ytdlpPath: '/usr/bin/yt-dlp' });
      expect(custom.ytdlpPath).toBe('/usr/bin/yt-dlp');
    });

    it('should create output directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      new MediaDownloader({ outputDir: '/new/dir' });
      expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true });
    });

    it('should not create directory if it already exists', () => {
      fs.existsSync.mockReturnValue(true);
      fs.mkdirSync.mockClear();
      new MediaDownloader();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('download()', () => {
    const mockMetadata = { ...SAMPLE_YT_METADATA };

    beforeEach(() => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify(mockMetadata), '');
      });
    });

    it('should build correct yt-dlp args for audio-only download (default)', async () => {
      await downloader.download('https://youtube.com/watch?v=test');

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--extract-audio');
      expect(args).toContain('--audio-format');
      expect(args).toContain('mp3');
      expect(args).toContain('--no-playlist');
      expect(args).toContain('--print-json');
      expect(args).toContain('--no-simulate');
    });

    it('should build correct yt-dlp args for video download', async () => {
      await downloader.download('https://youtube.com/watch?v=test', { audioOnly: false });

      const args = execFile.mock.calls[0][1];
      expect(args).not.toContain('--extract-audio');
    });

    it('should parse JSON metadata from yt-dlp stdout', async () => {
      const result = await downloader.download('https://youtube.com/watch?v=test');

      expect(result.title).toBe('Rick Astley - Never Gonna Give You Up');
      expect(result.duration).toBe(212);
    });

    it('should return correct result structure', async () => {
      const result = await downloader.download('https://youtube.com/watch?v=test');

      expect(result).toHaveProperty('filePath');
      expect(result).toHaveProperty('filename');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('sourceUrl');
      expect(result).toHaveProperty('sourceType');
      expect(result).toHaveProperty('fileSize');
    });

    it('should fall back to metadata.ext path when expected path not found', async () => {
      // First call (expected path) returns false, second (alt path) returns true
      let callCount = 0;
      fs.existsSync.mockImplementation((p) => {
        callCount++;
        if (p.endsWith('.mp3') && callCount <= 2) return false; // Expected path not found
        if (p.endsWith('.mp3') && callCount > 2) return true;  // Alt path found
        return true;
      });

      const result = await downloader.download('https://youtube.com/watch?v=test');
      expect(result.filePath).toBeDefined();
    });

    it('should search output directory for any matching file when both paths missing', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes(SAMPLE_YT_METADATA.id)) return false;
        return true;
      });
      fs.readdirSync.mockReturnValue([`${SAMPLE_YT_METADATA.id}.webm`]);

      const result = await downloader.download('https://youtube.com/watch?v=test');
      expect(result.filePath).toContain(`${SAMPLE_YT_METADATA.id}.webm`);
    });

    it('should throw when downloaded file not found anywhere', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes(SAMPLE_YT_METADATA.id)) return false;
        return true;
      });
      fs.readdirSync.mockReturnValue([]);

      await expect(downloader.download('https://youtube.com/watch?v=test'))
        .rejects.toThrow('Downloaded file not found');
    });

    it('should pass custom format and quality options', async () => {
      await downloader.download('https://youtube.com/watch?v=test', {
        format: 'm4a',
        quality: '5',
      });

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('m4a');
      expect(args).toContain('5');
    });
  });

  describe('buildResult()', () => {
    it('should return structured result with all fields', () => {
      const result = downloader.buildResult(
        '/tmp/test.mp3',
        SAMPLE_YT_METADATA,
        'https://youtube.com/watch?v=test'
      );

      expect(result.filePath).toBe('/tmp/test.mp3');
      expect(result.filename).toBe('test.mp3');
      expect(result.title).toBe('Rick Astley - Never Gonna Give You Up');
      expect(result.duration).toBe(212);
      expect(result.sourceUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(result.sourceType).toBe('youtube');
      expect(result.uploader).toBe('Rick Astley');
    });

    it('should default title to "Untitled" when metadata has no title', () => {
      const result = downloader.buildResult('/tmp/test.mp3', {}, 'https://example.com');
      expect(result.title).toBe('Untitled');
    });

    it('should truncate description to 500 chars', () => {
      const longDesc = 'a'.repeat(600);
      const result = downloader.buildResult(
        '/tmp/test.mp3',
        { ...SAMPLE_YT_METADATA, description: longDesc },
        'https://example.com'
      );
      expect(result.description.length).toBe(500);
    });

    it('should return null description when metadata has none', () => {
      const result = downloader.buildResult(
        '/tmp/test.mp3',
        { ...SAMPLE_YT_METADATA, description: undefined },
        'https://example.com'
      );
      expect(result.description).toBeNull();
    });
  });

  describe('getMetadata()', () => {
    it('should call yt-dlp with --dump-json --no-download flags', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify(SAMPLE_YT_METADATA), '');
      });

      await downloader.getMetadata('https://youtube.com/watch?v=test');

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--dump-json');
      expect(args).toContain('--no-download');
    });

    it('should parse and return JSON metadata', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify(SAMPLE_YT_METADATA), '');
      });

      const result = await downloader.getMetadata('https://youtube.com/watch?v=test');
      expect(result.title).toBe(SAMPLE_YT_METADATA.title);
    });
  });

  describe('listSubtitles()', () => {
    it('should call yt-dlp with --list-subs --skip-download flags', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, 'subtitle info', '');
      });

      await downloader.listSubtitles('https://youtube.com/watch?v=test');

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--list-subs');
      expect(args).toContain('--skip-download');
    });

    it('should return stdout string on success', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, 'Available subtitles: en, fr', '');
      });

      const result = await downloader.listSubtitles('https://youtube.com/watch?v=test');
      expect(result).toBe('Available subtitles: en, fr');
    });

    it('should return null on error', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('no subs'), '', 'error');
      });

      const result = await downloader.listSubtitles('https://youtube.com/watch?v=test');
      expect(result).toBeNull();
    });
  });

  describe('detectSourceType() - pure logic', () => {
    it('should return youtube for youtube.com URLs', () => {
      expect(downloader.detectSourceType('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    });

    it('should return youtube for youtu.be URLs', () => {
      expect(downloader.detectSourceType('https://youtu.be/abc123')).toBe('youtube');
    });

    it('should return spotify for spotify.com URLs', () => {
      expect(downloader.detectSourceType('https://open.spotify.com/episode/abc')).toBe('spotify');
    });

    it('should return apple_podcast for podcasts.apple.com URLs', () => {
      expect(downloader.detectSourceType('https://podcasts.apple.com/us/podcast/abc')).toBe('apple_podcast');
    });

    it('should return soundcloud for soundcloud.com URLs', () => {
      expect(downloader.detectSourceType('https://soundcloud.com/artist/track')).toBe('soundcloud');
    });

    it('should return twitter for twitter.com URLs', () => {
      expect(downloader.detectSourceType('https://twitter.com/user/status/123')).toBe('twitter');
    });

    it('should return twitter for x.com URLs', () => {
      expect(downloader.detectSourceType('https://x.com/user/status/123')).toBe('twitter');
    });

    it('should return tiktok for tiktok.com URLs', () => {
      expect(downloader.detectSourceType('https://www.tiktok.com/@user/video/123')).toBe('tiktok');
    });

    it('should return vimeo for vimeo.com URLs', () => {
      expect(downloader.detectSourceType('https://vimeo.com/123456')).toBe('vimeo');
    });

    it('should return twitch for twitch.tv URLs', () => {
      expect(downloader.detectSourceType('https://www.twitch.tv/videos/123')).toBe('twitch');
    });

    it('should return direct_audio for .mp3 URLs', () => {
      expect(downloader.detectSourceType('https://example.com/file.mp3')).toBe('direct_audio');
    });

    it('should return direct_video for .mp4 URLs', () => {
      expect(downloader.detectSourceType('https://example.com/file.mp4')).toBe('direct_video');
    });

    it('should return other for unrecognized URLs', () => {
      expect(downloader.detectSourceType('https://example.com/page')).toBe('other');
    });

    it('should return unknown for null/undefined input', () => {
      expect(downloader.detectSourceType(null)).toBe('unknown');
      expect(downloader.detectSourceType(undefined)).toBe('unknown');
    });
  });

  describe('exec()', () => {
    it('should resolve with trimmed stdout and stderr on success', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, '  output  \n', '  warnings  \n');
      });

      const result = await downloader.exec(['--version']);
      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('warnings');
    });

    it('should reject with stderr message on error', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('failed'), '', 'yt-dlp: error details');
      });

      await expect(downloader.exec(['--bad-arg']))
        .rejects.toThrow('yt-dlp failed: yt-dlp: error details');
    });

    it('should reject with error.message when stderr is empty', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('signal killed'), '', '');
      });

      await expect(downloader.exec([]))
        .rejects.toThrow('yt-dlp failed: signal killed');
    });

    it('should set PYTHONUNBUFFERED env var', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        expect(opts.env.PYTHONUNBUFFERED).toBe('1');
        cb(null, '{}', '');
      });

      await downloader.exec(['--version']);
    });
  });
});
