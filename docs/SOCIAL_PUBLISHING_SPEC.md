# Social Publishing Spec

**Version**: 0.1.0
**Date**: 2026-04-02
**Status**: Draft
**Research**: [social-media-publishing-api-research.md](../../cognosmap/specs/reviews/social-media-publishing-api-research.md)

---

## 1. Problem

Ideas are captured (voice, URLs, photos, PDFs) into Notion/Obsidian but never leave the vault. The user wants to test ideas publicly on short-form platforms without opening Twitter/LinkedIn/etc. The pipeline already produces structured summaries -- the missing piece is distribution.

## 2. Goals

1. Publish to X/Twitter, LinkedIn, Bluesky, Threads, Mastodon from Telegram
2. Link published posts back to their source captures
3. No AI writing -- AI asks clarifying questions only
4. Preview posts with per-platform character counts before publishing
5. Archive all posts as git-tracked markdown
6. Pull engagement stats back into the archive
7. Design for extraction to a custom app (framework-agnostic workflow)

## 3. Non-Goals (v1)

- Custom dashboard UI (use Typefully dashboard + Notion views)
- AI-generated or AI-rewritten post content
- Substack Notes (no stable API -- revisit later)
- Image/media attachments on posts (text-only v1)
- Content calendar or scheduling optimization
- Per-platform tone customization by AI

## 4. Architecture

### 4.1 Module Boundary

Publishing lives in `src/publish/` with zero imports from the capture pipeline. The only shared dependency is the Notion client (injected, for reading captured pages).

```
voice-to-notion/
  src/
    publish/                     # NEW -- self-contained
      typefully-client.js        # Typefully v2 API client
      post-workflow.js           # State machine orchestrator
      post-store.js              # Draft/published archive CRUD
      clarify-questions.js       # Hardcoded question map
      platforms.js               # Platform char limits + formatting
    telegram-bot.js              # ADD: thin /post command handlers
  posts/                         # NEW -- git-tracked archive
    drafts/
    published/
  test/
    unit/
      publish/                   # NEW -- tests mirror src/publish/
        typefully-client.test.js
        post-workflow.test.js
        post-store.test.js
        clarify-questions.test.js
        platforms.test.js
```

### 4.2 Dependency Graph

```
telegram-bot.js
  |
  v
post-workflow.js  (framework-agnostic, no Telegram knowledge)
  |       |       |
  v       v       v
typefully-client.js   post-store.js   clarify-questions.js
                                      platforms.js
```

- `telegram-bot.js` calls `PostWorkflow` methods and formats results as Telegram messages
- `PostWorkflow` is the only orchestrator -- coordinates all publish modules
- Each module under `src/publish/` is independently testable
- Future custom app replaces `telegram-bot.js` with HTTP routes; everything else stays

### 4.3 Data Flow

```
Capture (existing)              Publish (new)
                                
Telegram msg ──> pipeline       /post ──> select sources
            |                         |
            v                         v
      Notion page              load context + questions
      (with summary)                  |
                                      v
                               user writes post
                                      |
                                      v
                               preview (char counts)
                                      |
                               /go    |    /save
                                |           |
                                v           v
                          Typefully API   posts/drafts/
                                |
                                v
                          posts/published/
                          (+ Notion page updated)
```

## 5. Typefully API Integration

### 5.1 API Details (from research doc)

| Field | Value |
|-------|-------|
| Base URL | `https://api.typefully.com/v2/` |
| Auth | `Authorization: Bearer ${TYPEFULLY_API_KEY}` |
| Create draft | `POST /v2/social-sets/{social_set_id}/drafts` |
| Scheduling | `publish_at`: `"now"`, `"next-free-slot"`, or ISO 8601 |
| Platforms | `twitter`, `linkedin`, `bluesky`, `threads`, `mastodon` |
| Thread support | `posts` array with multiple entries per platform |

### 5.2 Environment Variables

```bash
TYPEFULLY_API_KEY=tf_...              # Required for publishing
TYPEFULLY_SOCIAL_SET_ID=ss_...        # Required -- identifies connected accounts
PUBLISH_PLATFORMS=twitter,linkedin,bluesky  # Optional, defaults to all enabled
```

### 5.3 TypefullyClient Interface

```javascript
class TypefullyClient {
  constructor(apiKey, socialSetId, options = {})

  // Create a draft and optionally publish it
  // Returns { draftId, publishedUrls? }
  async createDraft(text, {
    platforms,        // { twitter: true, linkedin: true, ... }
    publishAt,        // "now" | "next-free-slot" | ISO 8601 | null (draft only)
    threadPosts,      // string[] -- if provided, creates a thread instead of single post
    perPlatformText,  // { twitter: "short", linkedin: "long" } -- optional overrides
  })

  // Get recently published posts (for stats)
  // Returns [{ id, text, platforms, publishedAt, metrics? }]
  async getPublished(limit = 20)

  // Test connection
  async testConnection()
}
```

