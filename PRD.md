# Voice-to-Notion Transcription System – Complete PRD

**Document Version:** 1.0  
**Date:** January 26, 2026  
**Owner:** Truth Seeker Incorporated  
**Status:** Ready for Implementation

---

## 1. Executive Summary

Build a zero-OpenAI, self-hosted transcription pipeline that enables:

- **Record audio on phone** → **tap Share** → **auto-uploaded to Scriberr** → **transcribed locally** → **synced to Notion**.
- **Video upload** from desktop/SD card for batch processing.
- **Extensible architecture** for future AI-powered processing, summarization via Ollama (local LLM).
- **One-tap frictionless workflow** replacing expensive, unreliable cloud services.

**Core Stack:**
- **Backend:** Scriberr (self-hosted transcription + REST API)
- **Sync:** Node.js/Python worker polling Scriberr API → pushing to Notion
- **Mobile:** iOS Shortcut (1-tap share-sheet integration)
- **LLM (optional):** Ollama for local summarization

---

## 2. System Architecture Overview

### 2.1 High-Level Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                     USER WORKFLOWS                               │
└──────────────────────────────────────────────────────────────────┘

AUDIO PATH:                        VIDEO PATH:
┌─────────────────┐                ┌─────────────────┐
│ Voice Memos App │                │ Desktop / SD    │
│  (iOS, record)  │                │ (MP4, MOV, etc) │
└────────┬────────┘                └────────┬────────┘
         │                                  │
         │ Share → "Send to Scriberr"       │ Manual upload or script
         │ (iOS Shortcut)                   │
         │                                  │
         └──────────┬───────────────────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │  SCRIBERR SERVER     │◄────────────────────┐
         │  (Always-on machine) │                     │
         │                      │                     │
         │ ┌──────────────────┐ │  Poll every N secs  │
         │ │ REST API         │ │                     │
         │ │ POST /transcribe │ │                     │
         │ │ GET /jobs        │ │                     │
         │ └──────────────────┘ │                     │
         │                      │                     │
         │ ┌──────────────────┐ │                     │
         │ │ Transcription    │ │                     │
         │ │ WhisperX + Local │ │                     │
         │ │ Whisper Models   │ │                     │
         │ └──────────────────┘ │                     │
         │                      │                     │
         │ ┌──────────────────┐ │                     │
         │ │ SQLite Job DB    │ │                     │
         │ │ (status, text)   │ │                     │
         │ └──────────────────┘ │                     │
         └──────────┬───────────┘                     │
                    │                                │
                    │ Completed transcripts          │
                    ▼                                │
         ┌──────────────────────────────────────────┐
         │   NOTION SYNC WORKER                     │
         │   (Node/Python daemon or cron)           │
         │                                          │
         │  1. Poll Scriberr /jobs?status=done     ├─┘
         │  2. Fetch transcript text + metadata    │
         │  3. Call Notion /pages API              │
         │  4. Create page w/ transcript content   │
         │  5. Mark job as synced                  │
         └──────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │   NOTION DATABASE    │
         │  (Your note system)  │
         │  - Title (auto)      │
         │  - Transcript text   │
         │  - Timestamp         │
         │  - Source (audio/video)
         └──────────────────────┘
```

### 2.2 Component Breakdown

| Component | Role | Technology | Location |
|-----------|------|-----------|----------|
| **Phone** | Record & initiate | iOS Voice Memos + Shortcut | User's iPhone |
| **iOS Shortcut** | 1-tap upload | Native Shortcuts app | User's iPhone |
| **Scriberr Server** | Transcribe & API | Docker container | Always-on machine (Mac mini, server, etc.) |
| **Notion Sync Worker** | Poll & sync | Node.js / Python | Same machine as Scriberr (or separate) |
| **Scriberr DB** | Job tracking | SQLite (embedded) | Scriberr machine `/data` volume |
| **Notion API** | Destination | REST API (official SDK) | Cloud (Notion) |
| **Ollama (optional)** | Local LLM | Docker container | Same machine as Scriberr |

---

## 3. Core System Components

### 3.1 Scriberr Server Setup

**Purpose:** Self-hosted AI transcription service with REST API.

**Installation:**

```bash
# Option A: Docker (Recommended)
docker run -d \
  --name scriberr \
  -p 8080:8080 \
  -v scriberr_data:/app/data \
  -e WHISPER_MODEL=large-v2 \
  -e DEVICE=cuda \
  --gpus all \
  ghcr.io/rishikanthc/scriberr:latest

# Option B: Docker Compose (Production)
# See section 3.1.1
```

**Key Environment Variables:**

```bash
WHISPER_MODEL=large-v2          # Model size (base, small, medium, large-v2, large-v3)
DEVICE=cuda                     # cuda, cpu, or mps (Apple Silicon)
ENABLE_DIARIZATION=true         # Speaker labeling
ENABLE_SUMMARIZATION=false      # Disable OpenAI summaries
OLLAMA_BASE_URL=http://ollama:11434  # For local LLM if used
```

**API Reference (Core Endpoints):**

| Endpoint | Method | Purpose | Auth | Request |
|----------|--------|---------|------|---------|
| `/api/transcribe` | `POST` | Submit audio/video for transcription | Bearer token | `file`, `language` |
| `/api/jobs` | `GET` | List all jobs (optionally filter by status) | Bearer token | `?status=completed` or `pending` |
| `/api/jobs/:id` | `GET` | Get specific job details | Bearer token | N/A |
| `/api/transcripts/:id` | `GET` | Get transcript text + metadata | Bearer token | N/A |
| `/api/export/:id` | `GET` | Export as SRT/JSON/TXT | Bearer token | `?format=srt` |

**API Authentication:**

Generate API key in Scriberr UI (web interface on `:8080`). Use in all requests:

```bash
Authorization: Bearer YOUR_SCRIBERR_API_KEY
```

---

#### 3.1.1 Docker Compose Configuration (Production)

```yaml
version: '3.8'

