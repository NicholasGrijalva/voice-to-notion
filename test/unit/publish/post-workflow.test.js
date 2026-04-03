const PostWorkflow = require('../../../src/publish/post-workflow');

// -- Mock dependencies --
// clarify-questions and platforms are real modules (pure functions),
// so we mock them to isolate PostWorkflow logic.

vi.mock('../../../src/publish/clarify-questions', () => ({
  getClarifyQuestions: vi.fn().mockReturnValue([
    'What connects these ideas?',
    'What would someone DO differently?',
    'What is the synthesis?',
  ]),
}));

vi.mock('../../../src/publish/platforms', () => ({
  formatPreview: vi.fn().mockReturnValue({
    platforms: { twitter: { chars: 40, maxChars: 280, ok: true } },
    overLimit: [],
    needsThread: [],
  }),
  splitThread: vi.fn().mockReturnValue(['Part 1', 'Part 2']),
}));

const USER_ID = 'user-42';

function createMocks() {
  const mockNotion = {
    queryRecent: vi.fn().mockResolvedValue([
      { id: 'page-1', title: 'Deep Work', type: 'YouTube', summary: 'Focus is key', timestamp: '2026-04-02T10:00:00Z' },
      { id: 'page-2', title: 'Maker Schedule', type: 'Idea', summary: 'Uninterrupted blocks', timestamp: '2026-04-02T08:00:00Z' },
    ]),
  };
  const mockTypefully = {
    createDraft: vi.fn().mockResolvedValue({ draftId: 'draft_abc' }),
  };
  const mockPostStore = {
    saveDraft: vi.fn().mockReturnValue({ draftId: 'draft-001' }),
    markPublished: vi.fn().mockReturnValue({ publishedId: 'pub-2026-04-02-001' }),
    listDrafts: vi.fn().mockReturnValue([]),
    getDraft: vi.fn().mockReturnValue(null),
    deleteDraft: vi.fn().mockReturnValue(true),
    listPublished: vi.fn().mockReturnValue([]),
  };

  return { mockNotion, mockTypefully, mockPostStore };
}

function createWorkflow(overrides = {}) {
  const { mockNotion, mockTypefully, mockPostStore } = createMocks();
  const merged = { mockNotion, mockTypefully, mockPostStore, ...overrides };
  const wf = new PostWorkflow({
    notionClient: merged.mockNotion,
    typefullyClient: merged.mockTypefully,
    postStore: merged.mockPostStore,
    enabledPlatforms: ['twitter', 'linkedin', 'bluesky'],
  });
  return { wf, ...merged };
}

// Suppress console output during tests
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// Session Management
// =========================================================================

describe('PostWorkflow - Session Management', () => {
  it('startSession creates session with SELECT_SOURCES state', () => {
    const { wf } = createWorkflow();
    const session = wf.startSession(USER_ID);

    expect(session.userId).toBe(USER_ID);
    expect(session.state).toBe('SELECT_SOURCES');
    expect(session.sourceIds).toEqual([]);
    expect(session.sourceTitles).toEqual([]);
    expect(session.sourceTypes).toEqual([]);
    expect(session.sourceExcerpts).toEqual([]);
    expect(session.text).toBeNull();
    expect(session.threadPosts).toBeNull();
    expect(session.recentCaptures).toBeNull();
    expect(session.createdAt).toBeTypeOf('number');
    expect(session.lastActivity).toBeTypeOf('number');
  });

  it('getSession returns session for active user', () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);

    const session = wf.getSession(USER_ID);
    expect(session).not.toBeNull();
    expect(session.userId).toBe(USER_ID);
  });

  it('getSession returns null for unknown user', () => {
    const { wf } = createWorkflow();
    expect(wf.getSession('nonexistent-user')).toBeNull();
  });

  it('getSession returns null for expired session (>30min)', () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);

    // Move lastActivity beyond the 30-minute TTL
    const session = wf.sessions.get(USER_ID);
    session.lastActivity = Date.now() - 31 * 60 * 1000;

    expect(wf.getSession(USER_ID)).toBeNull();
    // Session should also be cleaned from the map
    expect(wf.sessions.has(USER_ID)).toBe(false);
  });

  it('endSession removes session', () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    expect(wf.getSession(USER_ID)).not.toBeNull();

    wf.endSession(USER_ID);
    expect(wf.getSession(USER_ID)).toBeNull();
  });

  it('expireSessions cleans up old sessions', () => {
    const { wf } = createWorkflow();
    wf.startSession('user-a');
    wf.startSession('user-b');
    wf.startSession('user-c');

    // Expire user-a and user-b
    wf.sessions.get('user-a').lastActivity = Date.now() - 31 * 60 * 1000;
    wf.sessions.get('user-b').lastActivity = Date.now() - 45 * 60 * 1000;

    wf.expireSessions();

    expect(wf.sessions.has('user-a')).toBe(false);
    expect(wf.sessions.has('user-b')).toBe(false);
    expect(wf.sessions.has('user-c')).toBe(true);
  });
});

