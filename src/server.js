import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditUrl, AuditError } from './audit.js';
import { ValidationError } from './validateUrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

/**
 * Minimal in-memory rate limiter. Deliberately not Redis: this runs as a
 * single free-tier instance, and a dependency-free limiter that works is
 * better than a distributed one that is overkill here. Documented as a
 * known limitation rather than hidden.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const hits = new Map();

function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  entry.count += 1;
  if (entry.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Try again in ${retryAfter}s.`,
      },
    });
  }

  return next();
}

// Periodically evict stale buckets so the map cannot grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (now > entry.resetAt) hits.delete(key);
  }
}, WINDOW_MS).unref();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'page-pulse', uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * POST /api/audit  { "url": "https://example.com" }
 * GET  /api/audit?url=https://example.com
 *
 * Both shapes are supported: POST is the primary contract, GET exists so the
 * endpoint is trivially shareable and curl-able without a body.
 */
async function handleAudit(req, res, next) {
  const raw = req.method === 'POST' ? req.body?.url : req.query?.url;

  try {
    const report = await auditUrl(raw);
    res.json({ ok: true, data: report });
  } catch (error) {
    next(error);
  }
}

app.post('/api/audit', rateLimit, handleAudit);
app.get('/api/audit', rateLimit, handleAudit);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}.` },
  });
});

// Single error-shaping funnel: every failure leaves as the same JSON envelope.
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  if (error instanceof ValidationError) {
    return res.status(400).json({
      ok: false,
      error: { code: error.code, message: error.message },
    });
  }

  if (error instanceof AuditError) {
    return res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: { code: 'BAD_JSON', message: 'Request body was not valid JSON.' },
    });
  }

  console.error('Unhandled error:', error);
  return res.status(500).json({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
  });
});

// Never let an unhandled rejection take the process down silently.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`Page Pulse listening on http://localhost:${PORT}`);
});

export default app;
