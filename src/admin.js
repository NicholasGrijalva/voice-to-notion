/**
 * Admin API — lightweight HTTP server for remote state management.
 * Uses Node built-in http module (zero dependencies).
 *
 * Endpoints:
 *   GET  /state              — full state snapshot (synced, failed, counts)
 *   POST /retry/:jobId       — reset a failed job so it retries immediately
 *   POST /retry-all          — reset ALL failed jobs
 *   POST /abandon/:jobId     — move a failed job to synced (skip permanently)
 *   GET  /health             — uptime + pipeline status
 */

const http = require('http');

class AdminServer {
  constructor(syncWorker, { port = 9200 } = {}) {
    this.syncWorker = syncWorker;
    this.port = parseInt(process.env.ADMIN_PORT, 10) || port;
    this.startedAt = new Date();
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(this.port, () => {
      console.log(`[Admin] API listening on http://localhost:${this.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  handle(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/state') return this.getState(res);
      if (req.method === 'GET' && path === '/health') return this.getHealth(res);
      if (req.method === 'POST' && path === '/retry-all') return this.retryAll(res);
      if (req.method === 'POST' && path.startsWith('/retry/')) return this.retryJob(path.split('/')[2], res);
      if (req.method === 'POST' && path.startsWith('/abandon/')) return this.abandonJob(path.split('/')[2], res);

      this.json(res, 404, { error: 'not found' });
    } catch (error) {
      this.json(res, 500, { error: error.message });
    }
  }

  getState(res) {
    const w = this.syncWorker;
    const failed = Object.fromEntries(w.failedJobs);
    const now = Date.now();

    // Annotate with human-readable retry info
    const failedAnnotated = {};
    for (const [id, state] of Object.entries(failed)) {
      const secsUntilRetry = Math.max(0, Math.round((state.nextRetry - now) / 1000));
      failedAnnotated[id] = {
        ...state,
        retriesIn: secsUntilRetry > 0 ? `${secsUntilRetry}s` : 'now',
      };
    }

    this.json(res, 200, {
      synced: Array.from(w.syncedJobs),
      syncedCount: w.syncedJobs.size,
      failed: failedAnnotated,
      failedCount: w.failedJobs.size,
      maxRetries: w.maxRetries,
      isRunning: w.isRunning,
    });
  }

  getHealth(res) {
    const uptimeMs = Date.now() - this.startedAt.getTime();
    const uptimeMins = Math.round(uptimeMs / 60000);

    this.json(res, 200, {
      status: 'ok',
      uptime: `${uptimeMins}m`,
      startedAt: this.startedAt.toISOString(),
      isRunning: this.syncWorker.isRunning,
    });
  }

  retryJob(jobId, res) {
    if (!jobId) return this.json(res, 400, { error: 'missing jobId' });

    const w = this.syncWorker;
    if (!w.failedJobs.has(jobId)) {
      return this.json(res, 404, { error: `job ${jobId} not in failed queue` });
    }

    w.failedJobs.delete(jobId);
    w.saveState();
    console.log(`[Admin] Reset job ${jobId} for retry`);
    this.json(res, 200, { ok: true, action: 'retry', jobId });
  }

  retryAll(res) {
    const w = this.syncWorker;
    const count = w.failedJobs.size;
    w.failedJobs.clear();
    w.saveState();
    console.log(`[Admin] Reset ${count} failed jobs for retry`);
    this.json(res, 200, { ok: true, action: 'retry-all', count });
  }

  abandonJob(jobId, res) {
    if (!jobId) return this.json(res, 400, { error: 'missing jobId' });

    const w = this.syncWorker;
    w.failedJobs.delete(jobId);
    w.syncedJobs.add(jobId);
    w.saveState();
    console.log(`[Admin] Abandoned job ${jobId} (moved to synced)`);
    this.json(res, 200, { ok: true, action: 'abandon', jobId });
  }

  json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }
}

module.exports = AdminServer;
