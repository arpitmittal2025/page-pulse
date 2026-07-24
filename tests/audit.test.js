import test from 'node:test';
import assert from 'node:assert/strict';

import { auditUrl, AuditError } from '../src/audit.js';

/**
 * Builds a fake fetch. Because auditUrl takes fetchImpl by injection, every
 * network branch is testable deterministically — no live sites, no flakiness.
 */
function fakeFetch({ body = '', status = 200, contentType = 'text/html; charset=utf-8', url = 'https://example.com/', error = null } = {}) {
  return async () => {
    if (error) throw error;
    return new Response(body, {
      status,
      headers: contentType ? { 'content-type': contentType } : {},
    });
  };
}

// Response.url is read-only, so wrap to control the final (post-redirect) URL.
function fakeFetchWithUrl(options, finalUrl) {
  const base = fakeFetch(options);
  return async (...args) => {
    const response = await base(...args);
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  };
}

const PAGE = `
  <html><head><title>Test Page</title>
  <meta name="description" content="A description.">
  </head><body><h1>Heading</h1><p>five little words right here</p>
  <img src="a.png"><img src="b.png" alt="ok"></body></html>`;

test('happy path: returns a complete report for an HTML page', async () => {
  const report = await auditUrl('https://example.com', { fetchImpl: fakeFetch({ body: PAGE }) });

  assert.equal(report.ok, true);
  assert.equal(report.httpStatus, 200);
  assert.equal(report.title, 'Test Page');
  assert.equal(report.metaDescription, 'A description.');
  assert.equal(report.h1Count, 1);
  assert.equal(report.images.total, 2);
  assert.equal(report.images.missingAlt, 1);
  assert.equal(report.wordCount, 5);
  assert.equal(typeof report.responseTimeMs, 'number');
  assert.ok(report.responseTimeMs >= 0);
  assert.ok(Date.parse(report.checkedAt));
});

test('failure case: non-HTML response yields NOT_HTML with 415 and partial context', async () => {
  const fetchImpl = fakeFetch({ body: '%PDF-1.7', contentType: 'application/pdf' });

  await assert.rejects(
    () => auditUrl('https://example.com/report.pdf', { fetchImpl }),
    (error) => {
      assert.ok(error instanceof AuditError);
      assert.equal(error.code, 'NOT_HTML');
      assert.equal(error.status, 415);
      assert.equal(error.details.httpStatus, 200);
      assert.equal(error.details.contentType, 'application/pdf');
      assert.ok(error.message.includes('application/pdf'));
      return true;
    }
  );
});

test('failure case: a timeout surfaces as TIMEOUT / 504, never an unhandled abort', async () => {
  const fetchImpl = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  await assert.rejects(
    () => auditUrl('https://slow.example.com', { fetchImpl, timeoutMs: 40 }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.status, 504);
      return true;
    }
  );
});

test('failure case: DNS failure is classified rather than leaking a Node error code', async () => {
  const dnsError = new Error('fetch failed');
  dnsError.cause = { code: 'ENOTFOUND' };

  await assert.rejects(
    () => auditUrl('https://nope.invalid', { fetchImpl: fakeFetch({ error: dnsError }) }),
    (error) => {
      assert.equal(error.code, 'DNS_FAILURE');
      assert.equal(error.status, 502);
      return true;
    }
  );
});

test('connection refused and TLS errors get distinct codes', async () => {
  const refused = new Error('fetch failed');
  refused.cause = { code: 'ECONNREFUSED' };
  await assert.rejects(
    () => auditUrl('https://example.com', { fetchImpl: fakeFetch({ error: refused }) }),
    (error) => error.code === 'CONNECTION_REFUSED'
  );

  const tls = new Error('fetch failed');
  tls.cause = { code: 'CERT_HAS_EXPIRED' };
  await assert.rejects(
    () => auditUrl('https://example.com', { fetchImpl: fakeFetch({ error: tls }) }),
    (error) => error.code === 'TLS_ERROR'
  );
});

test('invalid URLs are rejected before any network call is attempted', async () => {
  let called = false;
  const spy = async () => { called = true; return new Response(''); };

  await assert.rejects(() => auditUrl('ftp://example.com', { fetchImpl: spy }));
  await assert.rejects(() => auditUrl('http://127.0.0.1', { fetchImpl: spy }));
  await assert.rejects(() => auditUrl('', { fetchImpl: spy }));

  assert.equal(called, false, 'validation must short-circuit the fetch');
});

test('a 404 page is still audited: HTTP errors are data, not exceptions', async () => {
  const report = await auditUrl('https://example.com/missing', {
    fetchImpl: fakeFetch({ body: '<html><h1>Not found</h1></html>', status: 404 }),
  });

  assert.equal(report.httpStatus, 404);
  assert.equal(report.ok, false);
  assert.equal(report.h1Count, 1);
});

test('redirects are reported with both requested and final URLs', async () => {
  const report = await auditUrl('https://example.com', {
    fetchImpl: fakeFetchWithUrl({ body: PAGE }, 'https://www.example.com/home'),
  });

  assert.equal(report.requestedUrl, 'https://example.com/');
  assert.equal(report.url, 'https://www.example.com/home');
  assert.equal(report.redirected, true);
});

test('a missing content-type header is treated as non-HTML rather than guessed', async () => {
  await assert.rejects(
    () => auditUrl('https://example.com', { fetchImpl: fakeFetch({ body: PAGE, contentType: null }) }),
    (error) => error.code === 'NOT_HTML'
  );
});
