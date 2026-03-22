/**
 * Notion API Client with File Upload Support
 * Uses the new FileUpload API (2025) for attaching audio files
 *
 * Flow:
 * 1. POST /v1/file_uploads - Create upload object
 * 2. POST upload_url with file content (multipart/form-data)
 * 3. Attach using type: "file_upload" with the ID
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const NOTION_API_VERSION = '2022-06-28';
const NOTION_BASE_URL = 'https://api.notion.com/v1';

class NotionClient {
  constructor(apiKey, databaseId) {
    this.apiKey = apiKey;
    this.databaseId = databaseId;
    this.client = axios.create({
      baseURL: NOTION_BASE_URL,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });
  }

  /**
   * Upload a file to Notion using the FileUpload API
   * @param {string} filePath - Local path to the file
   * @param {string} filename - Desired filename in Notion
   * @param {string} contentType - MIME type (e.g., 'audio/mpeg')
   * @returns {Promise<string>} The file_upload ID to use for attachment
   */
  async uploadFile(filePath, filename, contentType = 'audio/mpeg') {
    try {
      const fileSize = fs.statSync(filePath).size;
      const isLargeFile = fileSize > 20 * 1024 * 1024; // 20MB threshold

      console.log(`[Notion] Uploading file: ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

      // Step 1: Create file upload object
      const createPayload = {
        filename: filename,
        content_type: contentType
      };

      // For large files, use multi-part mode
      if (isLargeFile) {
        const partSize = 5 * 1024 * 1024; // 5MB parts
        const numberOfParts = Math.ceil(fileSize / partSize);
        createPayload.mode = 'multi_part';
        createPayload.number_of_parts = numberOfParts;
      }

      const createResponse = await this.client.post('/file_uploads', createPayload);
      const fileUpload = createResponse.data;

      console.log(`[Notion] Created file upload: ${fileUpload.id}`);

      // Step 2: Send file content
      if (isLargeFile) {
        await this.uploadMultiPart(fileUpload, filePath, fileSize);
      } else {
        await this.uploadSinglePart(fileUpload, filePath, filename, contentType);
      }

      console.log(`[Notion] File upload complete: ${fileUpload.id}`);
      return fileUpload.id;

    } catch (error) {
      console.error('[Notion] File upload failed:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Upload file in a single request (for files < 20MB)
   */
  async uploadSinglePart(fileUpload, filePath, filename, contentType) {
    const uploadUrl = fileUpload.upload_url;

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), {
      filename: filename,
      contentType: contentType
    });

    await axios.post(uploadUrl, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${this.apiKey}`,
        'Notion-Version': NOTION_API_VERSION
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  }

  /**
   * Upload file in multiple parts (for files > 20MB)
   */
  async uploadMultiPart(fileUpload, filePath, fileSize) {
    const partSize = 5 * 1024 * 1024; // 5MB
    const numberOfParts = Math.ceil(fileSize / partSize);
    const fileBuffer = fs.readFileSync(filePath);

    for (let i = 0; i < numberOfParts; i++) {
      const start = i * partSize;
      const end = Math.min(start + partSize, fileSize);
      const partBuffer = fileBuffer.slice(start, end);

      const partUploadUrl = fileUpload.upload_url;

      const form = new FormData();
      form.append('file', partBuffer, {
        filename: `part_${i + 1}`,
        contentType: 'application/octet-stream'
      });
      form.append('part_number', String(i + 1));

      await axios.post(partUploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          'Notion-Version': NOTION_API_VERSION
        }
      });

      console.log(`[Notion] Uploaded part ${i + 1}/${numberOfParts}`);
    }

    // Complete the multi-part upload
    await this.client.post(`/file_uploads/${fileUpload.id}/complete`);
  }

  /**
   * Create a transcript page in the Inbox database
   *
   * Actual Inbox DB schema (verified from Notion API):
   * - Title (title)         — filename or descriptive title
   * - Status (select)       — New | Triaged | Processed | Needs verification | Done
   * - Date Added (date)     — when the transcript was added
   * - Type (select)         — Idea | Post | Audio | Video (Audio/Video added by us)
   * - Transcript (text)     — the transcript text (property, truncated to ~2000)
   * - Source Filename (text) — original filename
   * - Tags (multi_select)   — optional tags
   * - URL (url)             — optional source URL
   * - Processing Time (s)   — how long transcription took
   * - Project (relation)    — optional project link
   *
   * Full transcript goes in page body as paragraph blocks.
   *
   * @param {Object} options
   * @param {string} options.title - Page title
   * @param {string} options.transcript - Full transcript text
   * @param {string} options.source - Source type ('Audio', 'Video', or 'YouTube')
   * @param {string|null} options.sourceFilename - Original filename
   * @param {string|null} options.sourceRef - Source reference (filepath or URL for traceability)
   * @param {string|null} options.audioFileUploadId - File upload ID for audio attachment
   * @param {string|null} options.imageFileUploadId - File upload ID for image attachment
   * @param {Object} options.metadata - Additional metadata (duration, language, processingTime, url)
   * @returns {Promise<string>} Created page ID
   */
  async createTranscriptPage({ title, transcript, source = 'Audio', sourceFilename = null, sourceRef = null, audioFileUploadId = null, imageFileUploadId = null, metadata = {} }) {
    // Ensure transcript is always a string
    transcript = typeof transcript === 'string' ? transcript : String(transcript || '');

    try {
      // Build properties matching the real Inbox database schema
      const properties = {
        // Title (title property - required)
        'Title': {
          title: [
            {
              text: {
                content: title.slice(0, 2000)
              }
            }
          ]
        },

        // Status → always "New" on ingest
        'Status': {
          select: {
            name: 'New'
          }
        },

        // Date Added (date property)
        'Date Added': {
          date: {
            start: new Date().toISOString()
          }
        },

        // Type → Audio or Video (Notion auto-creates new select options)
        'Type': {
          select: {
            name: source
          }
        }
      };

      // Source Filename (if available)
      if (sourceFilename) {
        properties['Source Filename'] = {
          rich_text: [
            {
              text: {
                content: sourceFilename.slice(0, 2000)
              }
            }
          ]
        };
      }

      // Source (filepath or URL for traceability)
      if (sourceRef) {
        properties['Source'] = {
          rich_text: [
            {
              text: {
                content: sourceRef.slice(0, 2000)
              }
            }
          ]
        };
      }

      // Processing Time in seconds (if available)
      if (metadata.processingTime) {
        properties['Processing Time (s)'] = {
          number: metadata.processingTime
        };
      }

      // URL (if available - e.g., source video URL)
      if (metadata.url) {
        properties['URL'] = {
          url: metadata.url
        };
      }

      // Build page content (children blocks)
      const children = [];

      // Add transcript as paragraph blocks (split by Notion's 2000 char limit)
      const transcriptChunks = this.splitText(transcript, 1900);
      for (const chunk of transcriptChunks) {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: chunk
                }
              }
            ]
          }
        });
      }

      // Add audio block if we have a file upload
      if (audioFileUploadId) {
        children.unshift({
          object: 'block',
          type: 'audio',
          audio: {
            type: 'file_upload',
            file_upload: {
              id: audioFileUploadId
            }
          }
        });
      }

      // Add image block with heading if we have a file upload
      if (imageFileUploadId) {
        children.unshift({
          object: 'block',
          type: 'image',
          image: {
            type: 'file_upload',
            file_upload: {
              id: imageFileUploadId
            }
          }
        });
        children.unshift({
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: [{ type: 'text', text: { content: title.slice(0, 2000) } }]
          }
        });
      }

      // Add metadata as a callout at the start
      if (metadata.duration || metadata.language) {
        const metaText = [
          metadata.duration ? `Duration: ${this.formatDuration(metadata.duration)}` : null,
          metadata.language ? `Language: ${metadata.language}` : null
        ].filter(Boolean).join(' | ');

        if (metaText) {
          children.unshift({
            object: 'block',
            type: 'callout',
            callout: {
              rich_text: [{ type: 'text', text: { content: metaText } }],
              icon: { emoji: '🎙️' }
            }
          });
        }
      }

      // Create the page
      const response = await this.client.post('/pages', {
        parent: {
          type: 'database_id',
          database_id: this.databaseId
        },
        properties: properties,
        children: children.slice(0, 100) // Notion limit: 100 blocks per request
      });

      console.log(`[Notion] Created page: ${response.data.id}`);

      // If we have more than 100 blocks, append the rest
      if (children.length > 100) {
        await this.appendBlocks(response.data.id, children.slice(100));
      }

      return response.data.id;

    } catch (error) {
      console.error('[Notion] Page creation failed:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Append additional blocks to an existing page
   * @param {string} pageId - Page ID
   * @param {Array} blocks - Blocks to append
   */
  async appendBlocks(pageId, blocks) {
    // Append in batches of 100
    for (let i = 0; i < blocks.length; i += 100) {
      const batch = blocks.slice(i, i + 100);
      await this.client.patch(`/blocks/${pageId}/children`, {
        children: batch
      });
    }
  }

  /**
   * Split text into chunks of max length
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

      // Try to split at a sentence boundary
      let splitIndex = remaining.lastIndexOf('. ', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Try newline
        splitIndex = remaining.lastIndexOf('\n', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Try space
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1) {
        // Hard split
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex + 1).trim());
      remaining = remaining.slice(splitIndex + 1).trim();
    }

    return chunks.length > 0 ? chunks : [''];
  }

  /**
   * Format duration in seconds to human readable
   */
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
   * Ensure required schema exists on the database:
   * - Type select options: Audio, Video, YouTube
   * - Source rich_text property (for filepath/URL traceability)
   */
  async ensureTypeOptions() {
    try {
      // Fetch current database schema
      const db = await this.client.get(`/databases/${this.databaseId}`);
      const properties = db.data.properties || {};
      const patchPayload = {};

      // --- Type select options ---
      const typeProperty = properties['Type'];
      if (typeProperty && typeProperty.type === 'select') {
        const existingNames = (typeProperty.select?.options || []).map(o => o.name);
        const needed = [
          { name: 'Audio', color: 'purple' },
          { name: 'Video', color: 'orange' },
          { name: 'YouTube', color: 'red' }
        ].filter(opt => !existingNames.includes(opt.name));

        if (needed.length > 0) {
          const allOptions = [
            ...typeProperty.select.options.map(o => ({ name: o.name, color: o.color })),
            ...needed
          ];
          patchPayload['Type'] = { select: { options: allOptions } };
          console.log(`[Notion] Will add type options: ${needed.map(o => o.name).join(', ')}`);
        }
      }

      // --- Source rich_text property ---
      if (!properties['Source']) {
        patchPayload['Source'] = { rich_text: {} };
        console.log('[Notion] Will create "Source" property');
      }

      // Apply schema updates if any
      if (Object.keys(patchPayload).length > 0) {
        await this.client.patch(`/databases/${this.databaseId}`, {
          properties: patchPayload
        });
        console.log('[Notion] Schema updated');
      } else {
        console.log('[Notion] Schema already up to date');
      }
    } catch (error) {
      console.error('[Notion] Could not update schema:', error.response?.data || error.message);
    }
  }

  /**
   * Test connection to Notion API and set up schema
   */
  async testConnection() {
    try {
      const response = await this.client.get(`/databases/${this.databaseId}`);
      console.log(`[Notion] Connected to database: ${response.data.title?.[0]?.plain_text || this.databaseId}`);

      // Auto-add Audio/Video type options
      await this.ensureTypeOptions();

      return true;
    } catch (error) {
      console.error('[Notion] Connection test failed:', error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Create a page with structured Summary + Content sections.
   * Used by the enhanced pipeline (summarizer-enabled flow).
   */
  async createStructuredPage({ title, content, summary = null, source = 'Idea', sourceFilename = null, sourceRef = null, audioFileUploadId = null, imageFileUploadId = null, metadata = {} }) {
    content = typeof content === 'string' ? content : String(content || '');
    try {
      const properties = {
        'Title': { title: [{ text: { content: title.slice(0, 2000) } }] },
        'Status': { select: { name: 'New' } },
        'Date Added': { date: { start: new Date().toISOString() } },
        'Type': { select: { name: source } },
      };
      if (sourceFilename) properties['Source Filename'] = { rich_text: [{ text: { content: sourceFilename.slice(0, 2000) } }] };
      if (sourceRef) properties['Source'] = { rich_text: [{ text: { content: sourceRef.slice(0, 2000) } }] };
      if (metadata.processingTime) properties['Processing Time (s)'] = { number: metadata.processingTime };
      if (metadata.url) properties['URL'] = { url: metadata.url };

      // Transcript property: summary for table view (truncated to 2000 chars)
      const transcriptPreview = summary
        ? summary.summary + (summary.keyPoints ? '\n\n' + summary.keyPoints.join('\n') : '')
        : (content || '').slice(0, 2000);
      if (transcriptPreview) {
        properties['Transcript'] = {
          rich_text: [{ text: { content: transcriptPreview.slice(0, 2000) } }]
        };
      }

      // Tags: auto-populated from LLM summary if available
      if (summary && summary.tags && summary.tags.length > 0) {
        const validTags = ['knowledge management', 'information synthesis', 'productivity', 'cognitive load', 'structured thinking'];
        const filteredTags = summary.tags.filter(t => validTags.includes(t));
        if (filteredTags.length > 0) {
          properties['Tags'] = {
            multi_select: filteredTags.map(t => ({ name: t }))
          };
        }
      }

      const children = [];

      if (metadata.duration || metadata.language) {
        const metaText = [metadata.duration ? `Duration: ${this.formatDuration(metadata.duration)}` : null, metadata.language ? `Language: ${metadata.language}` : null].filter(Boolean).join(' | ');
        if (metaText) children.push({ object: 'block', type: 'callout', callout: { rich_text: [{ type: 'text', text: { content: metaText } }], icon: { emoji: '\uD83C\uDF99\uFE0F' } } });
      }

      if (audioFileUploadId) children.push({ object: 'block', type: 'audio', audio: { type: 'file_upload', file_upload: { id: audioFileUploadId } } });
      if (imageFileUploadId) children.push({ object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: imageFileUploadId } } });

      if (summary) {
        children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Summary' } }] } });
        if (summary.summary) children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: summary.summary } }] } });
        if (summary.keyPoints && summary.keyPoints.length > 0) {
          children.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: 'Key Points' } }] } });
          for (const point of summary.keyPoints) { children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: point } }] } }); }
        }
        children.push({ object: 'block', type: 'divider', divider: {} });
      }

      children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Full Transcript' } }] } });
      const contentChunks = this.splitText(content, 1900);
      for (const chunk of contentChunks) { children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] } }); }

      const response = await this.client.post('/pages', { parent: { type: 'database_id', database_id: this.databaseId }, properties, children: children.slice(0, 100) });
      console.log(`[Notion] Created structured page: ${response.data.id}`);
      if (children.length > 100) await this.appendBlocks(response.data.id, children.slice(100));
      return response.data.id;
    } catch (error) {
      console.error('[Notion] Structured page creation failed:', error.response?.data || error.message);
      throw error;
    }
  }

}

module.exports = NotionClient;