// =========================================================================
// State Transitions
// =========================================================================

describe('PostWorkflow - State Transitions', () => {
  it('getRecentCaptures calls notion.queryRecent and stores on session', async () => {
    const { wf, mockNotion } = createWorkflow();
    wf.startSession(USER_ID);

    const captures = await wf.getRecentCaptures(USER_ID, 5);

    expect(mockNotion.queryRecent).toHaveBeenCalledWith({ limit: 5 });
    expect(captures).toHaveLength(2);
    expect(captures[0]).toEqual({
      pageId: 'page-1',
      title: 'Deep Work',
      type: 'YouTube',
      summary: 'Focus is key',
      timestamp: '2026-04-02T10:00:00Z',
    });

    const session = wf.getSession(USER_ID);
    expect(session.recentCaptures).toEqual(captures);
  });

  it('selectSources stores selected source info and transitions to CLARIFY', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);

    const result = wf.selectSources(USER_ID, [1]);

    expect(result.excerpts).toEqual(['Focus is key']);
    expect(result.questions).toHaveLength(3);

    const session = wf.getSession(USER_ID);
    expect(session.state).toBe('CLARIFY');
    expect(session.sourceIds).toEqual(['page-1']);
    expect(session.sourceTitles).toEqual(['Deep Work']);
    expect(session.sourceTypes).toEqual(['YouTube']);
  });

  it('selectSources throws if not in SELECT_SOURCES state', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);

    // Transition to CLARIFY first
    wf.selectSources(USER_ID, [1]);

    // Now try again -- should throw
    expect(() => wf.selectSources(USER_ID, [2])).toThrow(
      'Cannot select sources in state CLARIFY',
    );
  });

  it('preselectSource adds source to session', () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);

    wf.preselectSource(USER_ID, 'page-99', 'Custom Source', 'Audio');

    const session = wf.getSession(USER_ID);
    expect(session.sourceIds).toContain('page-99');
    expect(session.sourceTitles).toContain('Custom Source');
    expect(session.sourceTypes).toContain('Audio');
  });

  it('setPostText stores text, transitions to PREVIEW, returns preview', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);
    wf.selectSources(USER_ID, [1]);

    const result = wf.setPostText(USER_ID, 'Focus deeply on what matters.');

    expect(result.preview).toBeDefined();
    expect(result.preview.platforms).toBeDefined();

    const session = wf.getSession(USER_ID);
    expect(session.state).toBe('PREVIEW');
    expect(session.text).toBe('Focus deeply on what matters.');
    expect(session.threadPosts).toBeNull();
  });

  it('setPostText throws if not in CLARIFY or COMPOSE state', () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    // Session is in SELECT_SOURCES -- should reject
    expect(() => wf.setPostText(USER_ID, 'some text')).toThrow(
      'Cannot set text in state SELECT_SOURCES',
    );
  });

  it('splitIntoThread splits text and stays in PREVIEW', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);
    wf.selectSources(USER_ID, [1]);
    // Text that exceeds 50 chars so it splits at maxChars=50
    const longText = 'First paragraph of the post.\n\nSecond paragraph of the post.';
    wf.setPostText(USER_ID, longText);

    const result = wf.splitIntoThread(USER_ID, 50);

    expect(result.threadPosts.length).toBeGreaterThan(1);
    expect(result.preview).toBeDefined();

    const session = wf.getSession(USER_ID);
    expect(session.state).toBe('PREVIEW');
    expect(session.threadPosts.length).toBeGreaterThan(1);
  });

  it('splitIntoThread throws if not in PREVIEW state', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);
    wf.selectSources(USER_ID, [1]);
    // State is CLARIFY, not PREVIEW
    expect(() => wf.splitIntoThread(USER_ID)).toThrow(
      'Cannot split thread in state CLARIFY',
    );
  });

  it('returnToCompose transitions back to COMPOSE and clears threadPosts', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);
    wf.selectSources(USER_ID, [1]);
    wf.setPostText(USER_ID, 'Draft post');
    wf.splitIntoThread(USER_ID);

    wf.returnToCompose(USER_ID);

    const session = wf.getSession(USER_ID);
    expect(session.state).toBe('COMPOSE');
    expect(session.threadPosts).toBeNull();
  });
});

