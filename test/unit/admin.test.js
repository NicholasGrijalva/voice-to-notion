const http = require('http');
const AdminServer = require('../../src/admin');

describe('AdminServer', () => {
  let admin;
  let mockWorker;
  let baseUrl;

  beforeEach(async () => {
    mockWorker = {
      syncedJobs: new Set(['synced-1', 'synced-2']),
      failedJobs: new Map([
        ['failed-1', { count: 3, nextRetry: Date.now() + 60000 }],
        ['failed-2', { count: 1, nextRetry: 0 }],
      ]),
      maxRetries: 10,
      isRunning: true,
      saveState: vi.fn(),
    };

    // Use port 0 to get a random available port
    admin = new AdminServer(mockWorker, { port: 0 });
    await new Promise((resolve) => {
      admin.server = http.createServer((req, res) => admin.handle(req, res));
      admin.server.listen(0, () => {
        const addr = admin.server.address();
        admin.port = addr.port;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    admin.stop();
  });

  async function fetch(path, method = 'GET') {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, { method }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  describe('GET /health', () => {
    it('should return ok status and uptime', async () => {
      const { status, body } = await fetch('/health');

      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.uptime).toBeDefined();
      expect(body.isRunning).toBe(true);
    });
  });

  describe('GET /state', () => {
    it('should return synced and failed job counts', async () => {
      const { status, body } = await fetch('/state');

      expect(status).toBe(200);
      expect(body.syncedCount).toBe(2);
      expect(body.failedCount).toBe(2);
      expect(body.synced).toContain('synced-1');
    });

    it('should annotate failed jobs with retriesIn', async () => {
      const { body } = await fetch('/state');

      expect(body.failed['failed-1'].retriesIn).toMatch(/\d+s/);
      expect(body.failed['failed-2'].retriesIn).toBe('now');
    });
  });

  describe('POST /retry/:jobId', () => {
    it('should remove job from failedJobs and save state', async () => {
      const { status, body } = await fetch('/retry/failed-1', 'POST');

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockWorker.failedJobs.has('failed-1')).toBe(false);
      expect(mockWorker.saveState).toHaveBeenCalled();
    });

    it('should return 404 for unknown job', async () => {
      const { status } = await fetch('/retry/nonexistent', 'POST');
      expect(status).toBe(404);
    });
  });

  describe('POST /retry-all', () => {
    it('should clear all failed jobs and save state', async () => {
      const { status, body } = await fetch('/retry-all', 'POST');

      expect(status).toBe(200);
      expect(body.count).toBe(2);
      expect(mockWorker.failedJobs.size).toBe(0);
      expect(mockWorker.saveState).toHaveBeenCalled();
    });
  });

  describe('POST /abandon/:jobId', () => {
    it('should move job from failed to synced', async () => {
      const { status, body } = await fetch('/abandon/failed-1', 'POST');

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockWorker.failedJobs.has('failed-1')).toBe(false);
      expect(mockWorker.syncedJobs.has('failed-1')).toBe(true);
      expect(mockWorker.saveState).toHaveBeenCalled();
    });
  });

  describe('unknown routes', () => {
    it('should return 404', async () => {
      const { status } = await fetch('/nonexistent');
      expect(status).toBe(404);
    });
  });
});
