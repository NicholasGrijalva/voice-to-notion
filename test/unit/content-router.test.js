const ContentRouter = require('../../src/content-router');

describe('ContentRouter', () => {
  describe('detect()', () => {
    describe('YouTube URLs', () => {
      it('should detect standard youtube.com watch URL', () => {
        const result = ContentRouter.detect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(result).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
      });

      it('should detect youtu.be short URL', () => {
        const result = ContentRouter.detect('https://youtu.be/dQw4w9WgXcQ');
        expect(result).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
      });

      it('should detect YouTube Shorts URL', () => {
        const result = ContentRouter.detect('https://www.youtube.com/shorts/abc123DEF_-');
        expect(result).toEqual({ type: 'youtube', id: 'abc123DEF_-' });
      });

      it('should detect YouTube embed URL', () => {
        const result = ContentRouter.detect('https://www.youtube.com/embed/dQw4w9WgXcQ');
        expect(result).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
      });

      it('should extract 11-char video ID with hyphens and underscores', () => {
        const result = ContentRouter.detect('https://youtube.com/watch?v=a-B_c1D2e3f');
        expect(result).toEqual({ type: 'youtube', id: 'a-B_c1D2e3f' });
      });

      it('should handle YouTube URL with extra query params', () => {
        const result = ContentRouter.detect('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120');
        expect(result).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
      });
    });

    describe('Twitter/X URLs', () => {
      it('should detect twitter.com status URL', () => {
        const result = ContentRouter.detect('https://twitter.com/elonmusk/status/1234567890123456789');
        expect(result).toEqual({ type: 'twitter', id: '1234567890123456789' });
      });

      it('should detect x.com status URL', () => {
        const result = ContentRouter.detect('https://x.com/openai/status/9876543210');
        expect(result).toEqual({ type: 'twitter', id: '9876543210' });
      });

      it('should detect twitter.com statuses (plural) URL', () => {
        const result = ContentRouter.detect('https://twitter.com/user/statuses/1234567890123456789');
        expect(result).toEqual({ type: 'twitter', id: '1234567890123456789' });
      });
    });

    describe('PDF URLs', () => {
      it('should detect URL ending in .pdf', () => {
        const result = ContentRouter.detect('https://example.com/paper.pdf');
        expect(result).toEqual({ type: 'pdf', id: null });
      });

      it('should detect .pdf with query params', () => {
        const result = ContentRouter.detect('https://example.com/doc.pdf?version=2');
        expect(result).toEqual({ type: 'pdf', id: null });
      });

      it('should detect .pdf with hash fragment', () => {
        const result = ContentRouter.detect('https://example.com/doc.pdf#page=5');
        expect(result).toEqual({ type: 'pdf', id: null });
      });

      it('should detect .PDF (case-insensitive)', () => {
        const result = ContentRouter.detect('https://example.com/PAPER.PDF');
        expect(result).toEqual({ type: 'pdf', id: null });
      });
    });

    describe('Perplexity URLs', () => {
      it('should detect perplexity.ai URL', () => {
        const result = ContentRouter.detect('https://www.perplexity.ai/search/some-topic');
        expect(result).toEqual({ type: 'perplexity', id: null });
      });
    });

    describe('LinkedIn URLs', () => {
      it('should detect linkedin.com posts URL', () => {
        const result = ContentRouter.detect('https://www.linkedin.com/posts/username_some-post-id');
        expect(result).toEqual({ type: 'linkedin', id: null });
      });
    });

    describe('Generic webpage URLs', () => {
      it('should detect http URL as webpage', () => {
        const result = ContentRouter.detect('http://example.com/article');
        expect(result).toEqual({ type: 'webpage', id: null });
      });

      it('should detect https URL as webpage', () => {
        const result = ContentRouter.detect('https://blog.example.com/some-post');
        expect(result).toEqual({ type: 'webpage', id: null });
      });
    });

    describe('unsupported inputs', () => {
      it('should return unsupported for null input', () => {
        const result = ContentRouter.detect(null);
        expect(result).toEqual({ type: 'unsupported', id: null });
      });

      it('should return unsupported for empty string', () => {
        const result = ContentRouter.detect('');
        expect(result).toEqual({ type: 'unsupported', id: null });
      });

      it('should return unsupported for undefined', () => {
        const result = ContentRouter.detect(undefined);
        expect(result).toEqual({ type: 'unsupported', id: null });
      });

      it('should return unsupported for non-http string', () => {
        const result = ContentRouter.detect('ftp://files.example.com/data');
        expect(result).toEqual({ type: 'unsupported', id: null });
      });

      it('should return unsupported for plain text', () => {
        const result = ContentRouter.detect('just some random text');
        expect(result).toEqual({ type: 'unsupported', id: null });
      });
    });

    describe('priority ordering', () => {
      it('should classify YouTube before general webpage', () => {
        const result = ContentRouter.detect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(result.type).toBe('youtube');
      });

      it('should classify Twitter before general webpage', () => {
        const result = ContentRouter.detect('https://twitter.com/user/status/123');
        expect(result.type).toBe('twitter');
      });

      it('should classify PDF before general webpage', () => {
        const result = ContentRouter.detect('https://example.com/doc.pdf');
        expect(result.type).toBe('pdf');
      });
    });
  });

  describe('isMediaUrl()', () => {
    it('should return true for youtube.com URL', () => {
      expect(ContentRouter.isMediaUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    });

    it('should return true for youtu.be URL', () => {
      expect(ContentRouter.isMediaUrl('https://youtu.be/abc')).toBe(true);
    });

    it('should return true for vimeo.com URL', () => {
      expect(ContentRouter.isMediaUrl('https://vimeo.com/12345')).toBe(true);
    });

    it('should return true for soundcloud.com URL', () => {
      expect(ContentRouter.isMediaUrl('https://soundcloud.com/artist/track')).toBe(true);
    });

    it('should return false for spotify.com URL (yt-dlp extractor broken)', () => {
      expect(ContentRouter.isMediaUrl('https://open.spotify.com/episode/abc')).toBe(false);
    });

    it('should return true for tiktok.com URL', () => {
      expect(ContentRouter.isMediaUrl('https://www.tiktok.com/@user/video/123')).toBe(true);
    });

    it('should return true for twitch.tv URL', () => {
      expect(ContentRouter.isMediaUrl('https://www.twitch.tv/channel')).toBe(true);
    });

    it('should return true for Apple Podcasts URL', () => {
      expect(ContentRouter.isMediaUrl('https://podcasts.apple.com/us/podcast/show/id123')).toBe(true);
    });

    it('should return true for direct .mp3 file URL', () => {
      expect(ContentRouter.isMediaUrl('https://example.com/audio.mp3')).toBe(true);
    });

    it('should return true for direct .mp4 file URL', () => {
      expect(ContentRouter.isMediaUrl('https://example.com/video.mp4')).toBe(true);
    });

    it('should return true for .wav file URL with query params', () => {
      expect(ContentRouter.isMediaUrl('https://example.com/file.wav?token=abc')).toBe(true);
    });

    it('should return true for .webm file URL', () => {
      expect(ContentRouter.isMediaUrl('https://example.com/clip.webm')).toBe(true);
    });

    it('should return false for regular webpage URL', () => {
      expect(ContentRouter.isMediaUrl('https://example.com/article')).toBe(false);
    });

    it('should return false for PDF URL', () => {
      expect(ContentRouter.isMediaUrl('https://example.com/doc.pdf')).toBe(false);
    });

    it('should return false for twitter URL', () => {
      expect(ContentRouter.isMediaUrl('https://twitter.com/user/status/123')).toBe(false);
    });
  });

  describe('toNotionType()', () => {
    it('should map youtube to YouTube', () => {
      expect(ContentRouter.toNotionType('youtube')).toBe('YouTube');
    });

    it('should map twitter to Post', () => {
      expect(ContentRouter.toNotionType('twitter')).toBe('Post');
    });

    it('should map pdf to Idea', () => {
      expect(ContentRouter.toNotionType('pdf')).toBe('Idea');
    });

    it('should map perplexity to Idea', () => {
      expect(ContentRouter.toNotionType('perplexity')).toBe('Idea');
    });

    it('should map linkedin to Post', () => {
      expect(ContentRouter.toNotionType('linkedin')).toBe('Post');
    });

    it('should map webpage to Idea', () => {
      expect(ContentRouter.toNotionType('webpage')).toBe('Idea');
    });

    it('should map audio to Audio', () => {
      expect(ContentRouter.toNotionType('audio')).toBe('Audio');
    });

    it('should map video to Video', () => {
      expect(ContentRouter.toNotionType('video')).toBe('Video');
    });

    it('should return Idea for unknown content type', () => {
      expect(ContentRouter.toNotionType('unknown')).toBe('Idea');
    });

    it('should return Idea for undefined content type', () => {
      expect(ContentRouter.toNotionType(undefined)).toBe('Idea');
    });
  });
});
