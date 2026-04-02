/**
 * Obsidian Vault Client via Local REST API
 *
 * Drop-in alternative to NotionClient for writing notes to an Obsidian vault.
 * Uses the obsidian-local-rest-api plugin (HTTPS, self-signed cert).
 *
 * Matches NotionClient's interface:
 *   - createTranscriptPage({ title, transcript, source, metadata }) -> noteId
 *   - appendBlocks(notePath, blocks) -> void
 *   - testConnection() -> boolean
 */

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

class ObsidianClient {
  constructor(apiKey, vaultPath, { port = 27124, captureFolder = '01_Capture' } = {}) {
    this.apiKey = apiKey;
    this.vaultPath = vaultPath;
    this.captureFolder = captureFolder;
    this.baseUrl = `https://127.0.0.1:${port}`;

    // Self-signed cert -- skip TLS verification
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000,
    });
  }

  /**
   * Create a note in the vault. Mirrors NotionClient.createTranscriptPage().
   *
   * @param {Object} options
   * @param {string} options.title - Note title (becomes filename)
   * @param {string} options.transcript - Main content
   * @param {string} options.source - Source type ('Audio', 'Video', 'Idea', etc.)
   * @param {string|null} options.sourceFilename - Original filename
   * @param {Object} options.metadata - { duration, language, processingTime, url }
   * @returns {Promise<string>} Vault-relative path of created note
   */
  async createTranscriptPage({ title, transcript, source = 'Audio', sourceFilename = null, audioFileUploadId = null, imageFileUploadId = null, metadata = {} }) {
    transcript = typeof transcript === 'string' ? transcript : String(transcript || '');

    // Sanitize title for filesystem
    const safeTitle = this.sanitizeFilename(title);
    const notePath = `${this.captureFolder}/${safeTitle}.md`;

    // Build frontmatter
    const frontmatter = {
      created: new Date().toISOString().slice(0, 16),
      updated: new Date().toISOString().slice(0, 16),
      tags: ['capture', `capture/${source.toLowerCase()}`],
      type: source.toLowerCase(),
      source: sourceFilename || null,
      ...(metadata.url && { url: metadata.url }),
      ...(metadata.processingTime && { processing_time_s: metadata.processingTime }),
    };

    // Build YAML frontmatter block
    const yamlLines = ['---'];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        yamlLines.push(`${key}:`);
        for (const item of value) {
          yamlLines.push(`  - ${item}`);
        }
      } else {
        yamlLines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    yamlLines.push('---');

    // Build note body
    const bodyParts = [`# ${title}`];

    if (metadata.duration || metadata.language) {
      const metaParts = [];
      if (metadata.duration) metaParts.push(`Duration: ${this.formatDuration(metadata.duration)}`);
      if (metadata.language) metaParts.push(`Language: ${metadata.language}`);
      bodyParts.push(`> ${metaParts.join(' | ')}`);
    }

    if (audioFileUploadId) {
      const attachmentName = path.basename(audioFileUploadId);
      bodyParts.push('', `![[${attachmentName}]]`);
    }

    if (imageFileUploadId) {
      const attachmentName = path.basename(imageFileUploadId);
      bodyParts.push('', `![[${attachmentName}]]`);
    }

    bodyParts.push('', transcript);

    const content = yamlLines.join('\n') + '\n\n' + bodyParts.join('\n');

    // Write to vault via REST API
    const encodedPath = notePath.split('/').map(encodeURIComponent).join('/');
    await this.client.put(`/vault/${encodedPath}`, content, {
      headers: { 'Content-Type': 'text/markdown' },
    });

    console.log(`[Obsidian] Created note: ${notePath}`);
    return notePath;
  }

  /**
   * Append content to an existing note. Mirrors NotionClient.appendBlocks().
   * Used by reply chain to add "My Take" sections.
   *
   * @param {string} notePath - Vault-relative path
   * @param {Array} blocks - Array of block objects (simplified: { type, content })
   */
  async appendBlocks(notePath, blocks) {
    // Read existing content
    const encodedPath = notePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.client.get(`/vault/${encodedPath}`, {
      headers: { 'Accept': 'text/markdown' },
    });

    // Convert Notion-style blocks to markdown
    const markdownParts = [];
    for (const block of blocks) {
      if (block.type === 'divider') {
        markdownParts.push('\n---\n');
      } else if (block.type === 'heading_2') {
        const text = block.heading_2?.rich_text?.[0]?.text?.content || '';
        markdownParts.push(`\n## ${text}\n`);
      } else if (block.type === 'paragraph') {
        const text = block.paragraph?.rich_text?.[0]?.text?.content || '';
        markdownParts.push(text);
      } else if (block.type === 'image') {
        // Image was already uploaded via uploadFile() -- embed by vault path
        const uploadId = block.image?.file_upload?.id;
        if (uploadId) {
          const attachmentName = path.basename(uploadId);
          markdownParts.push(`\n![[${attachmentName}]]\n`);
        }
      }
    }

    const appendContent = markdownParts.join('\n');
    const newContent = existing.data + '\n' + appendContent;

    await this.client.put(`/vault/${encodedPath}`, newContent, {
      headers: { 'Content-Type': 'text/markdown' },
    });

    console.log(`[Obsidian] Appended to: ${notePath}`);
  }

  /**
   * Upload a file to the Obsidian vault as an attachment.
   * Returns the vault-relative path (used as embed link).
   *
   * @param {string} filePath - Local path to the file
   * @param {string} filename - Desired filename
   * @param {string} contentType - MIME type (e.g. 'audio/mpeg')
   * @returns {Promise<string|null>} Vault-relative path or null on failure
   */
  async uploadFile(filePath, filename, contentType) {
    try {
      const data = fs.readFileSync(filePath);
      const safeFilename = this.sanitizeFilename(path.basename(filename, path.extname(filename))) + path.extname(filename);
      const vaultPath = `${this.captureFolder}/attachments/${safeFilename}`;
      const encodedPath = vaultPath.split('/').map(encodeURIComponent).join('/');

      await this.client.put(`/vault/${encodedPath}`, data, {
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      console.log(`[Obsidian] Uploaded attachment: ${vaultPath}`);
      return vaultPath;
    } catch (error) {
      console.warn(`[Obsidian] Attachment upload failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Split text helper (matches NotionClient interface).
   */
  splitText(text, maxLength) {
    if (!text) return [''];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitIndex = remaining.lastIndexOf('. ', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf('\n', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1) {
        splitIndex = maxLength;
      }
      chunks.push(remaining.slice(0, splitIndex + 1).trim());
      remaining = remaining.slice(splitIndex + 1).trim();
    }
    return chunks.length > 0 ? chunks : [''];
  }

  /**
   * Test connection to Obsidian Local REST API
   */
  async testConnection() {
    try {
      const response = await this.client.get('/');
      console.log(`[Obsidian] Connected to vault (plugin: ${response.data?.manifest?.name || 'Local REST API'})`);
      return true;
    } catch (error) {
      console.error('[Obsidian] Connection failed:', error.message);
      return false;
    }
  }

  sanitizeFilename(title) {
    return title
      .replace(/[\/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  formatDuration(seconds) {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 60) {
      const hours = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      return `${hours}h ${remainingMins}m ${secs}s`;
    }
    return `${mins}m ${secs}s`;
  }

  /**
   * Create a note with structured Summary + Content sections.
   * Mirrors NotionClient.createStructuredPage().
   */
  async createStructuredPage({ title, content, summary = null, source = 'Idea', sourceFilename = null, sourceRef = null, audioFileUploadId = null, imageFileUploadId = null, metadata = {}, annotation = null }) {
    content = typeof content === 'string' ? content : String(content || '');

    const safeTitle = this.sanitizeFilename(summary?.title || title);
    const notePath = `${this.captureFolder}/${safeTitle}.md`;

    const frontmatter = {
      created: new Date().toISOString().slice(0, 16),
      updated: new Date().toISOString().slice(0, 16),
      tags: ['capture', `capture/${source.toLowerCase()}`],
      type: source.toLowerCase(),
      source: sourceFilename || null,
      ...(metadata.url && { url: metadata.url }),
      ...(metadata.processingTime && { processing_time_s: metadata.processingTime }),
    };

    const yamlLines = ['---'];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        yamlLines.push(`${key}:`);
        for (const item of value) yamlLines.push(`  - ${item}`);
      } else {
        yamlLines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    yamlLines.push('---');

    const bodyParts = [`# ${title}`];

    if (metadata.duration || metadata.language) {
      const metaParts = [];
      if (metadata.duration) metaParts.push(`Duration: ${this.formatDuration(metadata.duration)}`);
      if (metadata.language) metaParts.push(`Language: ${metadata.language}`);
      bodyParts.push(`> ${metaParts.join(' | ')}`);
    }

    if (audioFileUploadId) {
      const attachmentName = path.basename(audioFileUploadId);
      bodyParts.push('', `![[${attachmentName}]]`);
    }

    if (imageFileUploadId) {
      const attachmentName = path.basename(imageFileUploadId);
      bodyParts.push('', `![[${attachmentName}]]`);
    }

    // User annotation
    if (annotation) {
      bodyParts.push('', `> ${annotation}`);
    }

    // Summary section
    if (summary) {
      bodyParts.push('', '## Summary', '');
      if (summary.summary) bodyParts.push(summary.summary);
      if (summary.keyPoints && summary.keyPoints.length > 0) {
        bodyParts.push('', '### Key Points');
        for (const point of summary.keyPoints) bodyParts.push(`- ${point}`);
      }
      bodyParts.push('', '---');
    }

    // Full content section
    bodyParts.push('', '## Full Transcript', '', content);

    const noteContent = yamlLines.join('\n') + '\n\n' + bodyParts.join('\n');

    const encodedPath = notePath.split('/').map(encodeURIComponent).join('/');
    await this.client.put(`/vault/${encodedPath}`, noteContent, {
      headers: { 'Content-Type': 'text/markdown' },
    });

    console.log(`[Obsidian] Created structured note: ${notePath}`);
    return notePath;
  }

}

module.exports = ObsidianClient;