services:
  scriberr:
    image: ghcr.io/rishikanthc/scriberr:latest
    container_name: scriberr
    ports:
      - "8080:8080"
    volumes:
      - scriberr_data:/app/data
    environment:
      WHISPER_MODEL: large-v2
      DEVICE: cuda
      ENABLE_DIARIZATION: "true"
      ENABLE_SUMMARIZATION: "false"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped
    networks:
      - transcription

  # Optional: Local LLM for summarization
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    environment:
      OLLAMA_NUM_PARALLEL: 1
    restart: unless-stopped
    networks:
      - transcription

  # Notion sync worker (implemented below)
  notion-worker:
    build: ./notion-worker
    container_name: notion-worker
    environment:
      SCRIBERR_API_URL: http://scriberr:8080
      SCRIBERR_API_KEY: ${SCRIBERR_API_KEY}
      NOTION_API_KEY: ${NOTION_API_KEY}
      NOTION_DATABASE_ID: ${NOTION_DATABASE_ID}
      POLL_INTERVAL_SECONDS: 30
    depends_on:
      - scriberr
    restart: unless-stopped
    networks:
      - transcription

volumes:
  scriberr_data:
  ollama_data:

networks:
  transcription:
    driver: bridge
```

**Usage:**

```bash
# Copy environment variables
cp .env.example .env
# Edit .env with your API keys

# Start all services
docker-compose up -d

# Verify
docker-compose logs -f scriberr
docker-compose logs -f notion-worker
```

---

### 3.2 iOS Shortcut: "Send to Scriberr"

**Purpose:** 1-tap upload from Voice Memos share sheet.

**Prerequisites:**

- iOS 15+
- Shortcuts app installed
- Know your Scriberr server URL (e.g., `https://your-domain.com:8080` or `http://192.168.1.100:8080` on LAN)
- Scriberr API key

**Shortcut Steps:**

1. **Receive Files from Share Sheet**
   - Add action: "Receive **Files**"
   - Type: `Any`

2. **Get URL Contents (Upload to Scriberr)**
   ```
   Action: "Get URL Contents"
   Method: POST
   URL: https://your-scriberr-url/api/transcribe
   
   Headers:
     Content-Type: multipart/form-data
     Authorization: Bearer YOUR_SCRIBERR_API_KEY
   
   Request Body: Form
     - Field: "file" → Type: File → Value: (File from Receive)
     - Field: "language" → Type: Text → Value: "en"
   ```

3. **Show Notification (Optional)**
   ```
   Action: "Show Notification"
   Title: "Upload Started"
   Message: "Your audio is being transcribed"
   ```

4. **End of Shortcut**

**Detailed Shortcut Build (Step-by-Step):**

```plaintext
┌──────────────────────────────────────────┐
│ 1. Open Shortcuts app                    │
│    Create → New Shortcut                 │
└──────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────┐
│ 2. Add action: "Receive"                 │
│    - Type: Files, Allow Multiple: OFF    │
└──────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────┐
│ 3. Add action: "Ask for" (optional)      │
│    Ask: "Language (en/es/fr)?"           │
│    Default: "en"                         │
│    Save to: language_code                │
└──────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────┐
│ 4. Add action: "Get URL Contents"        │
│    Configure (see below)                 │
└──────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────┐
│ 5. Add action: "Show Notification"       │
│    Title: "Upload Started"               │
│    Message: "File sent to Scriberr"      │
└──────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────┐
│ 6. Done                                  │
└──────────────────────────────────────────┘
```

**"Get URL Contents" Configuration (Critical):**

In the "Get URL Contents" action:

- **URL field:** `https://your-scriberr-url/api/transcribe`
  - If on local network: `http://192.168.1.xxx:8080/api/transcribe`
  - If remote: `https://your-domain.com:8080/api/transcribe` (with SSL cert)

- **Method:** `POST`

- **Headers:**
  ```
  Authorization: Bearer YOUR_SCRIBERR_API_KEY_HERE
  ```

- **Request Body:** Select "Form"
  - Add field: `file`
    - Type: File
    - Value: (from the "Receive" action, should populate automatically)
  - Add field: `language`
    - Type: Text
    - Value: `en` (or use the `language_code` variable if you added the "Ask for" step)

**Testing the Shortcut:**

1. In Voice Memos, record a 10-second test audio.
2. Tap and hold the recording → **Share** → **More** (bottom) → Find "Send to Scriberr" (or your custom name).
3. Tap it. You should see the notification "Upload Started" and the file should appear in Scriberr's job queue.
4. Check Scriberr web UI at `http://your-server:8080` → Jobs to confirm upload.

**Shortcut Sharing:**

Export from Shortcuts app → Share as `.shortcut` file. You can distribute this to team members who then import it and update the URL and API key.

---

#### 3.2.1 Alternative: Faster Shortcuts (No Language Prompt)

If you want maximum speed (1 tap = instant upload), create a simpler version that hardcodes `en`:

```plaintext
Receive Files
    ↓
Get URL Contents
  URL: https://your-scriberr-url/api/transcribe
  Method: POST
  Headers:
    Authorization: Bearer YOUR_SCRIBERR_API_KEY
  Request Body: Form
    file: (received file)
    language: en
    ↓
Show Result (optional)
```

---

### 3.3 Notion Sync Worker

**Purpose:** Poll Scriberr for completed transcriptions and create Notion pages.

#### 3.3.1 Setup: Notion API Integration

**Create Notion Integration:**

1. Go to **https://www.notion.com/my-integrations**.
2. Click **"+ New Integration"**.
3. Name: "Scriberr Sync Worker".
4. Select workspace.
5. Copy **Internal Integration Secret** (your `NOTION_API_KEY`).