// =========================================================================
// Publishing
// =========================================================================

describe('PostWorkflow - Publishing', () => {
  async function setupToPreview(wf) {
    wf.startSession(USER_ID);
    await wf.getRecentCaptures(USER_ID);
    wf.selectSources(USER_ID, [1, 2]);
    wf.setPostText(USER_ID, 'Here is my post content.');
  }

  it('publish calls typefully.createDraft with correct args', async () => {
    const { wf, mockTypefully } = createWorkflow();
    await setupToPreview(wf);

    await wf.publish(USER_ID, { publishAt: 'next-free-slot' });

    expect(mockTypefully.createDraft).toHaveBeenCalledWith(
      'Here is my post content.',
      expect.objectContaining({
        platforms: { twitter: true, linkedin: true, bluesky: true },
        publishAt: 'next-free-slot',
        threadPosts: null,
      }),
    );
  });

  it('publish calls postStore.markPublished', async () => {
    const { wf, mockPostStore } = createWorkflow();
    await setupToPreview(wf);

    await wf.publish(USER_ID);

    expect(mockPostStore.markPublished).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        text: 'Here is my post content.',
        sourceIds: ['page-1', 'page-2'],
        sourceTitles: ['Deep Work', 'Maker Schedule'],
        platforms: ['twitter', 'linkedin', 'bluesky'],
        typefullyDraftId: 'draft_abc',
      }),
    );
  });

  it('publish ends session after success', async () => {
    const { wf } = createWorkflow();
    await setupToPreview(wf);

    await wf.publish(USER_ID);

    expect(wf.getSession(USER_ID)).toBeNull();
  });

  it('publish throws if not in PREVIEW state', async () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    // State is SELECT_SOURCES
    await expect(wf.publish(USER_ID)).rejects.toThrow(
      'Cannot publish in state SELECT_SOURCES',
    );
  });

  it('publish passes platformFilter when provided', async () => {
    const { wf, mockTypefully } = createWorkflow();
    await setupToPreview(wf);

    await wf.publish(USER_ID, { platformFilter: ['twitter'] });

    expect(mockTypefully.createDraft).toHaveBeenCalledWith(
      'Here is my post content.',
      expect.objectContaining({
        platforms: { twitter: true },
      }),
    );
  });

  it('publish returns draftId and archiveId', async () => {
    const { wf } = createWorkflow();
    await setupToPreview(wf);

    const result = await wf.publish(USER_ID);

    expect(result.draftId).toBe('draft_abc');
    expect(result.archiveId).toBe('pub-2026-04-02-001');
  });

  it('saveDraft calls postStore.saveDraft with text and source info', async () => {
    const { wf, mockPostStore } = createWorkflow();
    await setupToPreview(wf);

    wf.saveDraft(USER_ID);

    expect(mockPostStore.saveDraft).toHaveBeenCalledWith(
      'Here is my post content.',
      {
        sourceIds: ['page-1', 'page-2'],
        sourceTitles: ['Deep Work', 'Maker Schedule'],
      },
    );
  });

  it('saveDraft ends session after success', async () => {
    const { wf } = createWorkflow();
    await setupToPreview(wf);

    wf.saveDraft(USER_ID);

    expect(wf.getSession(USER_ID)).toBeNull();
  });

  it('saveDraft throws if no text', () => {
    const { wf } = createWorkflow();
    wf.startSession(USER_ID);
    // Force state to allow saveDraft to reach the text check
    const session = wf.sessions.get(USER_ID);
    session.state = 'PREVIEW';

    expect(() => wf.saveDraft(USER_ID)).toThrow('No post text to save');
  });
});

// =========================================================================
// Draft Queue
// =========================================================================

