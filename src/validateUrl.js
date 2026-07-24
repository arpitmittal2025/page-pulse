/**
 * URL validation for a public "fetch anything" endpoint.
 *
 * This service takes an arbitrary URL from an anonymous caller and issues a
 * server-side request to it. Without guards that is a textbook SSRF: a caller
 * could ask us to fetch http://169.254.169.254/ (cloud metadata) or
 * http://localhost:5432 and use our response as an oracle. So we allow only
 * http/https and block obvious private/loopback/link-local targets.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
]);

/** Private / reserved IPv4 and IPv6 ranges we refuse to fetch. */
const BLOCKED_IP_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./, // link-local, incl. cloud metadata
  /^0\./, // "this" network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^::1$/, // IPv6 loopback
  /^f[cd][0-9a-f]{2}:/i, // IPv6 unique-local
  /^fe80:/i, // IPv6 link-local
];

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

/**
 * Validates and normalises a user-supplied URL.
 *
 * Accepts bare hosts ("example.com") by defaulting to https, because typing
 * the scheme is friction users reliably forget.
 *
 * @param {unknown} raw
 * @returns {URL} a parsed, allow-listed URL
 * @throws {ValidationError}
 */
export function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ValidationError('URL_REQUIRED', 'A "url" string is required.');
  }

  const trimmed = raw.trim();
  if (trimmed.length > 2048) {
    throw new ValidationError('URL_TOO_LONG', 'URL exceeds 2048 characters.');
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ValidationError('URL_INVALID', `"${trimmed}" is not a valid URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ValidationError(
      'URL_PROTOCOL_UNSUPPORTED',
      `Protocol "${parsed.protocol}" is not supported. Use http or https.`
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new ValidationError('URL_BLOCKED', 'Refusing to fetch internal hosts.');
  }

  if (BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new ValidationError('URL_BLOCKED', 'Refusing to fetch private network addresses.');
  }

  if (!host.includes('.') && !host.includes(':')) {
    throw new ValidationError('URL_INVALID', 'Hostname must include a top-level domain.');
  }

  return parsed;
}
