/**
 * Post Store -- Draft and published post archive on the filesystem.
 *
 * Stores posts as markdown files with YAML frontmatter.
 * Drafts in posts/drafts/, published in posts/published/.
 */

const fs = require('fs');
const path = require('path');

class PostStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.draftsDir = path.join(baseDir, 'drafts');
    this.publishedDir = path.join(baseDir, 'published');
    this.ensureDirs();
  }

  ensureDirs() {
    for (const dir of [this.draftsDir, this.publishedDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ── Drafts ──────────────────────────────────────────────────────────────

  saveDraft(text, { sourceIds = [], sourceTitles = [] } = {}) {
    const nextNum = this._nextDraftNumber();
    const slug = this.generateSlug(text);
    const id = `draft-${String(nextNum).padStart(3, '0')}`;
    const filename = `${String(nextNum).padStart(3, '0')}-${slug}.md`;
    const filePath = path.join(this.draftsDir, filename);

    const frontmatter = {
      id,
      created: new Date().toISOString(),
      status: 'draft',
      source_ids: sourceIds,
      source_titles: sourceTitles,
    };

    fs.writeFileSync(filePath, this._serialize(frontmatter, text), 'utf8');
    return { draftId: id, filePath };
  }

  getDraft(draftId) {
    const file = this._findFile(this.draftsDir, draftId);
    if (!file) return null;
    return this._parse(path.join(this.draftsDir, file));
  }

  listDrafts() {
    return this._listDir(this.draftsDir);
  }

  deleteDraft(draftId) {
    const file = this._findFile(this.draftsDir, draftId);
    if (!file) return false;
    fs.unlinkSync(path.join(this.draftsDir, file));
    return true;
  }

  // ── Published ───────────────────────────────────────────────────────────

  markPublished(draftIdOrNull, {
    text, sourceIds = [], sourceTitles = [], platforms = [],
    typefullyDraftId = null, postUrls = {},
  }) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const slug = this.generateSlug(text);
    const id = `pub-${dateStr}-${String(this._nextPublishedNumber(dateStr)).padStart(3, '0')}`;
    const filename = `${dateStr}-${slug}.md`;
    const filePath = path.join(this.publishedDir, filename);

    const frontmatter = {
      id,
      date: now.toISOString(),
      status: 'published',
      source_ids: sourceIds,
      source_titles: sourceTitles,
      platforms,
      typefully_draft_id: typefullyDraftId,
      post_urls: postUrls,
      engagement: {},
      last_stats_pull: null,
    };

    fs.writeFileSync(filePath, this._serialize(frontmatter, text), 'utf8');

    // Remove draft if it exists
    if (draftIdOrNull) {
      this.deleteDraft(draftIdOrNull);
    }

    return { publishedId: id, filePath };
  }

  getPublished(publishedId) {
    const file = this._findFile(this.publishedDir, publishedId);
    if (!file) return null;
    return this._parse(path.join(this.publishedDir, file));
  }

  listPublished({ limit = 20, since = null } = {}) {
    let posts = this._listDir(this.publishedDir);
    if (since) {
      const sinceDate = new Date(since);
      posts = posts.filter(p => new Date(p.date || p.created) >= sinceDate);
    }
    return posts.slice(0, limit);
  }

  updateEngagement(publishedId, engagement) {
    const file = this._findFile(this.publishedDir, publishedId);
    if (!file) return;
    const filePath = path.join(this.publishedDir, file);
    const post = this._parse(filePath);
    if (!post) return;

    post.engagement = { ...post.engagement, ...engagement };
    post.last_stats_pull = new Date().toISOString();

    const { text, ...frontmatter } = post;
    fs.writeFileSync(filePath, this._serialize(frontmatter, text), 'utf8');
  }

  // ── Slug ────────────────────────────────────────────────────────────────

  generateSlug(text) {
    return text
      .replace(/[^\w\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join('-')
      .toLowerCase()
      .slice(0, 50);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _nextDraftNumber() {
    const files = fs.readdirSync(this.draftsDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return 1;
    const nums = files.map(f => parseInt(f.split('-')[0], 10)).filter(n => !isNaN(n));
    return (Math.max(0, ...nums)) + 1;
  }

  _nextPublishedNumber(dateStr) {
    const files = fs.readdirSync(this.publishedDir)
      .filter(f => f.startsWith(dateStr) && f.endsWith('.md'));
    return files.length + 1;
  }

  _findFile(dir, id) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      if (content.includes(`id: ${id}`)) return file;
    }
    return null;
  }

  _listDir(dir) {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse(); // newest first
    return files.map(f => this._parse(path.join(dir, f))).filter(Boolean);
  }

  _serialize(frontmatter, text) {
    const yaml = Object.entries(frontmatter)
      .map(([k, v]) => {
        if (v === null) return `${k}: null`;
        if (Array.isArray(v)) {
          if (v.length === 0) return `${k}: []`;
          return `${k}:\n${v.map(i => `  - "${String(i).replace(/"/g, '\\"')}"`).join('\n')}`;
        }
        if (typeof v === 'object') {
          if (Object.keys(v).length === 0) return `${k}: {}`;
          return `${k}:\n${Object.entries(v).map(([sk, sv]) => `  ${sk}: ${JSON.stringify(sv)}`).join('\n')}`;
        }
        if (typeof v === 'string' && (v.includes(':') || v.includes('"'))) return `${k}: "${v.replace(/"/g, '\\"')}"`;
        return `${k}: ${v}`;
      })
      .join('\n');

    return `---\n${yaml}\n---\n\n${text}\n`;
  }

  _parse(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
      if (!match) return null;

      const frontmatter = this._parseYaml(match[1]);
      frontmatter.text = match[2].trim();
      return frontmatter;
    } catch {
      return null;
    }
  }

  _parseYaml(yamlStr) {
    const result = {};
    const lines = yamlStr.split('\n');
    let currentKey = null;
    let currentArray = null;
    let currentObject = null;

    for (const line of lines) {
      // Array item
      const arrayMatch = line.match(/^\s+-\s+"?(.*?)"?\s*$/);
      if (arrayMatch && currentKey) {
        if (currentArray) currentArray.push(arrayMatch[1]);
        continue;
      }

      // Object property
      const objMatch = line.match(/^\s+(\w+):\s+(.+)$/);
      if (objMatch && currentKey && currentObject !== null) {
        try { currentObject[objMatch[1]] = JSON.parse(objMatch[2]); }
        catch { currentObject[objMatch[1]] = objMatch[2]; }
        continue;
      }

      // Top-level key
      const keyMatch = line.match(/^(\w[\w_]*?):\s*(.*)$/);
      if (keyMatch) {
        // Flush previous (array takes priority over empty object)
        if (currentKey) {
          if (currentArray && currentArray.length > 0) {
            result[currentKey] = currentArray;
          } else if (currentObject && Object.keys(currentObject).length > 0) {
            result[currentKey] = currentObject;
          }
        }

        currentKey = keyMatch[1];
        const value = keyMatch[2].trim();
        currentArray = null;
        currentObject = null;

        if (value === '' || value === undefined) {
          // Multi-line value follows (array or object)
          currentArray = [];
          currentObject = {};
        } else if (value === '[]') {
          result[currentKey] = [];
          currentKey = null;
        } else if (value === '{}') {
          result[currentKey] = {};
          currentKey = null;
        } else if (value === 'null') {
          result[currentKey] = null;
          currentKey = null;
        } else if (value === 'true') {
          result[currentKey] = true;
          currentKey = null;
        } else if (value === 'false') {
          result[currentKey] = false;
          currentKey = null;
        } else {
          // Scalar -- strip quotes
          result[currentKey] = value.replace(/^"(.*)"$/, '$1');
          currentKey = null;
        }
      }
    }

    // Flush last
    if (currentKey && currentArray && currentArray.length > 0) result[currentKey] = currentArray;
    else if (currentKey && currentObject && Object.keys(currentObject).length > 0) result[currentKey] = currentObject;

    return result;
  }
}

module.exports = PostStore;
