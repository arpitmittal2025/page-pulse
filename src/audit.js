import { parseHtml } from './parser.js';
import { validateUrl, ValidationError } from './validateUrl.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — beyond this we stop reading.
const USER_AGENT =
  'PagePulseBot/1.0 (+https://github.com/; URL auditing tool for Digital Heroes task)';

export class AuditError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Reads a response body with a hard byte ceiling so a hostile or misconfigured
 * server streaming gigabytes cannot exhaust our memory.
 */
async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), truncated: false };

  const chunks = [];
  let received = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BYTES) {
      chunks.push(value.slice(0, value.length - (received - MAX_BYTES)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/**
 * Maps low-level fetch failures onto stable, client-facing error codes.
 * The frontend should never have to string-match on Node internals.
 */
function classifyFetchError(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new AuditError(
      'TIMEOUT',
      `The page did not respond within ${timeoutMs / 1000}s.`,
      504
    );
  }

  const cause = error?.cause?.code || error?.code;

  switch (cause) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new AuditError('DNS_FAILURE', 'That domain could not be resolved.', 502);
    case 'ECONNREFUSED':
      return new AuditError('CONNECTION_REFUSED', 'The server refused the connection.', 502);
    case 'ECONNRESET':
      return new AuditError('CONNECTION_RESET', 'The connection was reset by the server.', 502);
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return new AuditError('TLS_ERROR', 'The site presented an invalid TLS certificate.', 502);
    default:
      return new AuditError(
        'FETCH_FAILED',
        'The page could not be fetched.',
        502,
        cause ? { cause } : undefined
      );
  }
}

/**
 * Audits a single URL end to end.
 *
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>} the report payload
 * @throws {AuditError|ValidationError}
 */
export async function auditUrl(rawUrl, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;

  const url = validateUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  let response;
  try {
    response = await fetchImpl(url.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'en',
      },
    });
  } catch (error) {
    throw classifyFetchError(error, timeoutMs);
  } finally {
    clearTimeout(timer);
  }

  const responseTimeMs = Math.round(performance.now() - startedAt);
  const contentType = response.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);

  // Non-HTML is a legitimate answer, not a crash: we report what we know
  // (status, timing, content type) and explain why the parsed fields are absent.
  if (!isHtml) {
    throw new AuditError(
      'NOT_HTML',
      `Expected an HTML page but the server returned "${contentType || 'an unknown content type'}".`,
      415,
      {
        url: response.url || url.href,
        httpStatus: response.status,
        responseTimeMs,
        contentType: contentType || null,
      }
    );
  }

  let text;
  let truncated = false;
  try {
    ({ text, truncated } = await readCapped(response));
  } catch (error) {
    throw classifyFetchError(error, timeoutMs);
  }

  const parsed = parseHtml(text);

  return {
    url: response.url || url.href,
    requestedUrl: url.href,
    redirected: (response.url || url.href) !== url.href,
    httpStatus: response.status,
    httpStatusText: response.statusText || null,
    ok: response.ok,
    responseTimeMs,
    contentType,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    ...parsed,
    checkedAt: new Date().toISOString(),
  };
}

export { ValidationError };
