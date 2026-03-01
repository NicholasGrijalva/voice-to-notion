const fs = require('fs');
const child_process = require('child_process');

// Spy on execFile at MODULE LEVEL before requiring the source.
// The source destructures: const { execFile } = require('child_process')
// so it captures the reference at require-time. The spy must exist first.
const execFileSpy = vi.spyOn(child_process, 'execFile');

const AudioExtractor = require('../../src/audio-extractor');

describe('AudioExtractor', () => {
  let extractor;

  beforeEach(() => {
    // Set up fs spies (source accesses these through the fs object, so
    // beforeEach timing is fine)
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 5000000 });

    extractor = new AudioExtractor();
  });

  afterEach(() => {
    // Restore fs spies so they get re-created fresh in next beforeEach.
    // Do NOT use vi.restoreAllMocks() as it would unwrap execFileSpy.
    fs.existsSync.mockRestore();
    fs.mkdirSync.mockRestore();
    fs.statSync.mockRestore();
  });

  describe('constructor', () => {
    it('should use default ffmpeg and ffprobe paths', () => {
      expect(extractor.ffmpegPath).toBe('ffmpeg');
      expect(extractor.ffprobePath).toBe('ffprobe');
    });

    it('should use default output directory', () => {
      expect(extractor.outputDir).toBe('/tmp/audio-extracted');
    });

    it('should use custom options when provided', () => {
      const custom = new AudioExtractor({
        ffmpegPath: '/usr/local/bin/ffmpeg',
        ffprobePath: '/usr/local/bin/ffprobe',
        outputDir: '/custom/output',
        timeout: 60000,
      });
      expect(custom.ffmpegPath).toBe('/usr/local/bin/ffmpeg');
      expect(custom.ffprobePath).toBe('/usr/local/bin/ffprobe');
      expect(custom.outputDir).toBe('/custom/output');
      expect(custom.timeout).toBe(60000);
    });

    it('should create output directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      new AudioExtractor({ outputDir: '/new/dir' });
      expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true });
    });

    it('should not create directory if it already exists', () => {
      fs.existsSync.mockReturnValue(true);
      fs.mkdirSync.mockClear();
      new AudioExtractor();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('extract()', () => {
    beforeEach(() => {
      // Mock successful ffmpeg exec
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'ffmpeg') {
          cb(null, '', '');
        } else if (cmd === 'ffprobe') {
          cb(null, JSON.stringify({
            format: { duration: '120.5' }
          }), '');
        }
      });
    });

    it('should throw when input file does not exist', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p === '/nonexistent/file.mp4') return false;
        return true;
      });

      await expect(extractor.extract('/nonexistent/file.mp4'))
        .rejects.toThrow('Input file not found');
    });

    it('should build correct ffmpeg args with default options', async () => {
      await extractor.extract('/input/video.mp4');

      const ffmpegCall = execFileSpy.mock.calls.find(c => c[0] === 'ffmpeg');
      const args = ffmpegCall[1];

      expect(args).toContain('-i');
      expect(args).toContain('/input/video.mp4');
      expect(args).toContain('-vn');
      expect(args).toContain('-acodec');
      expect(args).toContain('libmp3lame');
      expect(args).toContain('-ab');
      expect(args).toContain('192k');
      expect(args).toContain('-y');
    });

    it('should include -ac 1 flag when mono=true', async () => {
      await extractor.extract('/input/video.mp4', { mono: true });

      const ffmpegCall = execFileSpy.mock.calls.find(c => c[0] === 'ffmpeg');
      const args = ffmpegCall[1];

      expect(args).toContain('-ac');
      expect(args).toContain('1');
    });

    it('should include -ar flag when sampleRate provided', async () => {
      await extractor.extract('/input/video.mp4', { sampleRate: 16000 });

      const ffmpegCall = execFileSpy.mock.calls.find(c => c[0] === 'ffmpeg');
      const args = ffmpegCall[1];

      expect(args).toContain('-ar');
      expect(args).toContain('16000');
    });

    it('should use custom outputFilename when provided', async () => {
      await extractor.extract('/input/video.mp4', { outputFilename: 'custom_name' });

      const ffmpegCall = execFileSpy.mock.calls.find(c => c[0] === 'ffmpeg');
      const args = ffmpegCall[1];
      const outputPath = args[args.length - 1];

      expect(outputPath).toContain('custom_name.mp3');
    });

    it('should derive output filename from input basename', async () => {
      await extractor.extract('/input/my_video.mp4');

      const ffmpegCall = execFileSpy.mock.calls.find(c => c[0] === 'ffmpeg');
      const args = ffmpegCall[1];
      const outputPath = args[args.length - 1];

      expect(outputPath).toContain('my_video.mp3');
    });

    it('should return result with correct structure', async () => {
      const result = await extractor.extract('/input/video.mp4');

      expect(result).toHaveProperty('filePath');
      expect(result).toHaveProperty('filename');
      expect(result).toHaveProperty('duration', 120.5);
      expect(result).toHaveProperty('format', 'mp3');
      expect(result).toHaveProperty('fileSize', 5000000);
      expect(result).toHaveProperty('contentType', 'audio/mpeg');
    });
  });

  describe('getDuration()', () => {
    it('should call ffprobe and parse duration from JSON output', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({ format: { duration: '185.5' } }), '');
      });

      const duration = await extractor.getDuration('/path/to/audio.mp3');
      expect(duration).toBe(185.5);
    });

    it('should return 0 when ffprobe fails', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('ffprobe error'), '', 'error');
      });

      const duration = await extractor.getDuration('/path/to/audio.mp3');
      expect(duration).toBe(0);
    });

    it('should return 0 when duration field is missing', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({ format: {} }), '');
      });

      const duration = await extractor.getDuration('/path/to/audio.mp3');
      expect(duration).toBe(0);
    });
  });

  describe('getInfo()', () => {
    it('should identify audio-only files', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({
          format: { duration: '120', size: '5000000', bit_rate: '192000' },
          streams: [
            { codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: '2' }
          ]
        }), '');
      });

      const info = await extractor.getInfo('/path/to/audio.mp3');

      expect(info.hasAudio).toBe(true);
      expect(info.hasVideo).toBe(false);
      expect(info.audioCodec).toBe('mp3');
      expect(info.videoCodec).toBeNull();
    });

    it('should identify video files with both streams', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({
          format: { duration: '300', size: '50000000', bit_rate: '1500000' },
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: '2' }
          ]
        }), '');
      });

      const info = await extractor.getInfo('/path/to/video.mp4');

      expect(info.hasAudio).toBe(true);
      expect(info.hasVideo).toBe(true);
      expect(info.audioCodec).toBe('aac');
      expect(info.videoCodec).toBe('h264');
    });

    it('should return null for codec fields when stream not present', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({
          format: { duration: '120', size: '5000000' },
          streams: []
        }), '');
      });

      const info = await extractor.getInfo('/path/to/file');

      expect(info.audioCodec).toBeNull();
      expect(info.videoCodec).toBeNull();
      expect(info.sampleRate).toBeNull();
      expect(info.channels).toBeNull();
    });

    it('should parse sampleRate, channels, bitrate as integers', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({
          format: { duration: '120', size: '5000000', bit_rate: '192000' },
          streams: [
            { codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: '2' }
          ]
        }), '');
      });

      const info = await extractor.getInfo('/path/to/audio.mp3');

      expect(info.sampleRate).toBe(44100);
      expect(info.channels).toBe(2);
      expect(info.bitrate).toBe(192000);
    });
  });

  describe('isAudioOnly()', () => {
    it('should return true for audio-only files', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({
          format: { duration: '120', size: '5000000' },
          streams: [
            { codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: '2' }
          ]
        }), '');
      });

      const result = await extractor.isAudioOnly('/path/to/audio.mp3');
      expect(result).toBe(true);
    });

    it('should return false for files with video stream', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, JSON.stringify({
          format: { duration: '300', size: '50000000' },
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: '2' }
          ]
        }), '');
      });

      const result = await extractor.isAudioOnly('/path/to/video.mp4');
      expect(result).toBe(false);
    });
  });

  describe('convert()', () => {
    it('should delegate to extract() with same arguments', async () => {
      const extractSpy = vi.spyOn(extractor, 'extract').mockResolvedValue({ filePath: '/out.mp3' });

      await extractor.convert('/input.wav', { format: 'm4a' });

      expect(extractSpy).toHaveBeenCalledWith('/input.wav', { format: 'm4a' });
    });
  });

  describe('getCodec() - pure logic', () => {
    it('should return libmp3lame for mp3', () => {
      expect(extractor.getCodec('mp3')).toBe('libmp3lame');
    });

    it('should return aac for m4a', () => {
      expect(extractor.getCodec('m4a')).toBe('aac');
    });

    it('should return pcm_s16le for wav', () => {
      expect(extractor.getCodec('wav')).toBe('pcm_s16le');
    });

    it('should return libvorbis for ogg', () => {
      expect(extractor.getCodec('ogg')).toBe('libvorbis');
    });

    it('should return flac for flac', () => {
      expect(extractor.getCodec('flac')).toBe('flac');
    });

    it('should return libopus for opus', () => {
      expect(extractor.getCodec('opus')).toBe('libopus');
    });

    it('should return libmp3lame for unknown format', () => {
      expect(extractor.getCodec('xyz')).toBe('libmp3lame');
    });
  });

  describe('getMimeType() - pure logic', () => {
    it('should return audio/mpeg for mp3', () => {
      expect(extractor.getMimeType('mp3')).toBe('audio/mpeg');
    });

    it('should return audio/mp4 for m4a', () => {
      expect(extractor.getMimeType('m4a')).toBe('audio/mp4');
    });

    it('should return audio/wav for wav', () => {
      expect(extractor.getMimeType('wav')).toBe('audio/wav');
    });

    it('should return audio/ogg for ogg', () => {
      expect(extractor.getMimeType('ogg')).toBe('audio/ogg');
    });

    it('should return audio/flac for flac', () => {
      expect(extractor.getMimeType('flac')).toBe('audio/flac');
    });

    it('should return audio/opus for opus', () => {
      expect(extractor.getMimeType('opus')).toBe('audio/opus');
    });

    it('should return audio/mpeg for unknown format', () => {
      expect(extractor.getMimeType('xyz')).toBe('audio/mpeg');
    });
  });

  describe('exec()', () => {
    it('should resolve with trimmed stdout and stderr on success', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(null, '  output  \n', '  warnings  \n');
      });

      const result = await extractor.exec('ffmpeg', ['-i', 'test']);
      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('warnings');
    });

    it('should reject with descriptive error including command name', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('command failed'), '', 'detailed error');
      });

      await expect(extractor.exec('ffmpeg', []))
        .rejects.toThrow('ffmpeg failed: detailed error');
    });

    it('should use error.message when stderr is empty', async () => {
      execFileSpy.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('signal killed'), '', '');
      });

      await expect(extractor.exec('ffprobe', []))
        .rejects.toThrow('ffprobe failed: signal killed');
    });
  });
});
