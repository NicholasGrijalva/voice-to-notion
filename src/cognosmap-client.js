/**
 * CognosMap API Client
 *
 * Implements the same interface as NotionClient and ObsidianClient
 * so it can be swapped in via DESTINATION=cognosmap or /mode cognosmap.
 *
 * Talks to CognosMap's FastAPI backend (src/api/) over HTTP.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

class CognosMapClient {
  constructor(baseUrl, apiKey, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeout = options.timeout || 60000;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: this.timeout,
    });
  }

  /**
   * Create a page with structured Summary + Content sections.
   * Maps to POST /api/notes on CognosMap.
   */
  async createStructuredPage({
    title, content, summary = null, source = 'Idea',
    sourceFilename = null, sourceRef = null,
    audioFileUploadId = null, imageFileUploadId = null,
    metadata = {}, annotation = null,
  }) {
    const body = this._buildMarkdown({
      title, content, summary, source, sourceFilename, sourceRef,
      audioFileUploadId, imageFileUploadId, metadata, annotation,
    });

    const tags = [
      `source:${source.toLowerCase()}`,
      ...(summary?.tags || []),
    ].filter(Boolean);

    const response = await this.client.post('/api/notes', {
      title: title.slice(0, 200),
      body_markdown: body,
      tags,
      metadata: {
        source,
        source_ref: sourceRef || null,
        source_filename: sourceFilename || null,
        processing_time: metadata.processingTime || null,
        url: metadata.url || null,
        duration: metadata.duration || null,
        language: metadata.language || null,
        audio_file_id: audioFileUploadId || null,
        image_file_id: imageFileUploadId || null,
      },
    });

    const noteId = response.data.id || response.data.note_id;
    console.log(`[CognosMap] Created note: ${noteId}`);
    return noteId;
  }

  /**
   * Legacy page creation (same as createStructuredPage for CognosMap).
   */
  async createTranscriptPage(opts) {
    return this.createStructuredPage(opts);
  }

  /**
   * Upload a file to CognosMap's R2 storage.
   * Returns an upload/file ID that can be referenced in page creation.
   */
  async uploadFile(filePath, filename, contentType) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), {
        filename,
        contentType,
      });

      const response = await this.client.post('/api/v1/upload', form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout: this.timeout,
      });

      const fileId = response.data.document_id || response.data.file_id || response.data.id;
      console.log(`[CognosMap] Uploaded file: ${fileId}`);
      return fileId;
    } catch (error) {
      console.warn(`[CognosMap] File upload failed: ${error.response?.data || error.message}`);
      return null;
    }
  }

  /**
   * Append blocks to an existing note.
   * Converts Notion-style blocks to markdown and appends.
   */
  async appendBlocks(noteId, blocks) {
    const markdown = blocks.map(b => this._blockToMarkdown(b)).filter(Boolean).join('\n');

    try {
      // Fetch existing content, append, update
      const existing = await this.client.get(`/api/notes/${noteId}`);
      const currentBody = existing.data.body_markdown || '';
      await this.client.put(`/api/notes/${noteId}`, {
        body_markdown: currentBody + '\n\n' + markdown,
      });
    } catch (error) {
      console.error(`[CognosMap] appendBlocks failed: ${error.response?.data || error.message}`);
      throw error;
    }
  }

  /**
   * Fetch a single note by ID.
   */
  async getPage(noteId) {
    try {
      const response = await this.client.get(`/api/notes/${noteId}`);
      const note = response.data;
      return {
        id: note.id,
        title: note.title || 'Untitled',
        type: this._extractTag(note.tags, 'source') || 'Idea',
        summary: note.metadata?.summary || null,
        content: note.body_markdown || '',
      };
    } catch (error) {
      console.error(`[CognosMap] getPage failed: ${error.response?.data || error.message}`);
      return null;
    }
  }

  /**
   * Query recent notes.
   */
  async queryRecent({ limit = 5 } = {}) {
    try {
      const response = await this.client.get('/api/notes', {
        params: { limit, sort: 'updated_at', order: 'desc' },
      });

      const notes = response.data.notes || response.data || [];
      return notes.map(n => ({
        id: n.id,
        title: n.title || 'Untitled',
        type: this._extractTag(n.tags, 'source') || 'Idea',
        summary: n.metadata?.summary || null,
        timestamp: n.updated_at || n.created_at,
      }));
    } catch (error) {
      console.error(`[CognosMap] queryRecent failed: ${error.response?.data || error.message}`);
      return [];
    }
  }

  /**
   * Split text into chunks (shared interface with Notion/Obsidian).
   */
  splitText(text, maxLength = 1900) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < maxLength * 0.3) splitAt = remaining.lastIndexOf(' ', maxLength);
      if (splitAt < maxLength * 0.3) splitAt = maxLength;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  /**
   * Test API connection.
   */
  async testConnection() {
    try {
      await this.client.get('/api/notes', { params: { limit: 1 } });
      console.log('[CognosMap] Connection OK');
      return true;
    } catch (error) {
      console.error('[CognosMap] Connection failed:', error.response?.data || error.message);
      return false;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  _buildMarkdown({ title, content, summary, annotation, metadata }) {
    const parts = [];

    if (metadata.duration || metadata.language) {
      const meta = [
        metadata.duration ? `Duration: ${this._formatDuration(metadata.duration)}` : null,
        metadata.language ? `Language: ${metadata.language}` : null,
      ].filter(Boolean).join(' | ');
      if (meta) parts.push(`> ${meta}\n`);
    }

    if (annotation) parts.push(`> ${annotation}\n`);

    if (summary) {
      parts.push('## Summary\n');
      if (summary.summary) parts.push(summary.summary + '\n');
      if (summary.keyPoints?.length > 0) {
        parts.push('### Key Points\n');
        parts.push(summary.keyPoints.map(p => `- ${p}`).join('\n') + '\n');
      }
      parts.push('---\n');
    }

    parts.push('## Full Transcript\n');
    parts.push(content || '');

    return parts.join('\n');
  }

  _blockToMarkdown(block) {
    if (!block) return '';
    switch (block.type) {
      case 'divider': return '---';
      case 'heading_2': return `## ${block.heading_2?.rich_text?.[0]?.text?.content || ''}`;
      case 'heading_3': return `### ${block.heading_3?.rich_text?.[0]?.text?.content || ''}`;
      case 'paragraph': return block.paragraph?.rich_text?.map(t => t.text?.content || '').join('') || '';
      case 'bulleted_list_item': return `- ${block.bulleted_list_item?.rich_text?.[0]?.text?.content || ''}`;
      case 'quote': return `> ${block.quote?.rich_text?.[0]?.text?.content || ''}`;
      case 'image': return ''; // Skip image blocks in markdown
      case 'audio': return ''; // Skip audio blocks in markdown
      default: return '';
    }
  }

  _extractTag(tags, prefix) {
    if (!Array.isArray(tags)) return null;
    const tag = tags.find(t => t.startsWith(`${prefix}:`));
    return tag ? tag.slice(prefix.length + 1) : null;
  }

  _formatDuration(seconds) {
    if (!seconds) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  }
}

module.exports = CognosMapClient;
