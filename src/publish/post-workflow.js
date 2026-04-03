/**
 * Post Workflow -- State machine orchestrator for the publish flow.
 *
 * Framework-agnostic: returns data objects that the transport layer
 * (Telegram, HTTP, CLI) formats for display. Knows nothing about Telegraf.
 *
 * States: IDLE -> SELECT_SOURCES -> CLARIFY -> COMPOSE -> PREVIEW -> DONE
 */

const { getClarifyQuestions } = require('./clarify-questions');
const { formatPreview, splitThread } = require('./platforms');

const STATES = {
  SELECT_SOURCES: 'SELECT_SOURCES',
  CLARIFY: 'CLARIFY',
  COMPOSE: 'COMPOSE',
  PREVIEW: 'PREVIEW',
};

const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

class PostWorkflow {
  constructor({ notionClient, typefullyClient, postStore, enabledPlatforms }) {
    this.notion = notionClient;
    this.typefully = typefullyClient;
    this.postStore = postStore;
    this.enabledPlatforms = enabledPlatforms || ['twitter', 'linkedin', 'bluesky'];
    this.sessions = new Map(); // userId -> session
  }

  // ── Session Management ──────────────────────────────────────────────────

  startSession(userId) {
    const session = {
      userId,
      state: STATES.SELECT_SOURCES,
      sourceIds: [],
      sourceTitles: [],
      sourceTypes: [],
      sourceExcerpts: [],
      text: null,
      threadPosts: null,
      recentCaptures: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(userId, session);
    return session;
  }

  getSession(userId) {
    const session = this.sessions.get(userId);
    if (!session) return null;
    if (Date.now() - session.lastActivity > SESSION_TTL) {
      this.sessions.delete(userId);
      return null;
    }
    session.lastActivity = Date.now();
    return session;
  }

  endSession(userId) {
    this.sessions.delete(userId);
  }

  expireSessions() {
    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL) {
        this.sessions.delete(userId);
      }
    }
  }

  // ── State Transitions ───────────────────────────────────────────────────

  /**
   * Fetch recent captures from Notion for source selection.
   * @param {number} limit
   * @returns {Promise<Array<{ pageId, title, type, summary, timestamp }>>}
   */
  async getRecentCaptures(userId, limit = 5) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');

    const pages = await this.notion.queryRecent({ limit });
    const captures = pages.map(p => ({
      pageId: p.id,
      title: p.title,
      type: p.type,
      summary: p.summary,
      timestamp: p.timestamp,
    }));
    session.recentCaptures = captures;
    return captures;
  }

  /**
   * Select source captures by index (1-based from the recent captures list).
   * @param {number} userId
   * @param {number[]} indices - 1-based indices into recentCaptures
   * @returns {{ excerpts: string[], questions: string[] }}
   */
  selectSources(userId, indices) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');
    if (session.state !== STATES.SELECT_SOURCES) {
      throw new Error(`Cannot select sources in state ${session.state}`);
    }

    const captures = session.recentCaptures || [];
    for (const idx of indices) {
      const capture = captures[idx - 1];
      if (!capture) continue;
      session.sourceIds.push(capture.pageId);
      session.sourceTitles.push(capture.title);
      session.sourceTypes.push(capture.type);
      session.sourceExcerpts.push(capture.summary || capture.title);
    }

    const questions = getClarifyQuestions(session.sourceTypes);
    session.state = STATES.CLARIFY;

    return {
      excerpts: session.sourceExcerpts,
      questions,
    };
  }

  /**
   * Pre-select a specific source (e.g., from a reply to a bot message).
   * @param {number} userId
   * @param {string} pageId
   * @param {string} title
   * @param {string} type
   */
  preselectSource(userId, pageId, title, type) {
    const session = this.getSession(userId);
    if (!session) return;
    session.sourceIds.push(pageId);
    session.sourceTitles.push(title);
    session.sourceTypes.push(type);
  }

  /**
   * Set the post text (from CLARIFY or COMPOSE state).
   * Transitions to PREVIEW.
   *
   * @param {number} userId
   * @param {string} text
   * @returns {{ preview: Object }}
   */
  setPostText(userId, text) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');
    if (session.state !== STATES.CLARIFY && session.state !== STATES.COMPOSE) {
      throw new Error(`Cannot set text in state ${session.state}`);
    }

    session.text = text;
    session.threadPosts = null;
    session.state = STATES.PREVIEW;

    const preview = formatPreview(text, this.enabledPlatforms);
    return { preview };
  }

  /**
   * Split the current post text into a thread.
   * Stays in PREVIEW state.
   *
   * @param {number} userId
   * @param {number} maxChars - char limit for splitting (default 280 for Twitter)
   * @returns {{ threadPosts: string[], preview: Object }}
   */
  splitIntoThread(userId, maxChars = 280) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');
    if (session.state !== STATES.PREVIEW) {
      throw new Error(`Cannot split thread in state ${session.state}`);
    }

    session.threadPosts = splitThread(session.text, maxChars);
    const preview = formatPreview(session.text, this.enabledPlatforms);

    return { threadPosts: session.threadPosts, preview };
  }

  /**
   * Return to COMPOSE state for editing.
   */
  returnToCompose(userId) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');
    session.state = STATES.COMPOSE;
    session.threadPosts = null;
  }

  /**
   * Publish the current post via Typefully.
   *
   * @param {number} userId
   * @param {Object} opts
   * @param {string} opts.publishAt - "now" | "next-free-slot" | ISO 8601
   * @param {string[]} opts.platformFilter - optional subset of enabled platforms
   * @returns {Promise<{ postUrls: Object, archiveId: string }>}
   */
  async publish(userId, { publishAt = 'now', platformFilter = null } = {}) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');
    if (session.state !== STATES.PREVIEW) {
      throw new Error(`Cannot publish in state ${session.state}`);
    }

    const platforms = {};
    const activePlatforms = platformFilter || this.enabledPlatforms;
    for (const p of activePlatforms) {
      platforms[p] = true;
    }

    const result = await this.typefully.createDraft(session.text, {
      platforms,
      publishAt,
      threadPosts: session.threadPosts,
    });

    // Archive
    const { publishedId } = this.postStore.markPublished(null, {
      text: session.text,
      sourceIds: session.sourceIds,
      sourceTitles: session.sourceTitles,
      platforms: activePlatforms,
      typefullyDraftId: result.draftId,
      postUrls: {},
    });

    this.sessions.delete(userId);

    return { draftId: result.draftId, archiveId: publishedId };
  }

  /**
   * Save current post as a draft (don't publish).
   */
  saveDraft(userId) {
    const session = this.getSession(userId);
    if (!session) throw new Error('No active post session');
    if (!session.text) throw new Error('No post text to save');

    const { draftId } = this.postStore.saveDraft(session.text, {
      sourceIds: session.sourceIds,
      sourceTitles: session.sourceTitles,
    });

    this.sessions.delete(userId);
    return { draftId };
  }

  // ── Draft Queue ─────────────────────────────────────────────────────────

  listDrafts() {
    return this.postStore.listDrafts();
  }

  getDraft(draftId) {
    return this.postStore.getDraft(draftId);
  }

  deleteDraft(draftId) {
    return this.postStore.deleteDraft(draftId);
  }

  /**
   * Publish a saved draft by ID.
   */
  async publishDraft(draftId, { publishAt = 'now' } = {}) {
    const draft = this.postStore.getDraft(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);

    const platforms = {};
    for (const p of this.enabledPlatforms) platforms[p] = true;

    const result = await this.typefully.createDraft(draft.text, {
      platforms,
      publishAt,
    });

    const { publishedId } = this.postStore.markPublished(draftId, {
      text: draft.text,
      sourceIds: draft.source_ids || [],
      sourceTitles: draft.source_titles || [],
      platforms: this.enabledPlatforms,
      typefullyDraftId: result.draftId,
      postUrls: {},
    });

    return { draftId: result.draftId, archiveId: publishedId };
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  async getStats({ limit = 5 } = {}) {
    return this.postStore.listPublished({ limit });
  }
}

module.exports = PostWorkflow;
