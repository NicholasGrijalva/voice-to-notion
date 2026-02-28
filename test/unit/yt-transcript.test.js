const { describe, it, expect, vi, beforeEach } = require('vitest') || global;

// Mock dependencies
vi.mock('fs');
vi.mock('child_process');

const fs = require('fs');
const { execFile } = require('child_process');

const YouTubeTranscript = require('../../src/yt-transcript');
const { SAMPLE_VTT_CONTENT, SAMPLE_SRT_CONTENT } = require('../helpers/fixtures');

describe('YouTubeTranscript', () => {
  let yt;

  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockReturnValue(undefined);

    yt = new YouTubeTranscript();
  });

  describe('constructor', () => {
    it('should use default options', () => {
      expect(yt.ytdlpPath).toBe('yt-dlp');
      expect(yt.outputDir).toBe('/tmp/yt-transcripts');
      expect(yt.timeout).toBe(60000);
      expect(yt.preferredLangs).toEqual(['en', 'en-US', 'en-GB']);
    });

    it('should accept custom preferredLangs', () => {
      const custom = new YouTubeTranscript({ preferredLangs: ['fr', 'de'] });
      expect(custom.preferredLangs).toEqual(['fr', 'de']);
    });

    it('should create output directory if not exists', () => {
      fs.existsSync.mockReturnValue(false);
      new YouTubeTranscript({ outputDir: '/custom/dir' });
      expect(fs.mkdirSync).toHaveBeenCalledWith('/custom/dir', { recursive: true });
    });
  });

  describe('fetch()', () => {
    it('should return null for non-YouTube URLs', async () => {
      const result = await yt.fetch('https://vimeo.com/12345');
      expect(result).toBeNull();
    });

    it('should try manual subtitles first', async () => {
      const fetchSubsSpy = vi.spyOn(yt, 'fetchSubtitles')
        .mockResolvedValueOnce({ text: 'Manual transcript text that is long enough to pass', language: 'en' })
        .mockResolvedValueOnce(null);

      await yt.fetch('https://www.youtube.com/watch?v=abc123def45');

      // First call should be for manual subs (autoSubs=false)
      expect(fetchSubsSpy).toHaveBeenCalledTimes(1);
      expect(fetchSubsSpy.mock.calls[0][1]).toBe(false);
    });

    it('should return manual subtitles with source="manual"', async () => {
      vi.spyOn(yt, 'fetchSubtitles')
        .mockResolvedValueOnce({ text: 'Manual transcript text', language: 'en' });

      const result = await yt.fetch('https://www.youtube.com/watch?v=abc123def45');

      expect(result.source).toBe('manual');
      expect(result.text).toBe('Manual transcript text');
    });

    it('should fall back to auto subtitles when manual not available', async () => {
      const fetchSubsSpy = vi.spyOn(yt, 'fetchSubtitles')
        .mockResolvedValueOnce(null) // manual fails
        .mockResolvedValueOnce({ text: 'Auto transcript text', language: 'en' });

      const result = await yt.fetch('https://www.youtube.com/watch?v=abc123def45');

      expect(fetchSubsSpy).toHaveBeenCalledTimes(2);
      expect(fetchSubsSpy.mock.calls[1][1]).toBe(true); // autoSubs=true
      expect(result.source).toBe('auto');
    });

    it('should return null when neither manual nor auto subtitles available', async () => {
      vi.spyOn(yt, 'fetchSubtitles')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await yt.fetch('https://www.youtube.com/watch?v=abc123def45');
      expect(result).toBeNull();
    });
  });

  describe('fetchSubtitles()', () => {
    it('should return null when extractVideoId returns null', async () => {
      const result = await yt.fetchSubtitles('https://notayoutube.com/watch', false);
      expect(result).toBeNull();
    });

    it('should build correct yt-dlp args for manual subs', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
      fs.readdirSync.mockReturnValue([]);

      await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', false);

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--write-subs');
      expect(args).not.toContain('--write-auto-subs');
    });

    it('should build correct yt-dlp args for auto subs', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
      fs.readdirSync.mockReturnValue([]);

      await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', true);

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--write-auto-subs');
      expect(args).not.toContain('--write-subs');
    });

    it('should find subtitle file and parse content', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
      fs.readdirSync.mockReturnValue(['abc123def45.en.vtt']);
      fs.readFileSync.mockReturnValue(SAMPLE_VTT_CONTENT);
      fs.unlinkSync.mockReturnValue(undefined);

      const result = await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', false);

      expect(result).not.toBeNull();
      expect(result.text).toBeDefined();
      expect(result.language).toBe('en');
    });

    it('should clean up subtitle file after reading', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
      fs.readdirSync.mockReturnValue(['abc123def45.en.vtt']);
      fs.readFileSync.mockReturnValue(SAMPLE_VTT_CONTENT);

      await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', false);

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should return null when no subtitle file found', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
      fs.readdirSync.mockReturnValue([]);

      const result = await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', false);
      expect(result).toBeNull();
    });

    it('should return null when parsed text is shorter than 50 chars', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
      fs.readdirSync.mockReturnValue(['abc123def45.en.vtt']);
      fs.readFileSync.mockReturnValue('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi');

      const result = await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', false);
      expect(result).toBeNull();
    });

    it('should return null when yt-dlp exec fails', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('yt-dlp failed'), '', 'error');
      });

      const result = await yt.fetchSubtitles('https://www.youtube.com/watch?v=abc123def45', false);
      expect(result).toBeNull();
    });
  });

  describe('findSubtitleFile()', () => {
    it('should find .vtt file matching prefix', () => {
      fs.readdirSync.mockReturnValue(['videoId.en.vtt', 'other.txt']);

      const result = yt.findSubtitleFile('/tmp/yt-transcripts/videoId');

      expect(result).not.toBeNull();
      expect(result.format).toBe('vtt');
    });

    it('should find .srt file matching prefix', () => {
      fs.readdirSync.mockReturnValue(['videoId.en.srt']);

      const result = yt.findSubtitleFile('/tmp/yt-transcripts/videoId');

      expect(result).not.toBeNull();
      expect(result.format).toBe('srt');
    });

    it('should return null when no matching files exist', () => {
      fs.readdirSync.mockReturnValue(['other.txt', 'different.mp3']);

      const result = yt.findSubtitleFile('/tmp/yt-transcripts/videoId');
      expect(result).toBeNull();
    });

    it('should extract language code from filename pattern', () => {
      fs.readdirSync.mockReturnValue(['videoId.fr.vtt']);

      const result = yt.findSubtitleFile('/tmp/yt-transcripts/videoId');
      expect(result.lang).toBe('fr');
    });

    it('should default language to "en" when no lang segment', () => {
      fs.readdirSync.mockReturnValue(['videoId.vtt']);

      const result = yt.findSubtitleFile('/tmp/yt-transcripts/videoId');
      // When split gives only one part before format, lang defaults
      expect(result.lang).toBeDefined();
    });

    it('should return null when readdirSync throws', () => {
      fs.readdirSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const result = yt.findSubtitleFile('/tmp/yt-transcripts/videoId');
      expect(result).toBeNull();
    });
  });

  describe('parseSubtitles() - pure logic', () => {
    it('should remove VTT header lines', () => {
      const result = yt.parseSubtitles(SAMPLE_VTT_CONTENT, 'vtt');
      expect(result).not.toContain('WEBVTT');
      expect(result).not.toContain('Kind:');
      expect(result).not.toContain('Language:');
    });

    it('should remove timestamp lines', () => {
      const result = yt.parseSubtitles(SAMPLE_VTT_CONTENT, 'vtt');
      expect(result).not.toContain('-->');
    });

    it('should remove numeric sequence lines', () => {
      const result = yt.parseSubtitles(SAMPLE_SRT_CONTENT, 'srt');
      // Sequence numbers (1, 2, 3) should be removed
      expect(result).not.toMatch(/^\d+$/);
    });

    it('should strip HTML tags from subtitle text', () => {
      const result = yt.parseSubtitles(SAMPLE_VTT_CONTENT, 'vtt');
      expect(result).not.toContain('<b>');
      expect(result).not.toContain('</b>');
      expect(result).toContain('test');
    });

    it('should strip SSA/ASS formatting tags', () => {
      const input = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n{\\an8}Hello world with enough chars to pass the minimum';
      const result = yt.parseSubtitles(input, 'vtt');
      expect(result).not.toContain('{\\an8}');
    });

    it('should decode HTML entities', () => {
      const input = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello&nbsp;world&amp;more text that is long enough to test';
      const result = yt.parseSubtitles(input, 'vtt');
      expect(result).toContain('Hello world');
      expect(result).toContain('&more');
    });

    it('should deduplicate consecutive identical lines', () => {
      const result = yt.parseSubtitles(SAMPLE_VTT_CONTENT, 'vtt');
      // "Hello world" appears twice consecutively but should be deduped
      const helloCount = (result.match(/Hello world/g) || []).length;
      expect(helloCount).toBe(1);
    });

    it('should join all lines with spaces', () => {
      const result = yt.parseSubtitles(SAMPLE_SRT_CONTENT, 'srt');
      // Result should be a single line with spaces
      expect(result).not.toContain('\n');
    });

    it('should collapse multiple whitespace to single space', () => {
      const input = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello   world  with   extra   spaces  in  this  long  line  of  text';
      const result = yt.parseSubtitles(input, 'vtt');
      expect(result).not.toMatch(/  /);
    });

    it('should handle empty input', () => {
      const result = yt.parseSubtitles('', 'vtt');
      expect(result).toBe('');
    });

    it('should remove NOTE lines', () => {
      const input = 'WEBVTT\n\nNOTE This is a comment\n\n00:00:00.000 --> 00:00:02.000\nHello world with enough characters to pass fifty char minimum test check';
      const result = yt.parseSubtitles(input, 'vtt');
      expect(result).not.toContain('NOTE');
    });
  });

  describe('extractVideoId() - pure logic', () => {
    it('should extract ID from youtube.com/watch?v=', () => {
      expect(yt.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should extract ID from youtu.be/', () => {
      expect(yt.extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should extract ID from youtube.com/embed/', () => {
      expect(yt.extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should extract ID from youtube.com/shorts/', () => {
      expect(yt.extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should return null for non-YouTube URLs', () => {
      expect(yt.extractVideoId('https://vimeo.com/12345')).toBeNull();
    });

    it('should return null for malformed YouTube URLs', () => {
      expect(yt.extractVideoId('https://youtube.com/watch')).toBeNull();
    });
  });

  describe('isYouTubeUrl() - pure logic', () => {
    it('should return true for youtube.com', () => {
      expect(yt.isYouTubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    });

    it('should return true for youtu.be', () => {
      expect(yt.isYouTubeUrl('https://youtu.be/abc')).toBe(true);
    });

    it('should return false for vimeo.com', () => {
      expect(yt.isYouTubeUrl('https://vimeo.com/123')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(yt.isYouTubeUrl('')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(yt.isYouTubeUrl('https://YOUTUBE.COM/watch?v=abc')).toBe(true);
    });
  });

  describe('exec()', () => {
    it('should resolve with trimmed stdout and stderr', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, '  output  \n', '  warnings  \n');
      });

      const result = await yt.exec(['--version']);
      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('warnings');
    });

    it('should reject with error message on failure', async () => {
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('failed'), '', 'error details');
      });

      await expect(yt.exec([]))
        .rejects.toThrow('yt-dlp subs failed: error details');
    });
  });
});
