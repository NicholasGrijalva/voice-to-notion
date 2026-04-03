const { PLATFORMS, formatPreview, splitThread } = require('../../../src/publish/platforms');

describe('PLATFORMS', () => {
  it('has correct entries for all five platforms', () => {
    expect(Object.keys(PLATFORMS)).toEqual(
      expect.arrayContaining(['twitter', 'linkedin', 'bluesky', 'threads', 'mastodon'])
    );
    expect(Object.keys(PLATFORMS)).toHaveLength(5);
  });

  it('twitter has 280 char limit and supports threads', () => {
    expect(PLATFORMS.twitter).toEqual({ name: 'X', maxChars: 280, supportsThreads: true });
  });

  it('linkedin has 3000 char limit and does not support threads', () => {
    expect(PLATFORMS.linkedin).toEqual({ name: 'LinkedIn', maxChars: 3000, supportsThreads: false });
  });

  it('bluesky has 300 char limit and supports threads', () => {
    expect(PLATFORMS.bluesky).toEqual({ name: 'Bluesky', maxChars: 300, supportsThreads: true });
  });

  it('threads has 500 char limit and supports threads', () => {
    expect(PLATFORMS.threads).toEqual({ name: 'Threads', maxChars: 500, supportsThreads: true });
  });

  it('mastodon has 500 char limit and supports threads', () => {
    expect(PLATFORMS.mastodon).toEqual({ name: 'Mastodon', maxChars: 500, supportsThreads: true });
  });
});

describe('formatPreview', () => {
  it('text under all limits returns all ok and empty overLimit', () => {
    const text = 'Short text';
    const result = formatPreview(text, ['twitter', 'linkedin', 'bluesky', 'threads', 'mastodon']);

    expect(result.overLimit).toEqual([]);
    expect(result.needsThread).toEqual([]);
    for (const key of Object.keys(result.platforms)) {
      expect(result.platforms[key].ok).toBe(true);
    }
  });

  it('text over twitter limit but under linkedin puts twitter in overLimit and needsThread', () => {
    const text = 'a'.repeat(300);
    const result = formatPreview(text, ['twitter', 'linkedin']);

    expect(result.overLimit).toEqual(['twitter']);
    expect(result.needsThread).toEqual(['twitter']);
    expect(result.platforms.twitter.ok).toBe(false);
    expect(result.platforms.linkedin.ok).toBe(true);
  });

  it('text at exact limit returns ok true', () => {
    const text = 'a'.repeat(280);
    const result = formatPreview(text, ['twitter']);

    expect(result.platforms.twitter.ok).toBe(true);
    expect(result.overLimit).toEqual([]);
  });

  it('ignores unknown platform keys', () => {
    const text = 'Hello';
    const result = formatPreview(text, ['twitter', 'fakePlatform', 'linkedin']);

    expect(Object.keys(result.platforms)).toEqual(['twitter', 'linkedin']);
    expect(result.overLimit).toEqual([]);
  });

  it('records chars and maxChars in platform entries', () => {
    const text = 'Test message';
    const result = formatPreview(text, ['twitter']);

    expect(result.platforms.twitter.chars).toBe(text.length);
    expect(result.platforms.twitter.maxChars).toBe(280);
  });

  it('linkedin in overLimit but not needsThread when over limit (no thread support)', () => {
    const text = 'a'.repeat(3001);
    const result = formatPreview(text, ['linkedin']);

    expect(result.overLimit).toEqual(['linkedin']);
    expect(result.needsThread).toEqual([]);
  });
});

describe('splitThread', () => {
  it('text under limit returns single-element array', () => {
    const text = 'Short post.';
    const result = splitThread(text, 280);

    expect(result).toEqual([text]);
  });

  it('two paragraphs each under limit but combined over splits into two posts', () => {
    const p1 = 'a'.repeat(200);
    const p2 = 'b'.repeat(200);
    const text = p1 + '\n\n' + p2;
    const result = splitThread(text, 280);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
  });

  it('long single paragraph splits on sentence boundaries', () => {
    // Build sentences that individually fit but together exceed limit
    const s1 = 'This is the first sentence.';
    const s2 = 'This is the second sentence.';
    const s3 = 'This is the third sentence.';
    const text = s1 + ' ' + s2 + ' ' + s3;
    const limit = s1.length + 1 + s2.length + 5; // fits s1+s2 but not s3
    const result = splitThread(text, limit);

    expect(result.length).toBeGreaterThan(1);
    // Each post should be within the limit
    for (const post of result) {
      expect(post.length).toBeLessThanOrEqual(limit);
    }
  });

  it('very long sentence hard-breaks at word boundary', () => {
    const words = [];
    for (let i = 0; i < 30; i++) words.push('longword');
    const text = words.join(' '); // no sentence-ending punctuation
    const limit = 50;
    const result = splitThread(text, limit);

    expect(result.length).toBeGreaterThan(1);
    for (const post of result) {
      expect(post.length).toBeLessThanOrEqual(limit);
    }
  });

  it('preserves paragraph structure when paragraphs fit in posts', () => {
    const p1 = 'First paragraph here.';
    const p2 = 'Second paragraph here.';
    const p3 = 'Third paragraph here.';
    const text = [p1, p2, p3].join('\n\n');
    // Limit large enough for each paragraph but not all three combined
    const limit = p1.length + 4 + p2.length; // fits p1+p2 combined
    const result = splitThread(text, limit);

    expect(result[0]).toContain('First');
    expect(result[0]).toContain('Second');
    // Third should be in a separate post
    expect(result.length).toBe(2);
    expect(result[1]).toBe(p3);
  });

  it('defaults to 280 char limit', () => {
    // Two paragraphs that together exceed 280 chars but individually fit
    const p1 = 'First paragraph. '.repeat(10).trim(); // ~170 chars
    const p2 = 'Second paragraph. '.repeat(10).trim(); // ~180 chars
    const text = p1 + '\n\n' + p2;
    const result = splitThread(text);

    expect(result.length).toBeGreaterThan(1);
    for (const post of result) {
      expect(post.length).toBeLessThanOrEqual(280);
    }
  });
});