**Create/Identify Notion Database:**

1. In your Notion workspace, create a new database (or use existing).
2. Required properties:
   - **Title** (default, auto-created as text)
   - **Transcript** (Text)
   - **Source** (Select: Audio, Video)
   - **Timestamp** (Date/Time, auto-filled)
   - **Status** (Select: Pending, Synced, Error)
   - *Optional:* **Summary** (Text), **Duration** (Number), **Speakers** (Text)

3. Share the database with your integration:
   - Click **Share** on the database.
   - Invite your integration by name.
   - Copy the **Database ID** from the URL: `https://notion.so/WORKSPACE/DATABASE_ID?v=...`

---

#### 3.3.2 Node.js Worker Implementation

**Project Structure:**

```
notion-worker/
├── Dockerfile
├── package.json
├── .env.example
├── src/
│   ├── index.js
│   ├── scriberr.js
│   ├── notion.js
│   └── sync.js
└── README.md
```

**package.json:**

```json
{
  "name": "notion-scriberr-sync",
  "version": "1.0.0",
  "description": "Sync Scriberr transcripts to Notion",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js"
  },
  "dependencies": {
    "@notionhq/client": "^2.2.14",
    "axios": "^1.6.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.0"
  }
}
```

**.env.example:**

```env
# Scriberr
SCRIBERR_API_URL=http://scriberr:8080
SCRIBERR_API_KEY=your_scriberr_api_key

# Notion
NOTION_API_KEY=secret_your_notion_integration_token
NOTION_DATABASE_ID=your_database_id_without_hyphens

# Worker
POLL_INTERVAL_SECONDS=30
LOG_LEVEL=info
```

**src/scriberr.js (Scriberr API client):**