### 5.4 Request Shape

Single post:
```json
{
  "platforms": {
    "twitter": { "enabled": true, "posts": [{ "text": "Your idea" }] },
    "linkedin": { "enabled": true, "posts": [{ "text": "Your idea" }] },
    "bluesky": { "enabled": true, "posts": [{ "text": "Your idea" }] }
  },
  "publish_at": "now"
}
```

Thread (Twitter/Bluesky):
```json
{
  "platforms": {
    "twitter": {
      "enabled": true,
      "posts": [
        { "text": "Thread part 1" },
        { "text": "Thread part 2" }
      ]
    },
    "linkedin": {
      "enabled": true,
      "posts": [{ "text": "Full text as single post" }]
    }
  },
  "publish_at": "now"
}
```

## 6. Post Store

### 6.1 Archive Format

Draft:
```
posts/drafts/001-deep-work-artifacts.md
```

Published:
```
posts/published/2026-04-02-deep-work-artifacts.md
```

### 6.2 File Format

```yaml
---
id: pub-2026-04-02-001
date: 2026-04-02T15:30:00Z
status: published           # draft | published | scheduled
source_ids:                  # Notion page IDs that inspired this post
  - "abc-123-def"
  - "ghi-456-jkl"
source_titles:               # For human readability
  - "Deep Work and Focus Blocks"
  - "Maker's Schedule essay"
platforms:
  - twitter
  - linkedin
  - bluesky
typefully_draft_id: "draft_xyz"
post_urls:
  twitter: "https://x.com/you/status/123"
  linkedin: "https://linkedin.com/feed/update/456"
  bluesky: "https://bsky.app/profile/you/post/789"
engagement:                  # Updated by /stats command
  twitter: { likes: 42, retweets: 8, replies: 3 }
  bluesky: { likes: 15, reposts: 2, replies: 1 }
  linkedin: { likes: 28, comments: 5 }
last_stats_pull: null
---

The most dangerous kind of work is work that feels productive but creates nothing.

Meetings, email, "staying on top of things" -- it all feels like progress. But at the end of the day, what did you actually make?

Deep work isn't about hours. It's about artifacts. If you can't point to what you created, you weren't working. You were performing.
```

### 6.3 PostStore Interface

```javascript
class PostStore {
  constructor(baseDir)  // e.g., './posts'

  // Draft CRUD
  async saveDraft(text, { sourceIds, sourceTitles }) → { draftId, filePath }
  async getDraft(draftId) → { id, text, sourceIds, sourceTitles, createdAt }
  async listDrafts() → Draft[]
  async deleteDraft(draftId) → boolean

  // Publish: moves draft to published/ or creates new published entry
  async markPublished(draftIdOrNull, {
    text, sourceIds, sourceTitles, platforms,
    typefullyDraftId, postUrls
  }) → { publishedId, filePath }

  // Published reads
  async getPublished(publishedId) → Post
  async listPublished({ limit, since }) → Post[]

  // Stats update
  async updateEngagement(publishedId, engagement) → void

  // Slug generation from text
  generateSlug(text) → string
}
```

### 6.4 File Naming

- Drafts: zero-padded counter + slug. `001-deep-work.md`, `002-busyness-mask.md`
- Published: ISO date + slug. `2026-04-02-deep-work.md`
- Slug: first 5 words of post text, lowercased, hyphenated, max 50 chars

## 7. Clarify Questions

### 7.1 Question Map

