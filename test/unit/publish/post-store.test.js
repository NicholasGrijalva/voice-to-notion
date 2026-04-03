const fs = require('fs');
const path = require('path');
const os = require('os');
const PostStore = require('../../../src/publish/post-store');

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `post-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  store = new PostStore(tmpDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// saveDraft
// ---------------------------------------------------------------------------

describe('saveDraft', () => {
  it('creates file in drafts/ directory with correct frontmatter', () => {
    const { filePath } = store.saveDraft('Hello world post', {
      sourceIds: ['abc-123'],
      sourceTitles: ['My Title'],
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain(path.join(tmpDir, 'drafts'));

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('status: draft');
    expect(raw).toContain('source_ids:');
    expect(raw).toContain('"abc-123"');
    expect(raw).toContain('"My Title"');
    expect(raw).toContain('Hello world post');
  });

  it('returns draftId starting with "draft-"', () => {
    const { draftId } = store.saveDraft('Some text');
    expect(draftId).toMatch(/^draft-/);
  });

  it('increments draft number (001, 002, 003)', () => {
    const r1 = store.saveDraft('First draft');
    const r2 = store.saveDraft('Second draft');
    const r3 = store.saveDraft('Third draft');

    expect(r1.draftId).toBe('draft-001');
    expect(r2.draftId).toBe('draft-002');
    expect(r3.draftId).toBe('draft-003');
  });
});

// ---------------------------------------------------------------------------
// getDraft
// ---------------------------------------------------------------------------

describe('getDraft', () => {
  it('returns parsed draft with text and metadata', () => {
    const { draftId } = store.saveDraft('Body text here', {
      sourceIds: ['src-1'],
      sourceTitles: ['Title One'],
    });

    const draft = store.getDraft(draftId);

    expect(draft).not.toBeNull();
    expect(draft.id).toBe(draftId);
    expect(draft.text).toBe('Body text here');
    expect(draft.status).toBe('draft');
    expect(draft.source_ids).toEqual(['src-1']);
    expect(draft.source_titles).toEqual(['Title One']);
    expect(draft.created).toBeDefined();
  });

  it('returns null for non-existent draft', () => {
    const result = store.getDraft('draft-999');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listDrafts
// ---------------------------------------------------------------------------

describe('listDrafts', () => {
  it('returns all drafts sorted newest-first', () => {
    store.saveDraft('First post');
    store.saveDraft('Second post');
    store.saveDraft('Third post');

    const drafts = store.listDrafts();

    expect(drafts).toHaveLength(3);
    // Newest (003) should come first due to reverse sort
    expect(drafts[0].id).toBe('draft-003');
    expect(drafts[1].id).toBe('draft-002');
    expect(drafts[2].id).toBe('draft-001');
  });

  it('returns empty array when no drafts', () => {
    const drafts = store.listDrafts();
    expect(drafts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteDraft
// ---------------------------------------------------------------------------

describe('deleteDraft', () => {
  it('removes file and returns true', () => {
    const { draftId, filePath } = store.saveDraft('Doomed draft');

    expect(fs.existsSync(filePath)).toBe(true);

    const result = store.deleteDraft(draftId);

    expect(result).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('returns false for non-existent draft', () => {
    const result = store.deleteDraft('draft-999');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markPublished
// ---------------------------------------------------------------------------

describe('markPublished', () => {
  it('creates file in published/ directory', () => {
    const { publishedId, filePath } = store.markPublished(null, {
      text: 'Published content',
      sourceIds: ['s1'],
      sourceTitles: ['Source One'],
      platforms: ['twitter'],
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain(path.join(tmpDir, 'published'));
    expect(publishedId).toMatch(/^pub-/);
  });

  it('includes platforms, typefully_draft_id, post_urls in frontmatter', () => {
    const { filePath } = store.markPublished(null, {
      text: 'Content here',
      platforms: ['twitter', 'linkedin'],
      typefullyDraftId: 'tf-abc',
      postUrls: { twitter: 'https://x.com/post/1' },
    });

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('"twitter"');
    expect(raw).toContain('"linkedin"');
    expect(raw).toContain('typefully_draft_id: tf-abc');
    expect(raw).toContain('twitter:');
    expect(raw).toContain('https://x.com/post/1');
  });

  it('deletes source draft when draftId provided', () => {
    const { draftId, filePath: draftPath } = store.saveDraft('Draft to publish');

    expect(fs.existsSync(draftPath)).toBe(true);

    store.markPublished(draftId, {
      text: 'Draft to publish',
      platforms: ['twitter'],
    });

    expect(fs.existsSync(draftPath)).toBe(false);
    expect(store.getDraft(draftId)).toBeNull();
  });

  it('works without draftId (creates directly)', () => {
    const { publishedId, filePath } = store.markPublished(null, {
      text: 'Direct publish, no draft',
      platforms: ['linkedin'],
    });

    expect(publishedId).toMatch(/^pub-/);
    expect(fs.existsSync(filePath)).toBe(true);

    const post = store.getPublished(publishedId);
    expect(post.text).toBe('Direct publish, no draft');
  });
});

// ---------------------------------------------------------------------------
// getPublished
// ---------------------------------------------------------------------------

describe('getPublished', () => {
  it('returns parsed published post', () => {
    const { publishedId } = store.markPublished(null, {
      text: 'Published body',
      sourceIds: ['s1'],
      sourceTitles: ['Title'],
      platforms: ['twitter'],
      typefullyDraftId: 'tf-1',
      postUrls: { twitter: 'https://x.com/1' },
    });

    const post = store.getPublished(publishedId);

    expect(post).not.toBeNull();
    expect(post.id).toBe(publishedId);
    expect(post.text).toBe('Published body');
    expect(post.status).toBe('published');
    expect(post.platforms).toEqual(['twitter']);
    expect(post.typefully_draft_id).toBe('tf-1');
    expect(post.post_urls).toEqual({ twitter: 'https://x.com/1' });
  });
});

// ---------------------------------------------------------------------------
// listPublished
// ---------------------------------------------------------------------------

describe('listPublished', () => {
  it('returns posts newest-first', () => {
    store.markPublished(null, { text: 'First published', platforms: [] });
    store.markPublished(null, { text: 'Second published', platforms: [] });

    const posts = store.listPublished();

    expect(posts).toHaveLength(2);
    // Both share the same date prefix, so 002 sorts after 001, reversed = 002 first
    // The filename sort order is alphabetical reversed, so the second file comes first
    expect(posts[0].text).toBe('Second published');
  });

  it('respects limit parameter', () => {
    store.markPublished(null, { text: 'Post one', platforms: [] });
    store.markPublished(null, { text: 'Post two', platforms: [] });
    store.markPublished(null, { text: 'Post three', platforms: [] });

    const posts = store.listPublished({ limit: 2 });

    expect(posts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// updateEngagement
// ---------------------------------------------------------------------------

describe('updateEngagement', () => {
  it('merges engagement data into frontmatter', () => {
    const { publishedId } = store.markPublished(null, {
      text: 'Engagement test',
      platforms: ['twitter'],
    });

    store.updateEngagement(publishedId, { likes: 42, retweets: 7 });

    const post = store.getPublished(publishedId);
    expect(post.engagement).toEqual({ likes: 42, retweets: 7 });
  });

  it('sets last_stats_pull timestamp', () => {
    const { publishedId } = store.markPublished(null, {
      text: 'Stats pull test',
      platforms: ['twitter'],
    });

    const before = new Date();
    store.updateEngagement(publishedId, { likes: 1 });
    const after = new Date();

    const post = store.getPublished(publishedId);
    expect(post.last_stats_pull).toBeDefined();
    expect(post.last_stats_pull).not.toBeNull();

    const pullDate = new Date(post.last_stats_pull);
    expect(pullDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(pullDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});

// ---------------------------------------------------------------------------
// generateSlug
// ---------------------------------------------------------------------------

describe('generateSlug', () => {
  it('extracts first 5 words, lowercased, hyphenated', () => {
    const slug = store.generateSlug('The Quick Brown Fox Jumps Over The Lazy Dog');
    expect(slug).toBe('the-quick-brown-fox-jumps');
  });

  it('removes punctuation', () => {
    const slug = store.generateSlug("Hello, World! This is great. Right?");
    expect(slug).toBe('hello-world-this-is-great');
  });

  it('limits to 50 chars', () => {
    const longText = 'Supercalifragilisticexpialidocious Extraordinarily Incomprehensibilities Pseudopseudohypoparathyroidism Pneumonoultramicroscopicsilicovolcanoconiosis';
    const slug = store.generateSlug(longText);
    expect(slug.length).toBeLessThanOrEqual(50);
  });
});