```javascript
const axios = require('axios');

class ScriberrClient {
  constructor(apiUrl, apiKey) {
    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // Get all jobs with optional status filter
  async getJobs(status = null) {
    try {
      const params = status ? { status } : {};
      const response = await this.client.get('/api/jobs', { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching jobs:', error.message);
      throw error;
    }
  }

  // Get specific job details
  async getJob(jobId) {
    try {
      const response = await this.client.get(`/api/jobs/${jobId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching job ${jobId}:`, error.message);
      throw error;
    }
  }

  // Get transcript for completed job
  async getTranscript(jobId) {
    try {
      const response = await this.client.get(`/api/transcripts/${jobId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching transcript ${jobId}:`, error.message);
      throw error;
    }
  }

  // Mark job as synced (custom endpoint or metadata update)
  async markJobSynced(jobId) {
    try {
      // If Scriberr doesn't have a native endpoint, store state locally
      // For now, just log it
      console.log(`[Scriberr] Job ${jobId} marked as synced`);
      return true;
    } catch (error) {
      console.error(`Error marking job ${jobId} as synced:`, error.message);
      throw error;
    }
  }
}

module.exports = ScriberrClient;
```

**src/notion.js (Notion API client):**

```javascript
const { Client } = require('@notionhq/client');

class NotionClient {
  constructor(apiKey, databaseId) {
    this.notion = new Client({ auth: apiKey });
    this.databaseId = databaseId;
  }

  // Create a new page (transcript entry) in the database
  async createTranscriptPage(transcript, metadata = {}) {
    try {
      const response = await this.notion.pages.create({
        parent: {
          type: 'database_id',
          database_id: this.databaseId
        },
        properties: {
          // Title (required)
          'Title': {
            title: [
              {
                text: {
                  content: metadata.title || `Transcript - ${new Date().toLocaleString()}`
                }
              }
            ]
          },

          // Transcript text (truncate to Notion's limits)
          'Transcript': {
            rich_text: [
              {
                text: {
                  content: transcript.slice(0, 1800)  // Notion has a ~2000 char limit per block
                }
              }
            ]
          },

          // Source (Select property)
          'Source': {
            select: {
              name: metadata.source || 'Audio'  // 'Audio' or 'Video'
            }
          },

          // Timestamp
          'Timestamp': {
            date: {
              start: new Date().toISOString()
            }
          },

          // Status
          'Status': {
            select: {
              name: 'Synced'
            }
          }

          // Optional: Add summary if available
          // 'Summary': {
          //   rich_text: [{ text: { content: metadata.summary || '' } }]
          // }
        }
      });

      console.log(`[Notion] Created page: ${response.id}`);
      return response.id;
    } catch (error) {
      console.error('Error creating Notion page:', error.message);
      throw error;
    }
  }

  // If transcript is very long, create a child page with full content
  async appendTranscriptBlock(pageId, transcript) {
    try {
      await this.notion.blocks.children.append({
        block_id: pageId,
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  text: {
                    content: transcript
                  }
                }
              ]
            }
          }
        ]
      });
      return true;
    } catch (error) {
      console.error('Error appending block:', error.message);
      throw error;
    }
  }
}

module.exports = NotionClient;
```

**src/sync.js (Main sync logic):**

```javascript
const ScriberrClient = require('./scriberr');
const NotionClient = require('./notion');
const fs = require('fs');
const path = require('path');

class SyncWorker {
  constructor(scriberrClient, notionClient, pollInterval = 30000) {
    this.scriberr = scriberrClient;
    this.notion = notionClient;
    this.pollInterval = pollInterval;
    this.syncedJobs = new Set();
    this.loadState();
  }

  // Load previously synced job IDs from file
  loadState() {
    const stateFile = path.join(__dirname, '../.sync-state.json');
    try {
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        this.syncedJobs = new Set(state.syncedJobs || []);
        console.log(`[SyncWorker] Loaded ${this.syncedJobs.size} previously synced jobs`);
      }
    } catch (error) {
      console.warn('Could not load state:', error.message);
      this.syncedJobs = new Set();
    }
  }

  // Save synced job IDs
  saveState() {
    const stateFile = path.join(__dirname, '../.sync-state.json');
    try {
      fs.writeFileSync(stateFile, JSON.stringify({
        syncedJobs: Array.from(this.syncedJobs),
        lastSync: new Date().toISOString()
      }));
    } catch (error) {
      console.error('Error saving state:', error.message);
    }
  }

  // Main sync function
  async sync() {
    try {
      console.log(`[SyncWorker] Starting sync at ${new Date().toISOString()}`);

      // Fetch completed jobs from Scriberr
      const jobs = await this.scriberr.getJobs('completed');
      
      if (!jobs || jobs.length === 0) {
        console.log('[SyncWorker] No completed jobs found');
        return;
      }

      console.log(`[SyncWorker] Found ${jobs.length} completed job(s)`);

      // Process each job
      for (const job of jobs) {
        // Skip if already synced
        if (this.syncedJobs.has(job.id)) {
          console.log(`[SyncWorker] Job ${job.id} already synced, skipping`);
          continue;
        }

        try {
          // Fetch full transcript
          const transcript = await this.scriberr.getTranscript(job.id);
          
          // Determine source type (audio or video)
          const source = job.filename.endsWith('.mp4') || 
                        job.filename.endsWith('.mov') ? 'Video' : 'Audio';

          // Create Notion page
          await this.notion.createTranscriptPage(
            transcript.text,
            {
              title: job.filename || `Transcript ${job.id}`,
              source: source
            }
          );

          // Mark as synced
          this.syncedJobs.add(job.id);
          await this.scriberr.markJobSynced(job.id);

          console.log(`[SyncWorker] ✓ Synced job ${job.id}`);
        } catch (error) {
          console.error(`[SyncWorker] ✗ Failed to sync job ${job.id}:`, error.message);
        }
      }

      // Save state
      this.saveState();
      console.log(`[SyncWorker] Sync complete. Synced ${this.syncedJobs.size} total jobs.`);
    } catch (error) {
      console.error('[SyncWorker] Sync failed:', error.message);
    }
  }

  // Start polling
  start() {
    console.log(`[SyncWorker] Starting with ${this.pollInterval}ms poll interval`);
    this.sync(); // Run immediately
    this.interval = setInterval(() => this.sync(), this.pollInterval);
  }

  // Stop polling
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      console.log('[SyncWorker] Stopped');
    }
  }
}

module.exports = SyncWorker;
```

**src/index.js (Entry point):**

```javascript
require('dotenv').config();
const ScriberrClient = require('./scriberr');
const NotionClient = require('./notion');
const SyncWorker = require('./sync');

const scriberr = new ScriberrClient(
  process.env.SCRIBERR_API_URL,
  process.env.SCRIBERR_API_KEY
);

const notion = new NotionClient(
  process.env.NOTION_API_KEY,
  process.env.NOTION_DATABASE_ID
);

const worker = new SyncWorker(
  scriberr,
  notion,
  parseInt(process.env.POLL_INTERVAL_SECONDS || 30) * 1000
);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Worker] Received SIGINT, shutting down...');
  worker.stop();
  process.exit(0);
});

// Start the worker
worker.start();
```

**Dockerfile:**

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src ./src

CMD ["npm", "start"]
```

**Deployment:**

```bash
# Build image
docker build -t notion-scriberr-sync:1.0 .

# Run with environment variables
docker run -d \
  --name notion-worker \
  -e SCRIBERR_API_URL=http://scriberr:8080 \
  -e SCRIBERR_API_KEY=${SCRIBERR_API_KEY} \
  -e NOTION_API_KEY=${NOTION_API_KEY} \
  -e NOTION_DATABASE_ID=${NOTION_DATABASE_ID} \
  -e POLL_INTERVAL_SECONDS=30 \
  --network transcription \
  notion-scriberr-sync:1.0
```

---

#### 3.3.3 Python Alternative (Optional)

If you prefer Python over Node:

```python
# notion_worker.py
import os
import json
import time
import requests
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv
from notion_client import Client

load_dotenv()

SCRIBERR_URL = os.getenv('SCRIBERR_API_URL')
SCRIBERR_KEY = os.getenv('SCRIBERR_API_KEY')
NOTION_KEY = os.getenv('NOTION_API_KEY')
NOTION_DB = os.getenv('NOTION_DATABASE_ID')
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL_SECONDS', 30))

# Initialize clients
scriberr_headers = {'Authorization': f'Bearer {SCRIBERR_KEY}'}
notion = Client(auth=NOTION_KEY)
synced_jobs = set()
state_file = Path('.sync-state.json')

def load_state():
    global synced_jobs
    if state_file.exists():
        data = json.loads(state_file.read_text())
        synced_jobs = set(data.get('synced_jobs', []))
        print(f"[Worker] Loaded {len(synced_jobs)} synced jobs")

def save_state():
    state_file.write_text(json.dumps({
        'synced_jobs': list(synced_jobs),
        'last_sync': datetime.now().isoformat()
    }))

def get_completed_jobs():
    response = requests.get(
        f'{SCRIBERR_URL}/api/jobs?status=completed',
        headers=scriberr_headers
    )
    return response.json()

def get_transcript(job_id):
    response = requests.get(
        f'{SCRIBERR_URL}/api/transcripts/{job_id}',
        headers=scriberr_headers
    )
    return response.json()

def create_notion_page(transcript_text, filename):
    source = 'Video' if filename.endswith(('.mp4', '.mov')) else 'Audio'
    
    notion.pages.create(
        parent={'database_id': NOTION_DB},
        properties={
            'Title': {'title': [{'text': {'content': filename}}]},
            'Transcript': {'rich_text': [{'text': {'content': transcript_text[:1800]}}]},
            'Source': {'select': {'name': source}},
            'Timestamp': {'date': {'start': datetime.now().isoformat()}},
            'Status': {'select': {'name': 'Synced'}}
        }
    )

def sync():
    print(f"[Worker] Starting sync at {datetime.now().isoformat()}")
    
    jobs = get_completed_jobs()
    
    if not jobs:
        print("[Worker] No completed jobs")
        return
    
    for job in jobs:
        if job['id'] in synced_jobs:
            print(f"[Worker] Job {job['id']} already synced")
            continue
        
        try:
            transcript = get_transcript(job['id'])
            create_notion_page(transcript['text'], job.get('filename', f"Transcript {job['id']}"))
            synced_jobs.add(job['id'])
            print(f"[Worker] ✓ Synced {job['id']}")
        except Exception as e:
            print(f"[Worker] ✗ Error syncing {job['id']}: {e}")
    
    save_state()

if __name__ == '__main__':
    load_state()
    
    while True:
        try:
            sync()
        except Exception as e:
            print(f"[Worker] Sync error: {e}")
        
        time.sleep(POLL_INTERVAL)
```

---

## 4. Deployment & Operations

### 4.1 Deployment Steps (End-to-End)

#### Step 1: Prepare Always-On Machine

Requirements:
- **OS:** macOS, Linux, or Windows (with WSL2)
- **Docker & Docker Compose:** Installed
- **Network:** LAN or remote access via VPN/Tailscale
- **Storage:** 50GB+ for models + transcripts
- **GPU (optional):** NVIDIA GPU for faster transcription (CUDA 11.8+)

```bash
# Install Docker (if not present)
# macOS: brew install docker
# Ubuntu: sudo apt-get install docker.io docker-compose

# Verify Docker works
docker --version
docker-compose --version
```

#### Step 2: Clone/Create Deployment Directory

```bash
mkdir -p ~/transcription-system
cd ~/transcription-system

# Copy docker-compose.yml from section 3.1.1
cat > docker-compose.yml << 'EOF'
# (paste full docker-compose.yml here)
EOF

# Create .env file
cat > .env << 'EOF'
SCRIBERR_API_KEY=generate_a_long_random_string_here
NOTION_API_KEY=secret_your_notion_integration_token
NOTION_DATABASE_ID=your_database_id_without_hyphens
EOF

# Edit .env with real values
nano .env
```

#### Step 3: Generate Scriberr API Key

```bash
# Start just Scriberr temporarily
docker-compose up scriberr &

# Wait ~30s for it to start
sleep 30

# Open web UI
# macOS: open http://localhost:8080
# Linux: firefox http://localhost:8080

# In UI: Settings → API Key → Generate
# Copy the key to .env

# Stop temporary container
docker-compose down
```

#### Step 4: Create Notion Database & Get IDs

1. **Create Database in Notion:**
   - New page → "Database" → "Table"
   - Name: "Voice Transcripts"

2. **Add Required Properties:**
   - **Title** (default)
   - **Transcript** (Text)
   - **Source** (Select: Audio, Video)
   - **Timestamp** (Date)
   - **Status** (Select: Pending, Synced, Error)

3. **Connect Integration:**
   - Database menu → Share → Invite your integration
   - Copy Database ID from URL

4. **Get Integration Token:**
   - https://www.notion.com/my-integrations
   - Copy Internal Integration Secret

5. **Update .env:**
   ```bash
   NOTION_API_KEY=secret_xxx...
   NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxx
   ```

#### Step 5: Deploy Full Stack

```bash
# From ~/transcription-system
docker-compose up -d

# Verify services
docker-compose ps
# Should show: scriberr (running), ollama (running), notion-worker (running)

# Check logs
docker-compose logs -f scriberr
docker-compose logs -f notion-worker
```

#### Step 6: Test Scriberr

```bash
# Upload test audio
curl -X POST http://localhost:8080/api/transcribe \
  -H "Authorization: Bearer ${SCRIBERR_API_KEY}" \
  -F "file=@test-audio.mp3" \
  -F "language=en"

# Check job status
curl http://localhost:8080/api/jobs \
  -H "Authorization: Bearer ${SCRIBERR_API_KEY}"
```

---

### 4.2 Network Exposure (Access from Phone)

#### Option A: Local Network (Easiest, LAN-only)

If phone and server are on same Wi-Fi:

1. Get server's IP: `ifconfig | grep "inet "` (Linux) or `System Preferences → Network` (macOS)
2. In iOS Shortcut, use: `http://192.168.1.XXX:8080/api/transcribe`
3. Connect phone to same Wi-Fi

**Limitations:** Only works on home Wi-Fi.

#### Option B: Remote Access via Tailscale (Recommended for True Portability)

**Setup Tailscale (5 min):**

1. Download Tailscale on both machine and iPhone.
2. Both machines auth with same account.
3. In Tailscale, get machine's **Tailscale IP** (e.g., `100.x.x.x`).
4. In iOS Shortcut, use: `http://100.x.x.x:8080/api/transcribe`
5. Both devices connected to Tailscale → access works anywhere.

**Advantages:**
- Works over cellular data (4G/5G)
- Secure encrypted tunnel
- No port forwarding or DNS setup needed
- Free tier covers personal use

#### Option C: Full HTTPS/Domain (Advanced)

For production:

1. Get domain name (e.g., `transcription.mycompany.com`)
2. Point to server's public IP
3. Use Let's Encrypt for SSL certificate (via reverse proxy like nginx)
4. Update Shortcut to use `https://transcription.mycompany.com/api/transcribe`

---

### 4.3 Monitoring & Maintenance

#### Health Checks

```bash
# Check all services running
docker-compose ps

# View logs (last 20 lines)
docker-compose logs --tail=20

# Continuous log stream
docker-compose logs -f notion-worker

# Check Scriberr API
curl http://localhost:8080/api/jobs \
  -H "Authorization: Bearer YOUR_KEY" | jq '.'
```

#### Disk Space Management

Scriberr stores models and transcripts in `/app/data`:

```bash
# Check volume size
docker volume inspect transcription-system_scriberr_data

# Prune old transcripts (optional)
# Inside docker: rm -rf /app/data/jobs/old_timestamp_*

# Monitor disk
df -h
```

#### Restarting Services

```bash
# Restart all
docker-compose restart

# Restart specific service
docker-compose restart scriberr

# Full restart (clean state)
docker-compose down
docker-compose up -d
```

---

## 5. Usage Workflows

### 5.1 Daily Workflow: Record → Transcribe → Notion

**Time Estimate:** <2 minutes from recording to Notion.

```
1. Open Voice Memos app
   └─ Tap "+" → Record → Tap "Stop" (10-30s duration)

2. Tap recording → "Share" button
   └─ Scroll right → Tap "Send to Scriberr"

3. (Shortcut runs, uploads in background)
   └─ Notification: "Upload Started"

4. ~30 seconds later (depending on audio length & GPU):
   └─ Notion Sync Worker fetches transcript
   └─ Creates page in "Voice Transcripts" database

5. Open Notion app → "Voice Transcripts" database
   └─ See new entry with full transcript, timestamp, source

Done!
```

**Alternative: Desktop Uploads**

For videos from SD card or computer:

```
1. Open Scriberr web UI on desktop: http://localhost:8080

2. Drag-and-drop MP4/MOV file (or paste YouTube URL)
   └─ Select language

3. Start transcription
   └─ Progress shown in UI

4. Once done, Notion Sync Worker automatically creates page
```

---

### 5.2 Extended Workflow: Transcription + Summarization

**Future State (v2):**

Add Ollama LLM to summarize transcripts:

```
Notion Sync Worker:
  1. Fetch transcript from Scriberr
  2. Call Ollama API: summarize(transcript)
  3. Create Notion page with both transcript + summary
```

**Implementation sketch:**

```python
# In notion.py
def create_notion_page_with_summary(transcript, summary=None):
    properties = {
        'Title': ...,
        'Transcript': ...,
        'Summary': {  # NEW
            'rich_text': [{'text': {'content': summary}}]
        }
    }
    notion.pages.create(parent=..., properties=properties)

# In sync.py
async def sync():
    # ... fetch transcript ...
    
    # NEW: Call Ollama for summary
    summary = await ollama.summarize(transcript)
    
    # Create page with summary
    await notion.create_notion_page_with_summary(transcript, summary)
```

---

## 6. Architecture Diagrams (Detailed)

### 6.1 Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                            USER DEVICE (iPhone)                     │
│                                                                     │
│  ┌────────────────────┐         ┌──────────────────────┐          │
│  │  Voice Memos App   │         │ iOS Shortcuts App    │          │
│  │  (Record audio)    │────────▶│ "Send to Scriberr"   │          │
│  └────────────────────┘         └──────────┬───────────┘          │
│                                            │                       │
│                                            │ Multipart file upload │
│                                            │ (16MB limit)          │
│                                            ▼                       │
└────────────────────────────────────────────┼──────────────────────┘
                                             │
                           ┌─────────────────┴────────────────┐
                           │ HTTPS/HTTP                       │
                           │ Authorization header + file      │
                           │                                  │
                           ▼                                  ▼
                    ┌─────────────────┐          ┌──────────────────┐
                    │ (option A) LAN  │          │ (option B)       │
                    │ 192.168.1.x:8080│          │ Tailscale IP     │
                    │ (same Wi-Fi)    │          │ 100.x.x.x:8080   │
                    └────────┬────────┘          └────────┬─────────┘
                             │                           │
                             └───────────┬───────────────┘
                                         │
                                         ▼
        ┌────────────────────────────────────────────────────────┐
        │          ALWAYS-ON MACHINE (Mac Mini/Server)           │
        │                                                        │
        │  ┌──────────────────────────────────────────────────┐ │
        │  │           Docker Network: transcription          │ │
        │  │                                                  │ │
        │  │  ┌──────────────┐      ┌─────────────────────┐ │ │
        │  │  │  SCRIBERR    │      │ NOTION-WORKER      │ │ │
        │  │  │              │      │                     │ │ │
        │  │  │ Port: 8080   │      │ Poll every 30s      │ │ │
        │  │  │              │      │                     │ │ │
        │  │  │ REST API:    │      │ Node.js / Python    │ │ │
        │  │  │ ─ POST       │◄─────┤ ─ Get completed     │ │ │
        │  │  │   /transcribe│      │   jobs              │ │ │
        │  │  │ ─ GET        │      │ ─ Create Notion     │ │ │
        │  │  │   /jobs      │      │   pages             │ │ │
        │  │  │ ─ GET        │      │                     │ │ │
        │  │  │   /transcripts       └──────────┬──────────┘ │ │
        │  │  │              │               Query API       │ │
        │  │  │ Transcription       ┌──────────────────────┐ │ │
        │  │  │ ─ WhisperX  │      │   OLLAMA (optional) │ │ │
        │  │  │ ─ Local     │      │                     │ │ │
        │  │  │   Whisper   │      │ Port: 11434         │ │ │
        │  │  │   models    │      │ For summarization   │ │ │
        │  │  │             │      │ (future v2)         │ │ │
        │  │  │ Storage:    │      └─────────────────────┘ │ │
        │  │  │ ─ SQLite DB │                               │ │
        │  │  │ ─ Job info  │                               │ │
        │  │  │ ─ Models    │                               │ │
        │  │  └──────────────┘                               │ │
        │  │                                                  │ │
        │  │  Volume Mounts:                                 │ │
        │  │  ─ scriberr_data: /app/data (models, jobs)     │ │
        │  │  ─ ollama_data: /root/.ollama (LLM models)     │ │
        │  │                                                  │ │
        │  └──────────────────────────────────────────────────┘ │
        │                                                        │
        └────────────────────────────┬─────────────────────────┘
                                     │
                                     │ HTTPS
                                     │ Bearer token auth
                                     ▼
        ┌────────────────────────────────────────────────────────┐
        │              NOTION API (Cloud)                        │
        │                                                        │
        │  POST /v1/pages (create transcript page)              │
        │  ─ Parent: Voice Transcripts database                 │
        │  ─ Properties: Title, Transcript, Source, Timestamp   │
        │                                                        │
        │  Response: Page ID (stored in .sync-state.json)       │
        └────────────────────────────────────────────────────────┘
```

### 6.2 State & Data Flow Diagram

```
INITIAL STATE:
  │
  ├─ Scriberr: Empty job queue
  ├─ Notion: Empty database
  ├─ Sync Worker: .sync-state.json = { syncedJobs: [] }
  │
  ▼

[USER RECORDS AUDIO & TAPS SHARE → "SEND TO SCRIBERR"]

  │
  ├─ iOS Shortcut POSTs file to: http://scriberr:8080/api/transcribe
  │   + Authorization header
  │   + file field (m4a, mp3, etc.)
  │   + language: en
  │
  ▼

SCRIBERR RECEIVES UPLOAD:

  │
  ├─ Creates job in SQLite: { id: uuid(), filename, status: "pending", created_at }
  ├─ Saves audio to: /app/data/uploads/{uuid}.m4a
  ├─ Returns HTTP 200 + job_id to Shortcut
  │
  ▼

SCRIBERR PROCESSES:

  │
  ├─ Loads Whisper model (first time: downloads, subsequent: cached)
  ├─ Runs transcription: audio → text
  ├─ Updates job: { status: "completed", text: "Hello world...", duration: 25 }
  ├─ Stores transcript: /app/data/transcripts/{uuid}.json
  │
  ▼

[~30 SECONDS LATER: SYNC WORKER POLLS]

  │
  ├─ Calls Scriberr: GET /api/jobs?status=completed
  ├─ Scriberr returns: [{ id: uuid1, status: completed, filename: "voice note" }]
  ├─ Worker checks: uuid1 in .sync-state.json? NO
  │
  ▼

WORKER FETCHES TRANSCRIPT:

  │
  ├─ Calls Scriberr: GET /api/transcripts/{uuid1}
  ├─ Scriberr returns: { text: "Hello world...", duration: 25, language: en }
  │
  ▼

WORKER CREATES NOTION PAGE:

  │
  ├─ Calls Notion: POST /v1/pages
  │   parent: { database_id: YOUR_DB_ID }
  │   properties: {
  │     Title: { title: [{ text: { content: "voice note" } }] },
  │     Transcript: { rich_text: [{ text: { content: "Hello world..." } }] },
  │     Source: { select: { name: "Audio" } },
  │     Timestamp: { date: { start: "2026-01-26T19:30:00Z" } },
  │     Status: { select: { name: "Synced" } }
  │   }
  ├─ Notion returns: { id: page_123, created_time, ... }
  │
  ▼

WORKER UPDATES STATE:

  │
  ├─ Adds uuid1 to .sync-state.json: { syncedJobs: [uuid1], lastSync: "..." }
  ├─ Next poll: skips uuid1 (already synced)
  │
  ▼

FINAL STATE:

  │
  ├─ Scriberr: Job { id: uuid1, status: completed }
  ├─ Notion: New page "voice note" with transcript
  ├─ Sync Worker: Marked as synced
  │
  └─ USER OPENS NOTION → SEES NEW TRANSCRIPT
```

---

## 7. Extension Points & Future Features

### v2: Local LLM Summarization

**Add to docker-compose.yml:**

```yaml
# Pull a model first: docker run -d ollama/ollama && ollama pull mistral
# Then add to worker environment

environment:
  OLLAMA_BASE_URL: http://ollama:11434
  ENABLE_SUMMARIZATION: "true"
  SUMMARY_MODEL: mistral  # or llama2, etc.
```

**In Notion worker:**

```python
import requests

def summarize_transcript(text):
    response = requests.post(
        'http://ollama:11434/api/generate',
        json={
            'model': 'mistral',
            'prompt': f'Summarize concisely: {text[:1000]}',
            'stream': False
        }
    )
    return response.json()['response']

# Then add to notion page properties
```

---

### v3: Multi-Language Support

**In iOS Shortcut:**

Ask user for language before upload, pass `language=es` (Spanish), `language=fr` (French), etc.

```swift
// In Shortcut "Ask for" action:
Ask: "Language?"
Options: ["English (en)", "Spanish (es)", "French (fr)"]
```

Scriberr auto-detects or uses language hint for better accuracy.

---

### v4: Batch Video Transcription

**Script for SD card ingestion:**

```python
import os
import requests
import glob

# Scan SD card
videos = glob.glob('/mnt/sdcard/**/*.mp4', recursive=True)

for video in videos:
    with open(video, 'rb') as f:
        requests.post(
            'http://scriberr:8080/api/transcribe',
            headers={'Authorization': f'Bearer {API_KEY}'},
            files={'file': f},
            data={'language': 'en'}
        )
    print(f"Submitted {video}")
```

---

### v5: Speaker Diarization in Notion

**Extract speaker labels from WhisperX:**

```python
# Scriberr already supports diarization; expose via API

# In Notion worker:
properties={
    'Speakers': { 'rich_text': [{ 'text': { 'content': 'Alice, Bob' } }] }
}
```

---

## 8. Troubleshooting

### Issue: "Connection refused" from Shortcut

**Causes & Solutions:**
- Server not running: `docker-compose ps` (check if scriberr is up)
- Wrong URL: Verify IP/domain in Shortcut settings
- Firewall blocking: `sudo ufw allow 8080` (Linux) or check macOS firewall
- Wrong network: Phone on different Wi-Fi than server (for LAN setup)

**Debug:**

```bash
# Test from computer on same LAN
curl http://192.168.1.100:8080

# Test from Shortcut by adding a "Show Notification" with response status
```

---

### Issue: Transcription very slow (>5 min per 1 min audio)

**Causes & Solutions:**
- CPU-only mode: Enable GPU in docker-compose.yml
- Model size too large: Use `base` or `small` instead of `large-v2`
- Out of VRAM: Reduce `batch_size` in Scriberr config

**Debug:**

```bash
docker-compose logs scriberr | grep -i cuda
docker-compose logs scriberr | grep -i "device"
```

---

### Issue: Notion pages not being created

**Causes & Solutions:**
- Invalid token or database ID: Re-check `.env` file
- Database not shared with integration: Go to Notion → Share → Invite integration
- Network issue: `docker-compose logs notion-worker` (check for connection errors)
- Rate limiting: Notion API has rate limits; slow down `POLL_INTERVAL_SECONDS`

**Debug:**

```bash
# Test Notion API directly
curl https://api.notion.com/v1/pages \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" \
  -X GET
```

---

## 9. Security Considerations

### 9.1 API Key Protection

- **Scriberr API Key:** Store in `.env` (excluded from git). Never share.
- **Notion Integration Token:** Same as above.
- **Network:** Use Tailscale or VPN for remote access (not public IP).

### 9.2 HTTPS/TLS

For production remote deployment:

```yaml
# docker-compose.yml

services:
  nginx:
    image: nginx:latest
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl  # SSL certificates
    depends_on:
      - scriberr
```

---

## 10. Implementation Checklist

### Phase 1: MVP (Week 1)
- [ ] Deploy Scriberr on always-on machine
- [ ] Generate Scriberr API key
- [ ] Create iOS Shortcut for "Send to Scriberr"
- [ ] Test audio upload from phone
- [ ] Verify Scriberr transcription works

### Phase 2: Sync (Week 2)
- [ ] Create Notion database structure
- [ ] Create Notion integration & get API key
- [ ] Deploy Notion Sync Worker
- [ ] Test end-to-end: record → upload → transcribe → Notion page
- [ ] Verify transcript appears in Notion

### Phase 3: Video Support (Week 3)
- [ ] Test Scriberr with MP4 video input
- [ ] Set up desktop upload workflow (script or manual)
- [ ] Verify video transcripts sync to Notion

### Phase 4: Polish & Monitoring (Week 4)
- [ ] Add monitoring/logging
- [ ] Document operational procedures
- [ ] Test failure scenarios (network, API errors)
- [ ] Set up automated backups of Scriberr data

### Phase 5: Extensions (Later)
- [ ] Integrate Ollama for summarization
- [ ] Add multi-language support
- [ ] Batch video ingestion from SD card
- [ ] Speaker diarization labels in Notion

---

## 11. Cost Analysis

**One-time costs:**
- Mac Mini (if needed): $600–$800
- External SSD (storage): $150–$200

**Recurring costs:**
- Electricity: ~$30–$50/month (depending on location & hardware)
- Notion (optional paid plan): $8–$10/month

**Comparison to Voice Notes cloud service:**
- Voice Notes: ~$15–$25/month per user for 100+ hours/month
- **Self-hosted payback:** 2–3 months of savings

---

## 12. References & Documentation

### Official Docs
- **Scriberr:** https://github.com/rishikanthc/Scriberr
- **Notion API:** https://developers.notion.com
- **Tailscale:** https://tailscale.com/kb
- **iOS Shortcuts:** https://support.apple.com/guide/shortcuts

### Relevant Code & Repos
- **WhisperX:** https://github.com/m-bain/whisperX
- **faster-whisper:** https://github.com/SYSTRAN/faster-whisper

---

## Appendix A: Example .env File

```bash
# Scriberr Configuration
SCRIBERR_API_KEY=scriberr_sk_1234567890abcdefghijklmnop
SCRIBERR_API_URL=http://scriberr:8080

# Notion Configuration
NOTION_API_KEY=secret_abcdef123456...
NOTION_DATABASE_ID=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

# Worker Configuration
POLL_INTERVAL_SECONDS=30
LOG_LEVEL=info

# Optional: Ollama for LLM summarization
ENABLE_SUMMARIZATION=false
OLLAMA_BASE_URL=http://ollama:11434
SUMMARY_MODEL=mistral
```

---

## Appendix B: Quick Deployment Script

```bash
#!/bin/bash
# deploy.sh - Quick setup script

set -e

echo "🚀 Transcription System Setup"

# 1. Create directory
mkdir -p ~/transcription-system
cd ~/transcription-system

# 2. Download docker-compose.yml (you'll paste this manually)
echo "Creating docker-compose.yml..."
cat > docker-compose.yml << 'EOF'
# (Paste full docker-compose.yml here)
EOF

# 3. Create .env template
echo "Creating .env template..."
cat > .env << 'EOF'
SCRIBERR_API_KEY=generate_random_key_here
NOTION_API_KEY=secret_xxx
NOTION_DATABASE_ID=xxx
POLL_INTERVAL_SECONDS=30
EOF

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your API keys"
echo "2. Run: docker-compose up -d"
echo "3. Access Scriberr at: http://localhost:8080"
echo "4. Generate API key in Scriberr UI"
echo "5. Update .env again"
echo "6. Restart: docker-compose restart"
```

---

**End of PRD Document**

**For questions or clarifications during implementation, refer to sections 3 (Components) and 8 (Troubleshooting).**