describe('PostWorkflow - Draft Queue', () => {
  it('listDrafts delegates to postStore', () => {
    const { wf, mockPostStore } = createWorkflow();
    mockPostStore.listDrafts.mockReturnValue([{ draftId: 'd-1', text: 'hello' }]);

    const drafts = wf.listDrafts();

    expect(mockPostStore.listDrafts).toHaveBeenCalled();
    expect(drafts).toEqual([{ draftId: 'd-1', text: 'hello' }]);
  });

  it('getDraft delegates to postStore', () => {
    const { wf, mockPostStore } = createWorkflow();
    mockPostStore.getDraft.mockReturnValue({ draftId: 'd-1', text: 'saved' });

    const draft = wf.getDraft('d-1');

    expect(mockPostStore.getDraft).toHaveBeenCalledWith('d-1');
    expect(draft).toEqual({ draftId: 'd-1', text: 'saved' });
  });

  it('deleteDraft delegates to postStore', () => {
    const { wf, mockPostStore } = createWorkflow();

    const result = wf.deleteDraft('d-1');

    expect(mockPostStore.deleteDraft).toHaveBeenCalledWith('d-1');
    expect(result).toBe(true);
  });

  it('publishDraft calls getDraft, then typefully.createDraft, then markPublished', async () => {
    const { wf, mockPostStore, mockTypefully } = createWorkflow();
    mockPostStore.getDraft.mockReturnValue({
      text: 'Saved draft text',
      source_ids: ['page-1'],
      source_titles: ['Deep Work'],
    });

    const result = await wf.publishDraft('d-1', { publishAt: 'now' });

    expect(mockPostStore.getDraft).toHaveBeenCalledWith('d-1');
    expect(mockTypefully.createDraft).toHaveBeenCalledWith(
      'Saved draft text',
      expect.objectContaining({
        platforms: { twitter: true, linkedin: true, bluesky: true },
        publishAt: 'now',
      }),
    );
    expect(mockPostStore.markPublished).toHaveBeenCalledWith(
      'd-1',
      expect.objectContaining({
        text: 'Saved draft text',
        sourceIds: ['page-1'],
        sourceTitles: ['Deep Work'],
        typefullyDraftId: 'draft_abc',
      }),
    );
    expect(result.draftId).toBe('draft_abc');
    expect(result.archiveId).toBe('pub-2026-04-02-001');
  });

  it('publishDraft throws if draft not found', async () => {
    const { wf, mockPostStore } = createWorkflow();
    mockPostStore.getDraft.mockReturnValue(null);

    await expect(wf.publishDraft('nonexistent')).rejects.toThrow(
      'Draft nonexistent not found',
    );
  });
});

// =========================================================================
// Full Flow
// =========================================================================

describe('PostWorkflow - Full Flow', () => {
  it('startSession -> getRecentCaptures -> selectSources -> setPostText -> publish', async () => {
    const { wf, mockNotion, mockTypefully, mockPostStore } = createWorkflow();

    // 1. Start session
    const session = wf.startSession(USER_ID);
    expect(session.state).toBe('SELECT_SOURCES');

    // 2. Fetch recent captures
    const captures = await wf.getRecentCaptures(USER_ID, 5);
    expect(mockNotion.queryRecent).toHaveBeenCalledWith({ limit: 5 });
    expect(captures).toHaveLength(2);

    // 3. Select sources (1-based index)
    const { excerpts, questions } = wf.selectSources(USER_ID, [1]);
    expect(excerpts).toEqual(['Focus is key']);
    expect(questions).toHaveLength(3);
    expect(wf.getSession(USER_ID).state).toBe('CLARIFY');

    // 4. Set post text
    const { preview } = wf.setPostText(USER_ID, 'Deep work changes everything.');
    expect(preview).toBeDefined();
    expect(wf.getSession(USER_ID).state).toBe('PREVIEW');

    // 5. Publish
    const result = await wf.publish(USER_ID, { publishAt: 'now' });
    expect(mockTypefully.createDraft).toHaveBeenCalledWith(
      'Deep work changes everything.',
      expect.objectContaining({
        platforms: { twitter: true, linkedin: true, bluesky: true },
        publishAt: 'now',
      }),
    );
    expect(mockPostStore.markPublished).toHaveBeenCalled();
    expect(result.draftId).toBe('draft_abc');
    expect(result.archiveId).toBe('pub-2026-04-02-001');

    // Session should be cleaned up
    expect(wf.getSession(USER_ID)).toBeNull();
  });
});