Hardcoded, no LLM. Keyed by source content type (from the capture pipeline's `source` field).

```javascript
const QUESTIONS = {
  youtube: [
    "What's the one thing from this video you'd tell a friend?",
    "What did the speaker get right that most people miss?",
    "What would you push back on?",
  ],
  article: [
    "What surprised you in this piece?",
    "What does this change about how you think?",
    "What's the one sentence you'd highlight?",
  ],
  tweet: [
    "What's the deeper point behind this tweet?",
    "Why does this matter beyond the timeline?",
    "What would you add that the author left out?",
  ],
  idea: [
    "What would you say if you only had one sentence?",
    "What do most people get wrong about this?",
    "What changed for you when you realized this?",
  ],
  voice: [
    "What were you actually trying to say?",
    "If you had to convince a skeptic, what's the strongest version?",
    "What's the tension or counterintuitive part?",
  ],
  pdf: [
    "What's the core finding that matters?",
    "Who needs to know about this and why?",
    "What does this change about what we assumed?",
  ],
  photo: [
    "What's the story behind this image?",
    "What does this show that words can't?",
    "What should someone notice that they might miss?",
  ],
  default: [
    "What's the one thing someone should take away?",
    "What would make someone stop scrolling?",
    "What would you say differently now than when you captured this?",
  ],
};
```

### 7.2 Multi-Source Questions

When the user selects multiple sources, use connector questions instead:

```javascript
const MULTI_SOURCE_QUESTIONS = [
  "What connects these ideas?",
  "What would someone DO differently after reading your post?",
  "What's the synthesis -- the thing none of these sources say alone?",
];
```

### 7.3 Interface

```javascript
// Pure function, no state
function getClarifyQuestions(sourceTypes) → string[]
```

- Single source: returns 3 questions for that type (with `default` fallback)
- Multiple sources: returns `MULTI_SOURCE_QUESTIONS`

## 8. Platform Formatting

### 8.1 Character Limits

```javascript
const PLATFORMS = {
  twitter:  { name: 'X',        maxChars: 280,  supportsThreads: true  },
  linkedin: { name: 'LinkedIn', maxChars: 3000, supportsThreads: false },
  bluesky:  { name: 'Bluesky',  maxChars: 300,  supportsThreads: true  },
  threads:  { name: 'Threads',  maxChars: 500,  supportsThreads: true  },
  mastodon: { name: 'Mastodon', maxChars: 500,  supportsThreads: true  },
};
```

### 8.2 Preview Format

```javascript
function formatPreview(text, enabledPlatforms) → {
  platforms: {
    twitter:  { chars: 189, maxChars: 280, ok: true },
    bluesky:  { chars: 189, maxChars: 300, ok: true },
    linkedin: { chars: 189, maxChars: 3000, ok: true },
  },
  overLimit: [],       // platform keys that exceed limit
  needsThread: [],     // platform keys where threading would help
}
```

### 8.3 Thread Splitting

```javascript
function splitThread(text, maxChars) → string[]
```

Algorithm:
1. Split text on paragraph breaks (`\n\n`)
2. If any single paragraph exceeds `maxChars`, split on sentence boundaries (`. `)
3. Greedily combine chunks into posts, each under `maxChars`
4. If a single sentence exceeds `maxChars`, hard-break at word boundary with `...`
5. Return array of post strings

No numbering (e.g., "1/3") added by default. User can request it.

## 9. Post Workflow (State Machine)

### 9.1 States

```
IDLE
  |
  v  (/post)
SELECT_SOURCES
  |
  v  (user picks numbers, or writes text directly)
  |
  +---> COMPOSE (if text provided, skip clarify)
  |
  v  (numbers selected)
CLARIFY
  |
  v  (user writes post text)
COMPOSE ──────────────────────────────────────────┐
  |                                                |
  v                                                |
PREVIEW                                            |
  |       |       |        |        |              |
  v       v       v        v        v              |
 /go   /thread  /save   /later   /edit ────────────┘
  |       |       |        |
  v       v       v        v
DONE    DONE    DONE     DONE
```

### 9.2 Session Object

```javascript
{
  userId: 12345,
  state: 'SELECT_SOURCES',   // current state
  sourceIds: [],              // selected Notion page IDs
  sourceTitles: [],           // human-readable titles
  sourceTypes: [],            // content types for question selection
  sourceExcerpts: [],         // summary text from captures
  text: null,                 // composed post text
  threadPosts: null,          // split thread (if /thread used)
  createdAt: Date.now(),
  lastActivity: Date.now(),
}
```

### 9.3 TTL

Sessions expire after 30 minutes of inactivity (same as reply chain `pendingSources`). Cleanup runs on the same 5-minute interval.

### 9.4 PostWorkflow Interface

```javascript
class PostWorkflow {
  constructor({ notionClient, typefullyClient, postStore })

  // Session management
  startSession(userId) → Session
  getSession(userId) → Session | null
  expireSessions() → void

  // State transitions -- each returns a result object for the transport layer to format
  async getRecentCaptures(limit = 5)
    → [{ pageId, title, type, summary, timestamp }]

  async selectSources(userId, sourceIndices)
    → { excerpts: string[], questions: string[] }

  async setPostText(userId, text)
    → { preview: PreviewResult }

  async splitIntoThread(userId)
    → { threadPosts: string[], preview: PreviewResult }

  async publish(userId, { publishAt = 'now' } = {})
    → { postUrls: {}, archiveId: string }

  async saveDraft(userId)
    → { draftId: string }

  async publishDraft(draftId, { publishAt = 'now' } = {})
    → { postUrls: {}, archiveId: string }

  // Stats
  async getStats({ limit, period } = {})
    → { posts: PostWithEngagement[] }

  async refreshStats(publishedId)
    → { engagement: {} }
}
```

## 10. Telegram Commands

Thin handlers that call `PostWorkflow` and format results as chat messages. All publish commands are registered alongside existing handlers in `telegram-bot.js`.

### 10.1 Command Reference

| Command | Description | State Required |
|---------|-------------|----------------|
| `/draft text` | Save text as draft instantly (1-message) | any (no session) |
| (reply to bot msg) `/draft` | Fetch page summary from Notion, save as draft | any (no session) |
| `/post` | Start a new post (shows recent captures) | IDLE |
| `/post --skip` | Start without clarify questions | IDLE |
| (reply to bot msg with `/post`) | Pre-select that capture as source | IDLE |
| `1 2 3` (numbers) | Select sources | SELECT_SOURCES |
| (any text) | Set post text | CLARIFY or COMPOSE |
| `/go` | Publish now to all platforms | PREVIEW |
| `/go twitter linkedin` | Publish to specific platforms | PREVIEW |
| `/thread` | Split into thread for short-form platforms | PREVIEW |
| `/later` | Schedule next-free-slot | PREVIEW |
| `/edit` | Return to compose | PREVIEW |
| `/save` | Save as draft | PREVIEW |
| `/cancel` | Abandon post session | any |
| `/queue` | List saved drafts | any (no session needed) |
| `/queue 3` | Preview draft #3 | any |
| `/go 3` | Publish draft #3 | any |
| `/drop 3` | Delete draft #3 | any |
| `/stats` | Top posts by engagement (last 30 days) | any |
| `/stats 3` | Detail stats for published post #3 | any |

### 10.2 Message Routing

When a post session is active for a user, text messages are routed to the session state handler instead of the regular `handleText()` capture flow:

```javascript
// In handleText():
if (this.postWorkflow.getSession(ctx.from.id)) {
  return this.handlePostSession(ctx);
}
// ... existing capture logic
```

This means the user can't accidentally capture a URL while composing a post. To escape, they use `/cancel`.

### 10.3 Preview Message Format

```
Preview:

X ......... 189/280
LinkedIn .. 189/3000
Bluesky ... 189/300
Threads ... 189/500
Mastodon .. 189/500

/go    Post now     /later  Schedule
/thread Split        /save   Save draft
/edit  Revise       /cancel Abandon
```

If over limit on any platform:
```
X ......... 342/280  OVER
Bluesky ... 342/300  OVER
LinkedIn .. 342/3000 ok
Threads ... 342/500  ok

X and Bluesky are over limit.
/thread to split, or /edit to trim.
```

## 11. Notion Page Update (Post-Publish)

After successful publishing, update the source Notion page(s):

1. Set `Status` property to `Published` (if currently `New`)
2. Append a "Published" callout block to the page body with post URLs

This uses the existing `appendBlocks()` method on the Notion client.

## 12. Testing Strategy

### 12.1 Unit Tests

All tests use vitest with `globals: true` and `mockReset: true`, matching existing test patterns.

**typefully-client.test.js**
- Constructor stores config (apiKey, socialSetId, base URL)
- `createDraft()` -- single post: sends correct request shape, returns draftId
- `createDraft()` -- thread: sends posts array per platform
- `createDraft()` -- per-platform text: sends different text per platform
- `createDraft()` -- scheduling: publishAt values ("now", "next-free-slot", ISO)
- `createDraft()` -- error handling: API errors, network failures, invalid response
- `testConnection()` -- success and failure cases

**post-store.test.js** (uses temp directory)
- `saveDraft()` -- creates file with frontmatter + text, returns draftId
- `getDraft()` -- reads and parses draft file
- `listDrafts()` -- returns all drafts sorted by creation
- `deleteDraft()` -- removes file, returns true; missing file returns false
- `markPublished()` -- moves draft to published/, updates frontmatter
- `markPublished()` -- without draftId: creates new published entry directly
- `updateEngagement()` -- merges engagement data into frontmatter
- `generateSlug()` -- extracts first 5 words, handles punctuation, limits length
- Edge cases: empty posts dir, corrupt frontmatter, concurrent writes

**post-workflow.test.js** (mocks all deps)
- Session lifecycle: create, get, expire
- `getRecentCaptures()` -- calls Notion, returns formatted list
- `selectSources()` -- loads page content, returns excerpts + questions
- `setPostText()` -- stores text, returns preview
- `splitIntoThread()` -- splits and returns thread posts + preview
- `publish()` -- calls TypefullyClient, calls PostStore.markPublished, returns URLs
- `saveDraft()` -- calls PostStore.saveDraft, returns draftId
- State machine: invalid transitions rejected (e.g., /go from SELECT_SOURCES)
- Session TTL: expired sessions cleaned up

**clarify-questions.test.js**
- Returns questions for each known content type
- Returns default questions for unknown type
- Multi-source returns connector questions
- Always returns exactly 3 questions

**platforms.test.js**
- `formatPreview()` -- under limit, at limit, over limit
- `formatPreview()` -- identifies which platforms need threads
- `splitThread()` -- paragraph splitting
- `splitThread()` -- sentence splitting for long paragraphs
- `splitThread()` -- word-boundary hard break for very long sentences
- `splitThread()` -- preserves paragraph breaks when possible

### 12.2 Integration Tests (Manual, v1)

Telegram interaction flow tested manually:
1. Send voice note, capture succeeds
2. `/post` shows recent captures
3. Select source, see questions
4. Write post, see preview
5. `/go` publishes (requires live Typefully API key)
6. Verify post archive file created
7. `/stats` returns data

### 12.3 Test Helpers

```javascript
// test/helpers/publish-fixtures.js
module.exports = {
  sampleSummary: {
    title: 'Deep Work Artifacts',
    keyPoints: ['Focus creates artifacts', 'Busyness is not work'],
    summary: 'Deep work is about creating artifacts, not filling hours.',
    tags: ['productivity'],
  },
  sampleNotionPage: {
    id: 'test-page-id-123',
    properties: { /* ... */ },
  },
  sampleTypefullyResponse: {
    id: 'draft_abc123',
    // ...
  },
};
```

## 13. Environment Variables (New)

Add to `.env.example`:

```bash
# ── Social Publishing (Optional) ──
TYPEFULLY_API_KEY=               # Typefully API key (Settings > API)
TYPEFULLY_SOCIAL_SET_ID=         # Social set ID (connected accounts)
PUBLISH_PLATFORMS=twitter,linkedin,bluesky  # Platforms to publish to (comma-separated)
```

Publishing features are disabled when `TYPEFULLY_API_KEY` is not set. The `/post` command replies with "Publishing not configured" if the key is missing.

## 14. Risks and Open Questions

### 14.1 Confirmed Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Typefully API rate limits undocumented | Low | Single-user posting is far below any reasonable limit |
| Typefully v2 API is new (Dec 2025) | Medium | Pin to known-working endpoints; wrap in try/catch |
| Social set ID must be manually configured | Low | Document in README; could auto-discover via API later |
| Posts archive grows unbounded | Low | Git handles text files well; prune old drafts manually |

### 14.2 Open Questions

1. **Typefully social_set_id discovery**: Is there a `GET /v2/social-sets` endpoint to list available sets, or must the user find it in the Typefully dashboard? Verify against live API.

2. **Typefully published post URLs**: Does the create-draft response include per-platform post URLs, or do we need a separate call after publishing? Verify against live API.

3. **Notion page query for recent captures**: The current Notion client has no `queryDatabase()` method. We need to add one (simple `POST /databases/{id}/query` with sort by Date Added descending, limit 5) or use a different approach.

4. **Thread numbering**: Should threads include "1/N" prefixes? Configurable, or never?

## 15. Implementation Order

```
Phase 1: Core (can build in one session)
  1. src/publish/platforms.js         (~30 lines, pure functions)
  2. src/publish/clarify-questions.js (~50 lines, pure data)
  3. src/publish/typefully-client.js  (~80 lines, axios wrapper)
  4. src/publish/post-store.js        (~120 lines, filesystem CRUD)
  5. src/publish/post-workflow.js     (~200 lines, state machine)

Phase 2: Telegram wiring
  6. telegram-bot.js additions        (~150 lines, command handlers)
  7. posts/ directory + .gitkeep

Phase 3: Tests
  8. test/unit/publish/platforms.test.js
  9. test/unit/publish/clarify-questions.test.js
  10. test/unit/publish/typefully-client.test.js
  11. test/unit/publish/post-store.test.js
  12. test/unit/publish/post-workflow.test.js

Phase 4: Polish
  13. Notion page update after publish
  14. /stats command (engagement polling)
  15. .env.example + README update
```

Phases 1-3 are the MVP. Phase 4 is follow-up.
