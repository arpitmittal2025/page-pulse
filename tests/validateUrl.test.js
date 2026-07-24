import test from 'node:test';
import assert from 'node:assert/strict';

import { validateUrl, ValidationError } from '../src/validateUrl.js';

test('accepts well-formed http and https URLs', () => {
  assert.equal(validateUrl('https://example.com').href, 'https://example.com/');
  assert.equal(validateUrl('http://example.com/path?q=1').protocol, 'http:');
  assert.equal(validateUrl('  https://example.com/spaced  ').pathname, '/spaced');
});

test('defaults a bare hostname to https', () => {
  const url = validateUrl('example.com');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'example.com');
});

test('rejects empty and non-string input', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => validateUrl(bad), (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, 'URL_REQUIRED');
      return true;
    });
  }
});

test('rejects unsupported protocols', () => {
  for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript://example.com']) {
    assert.throws(() => validateUrl(bad), (error) => {
      assert.equal(error.code, 'URL_PROTOCOL_UNSUPPORTED');
      return true;
    });
  }
});

test('rejects garbage that cannot be parsed as a URL', () => {
  assert.throws(() => validateUrl('http://'), (error) => {
    assert.ok(['URL_INVALID', 'URL_BLOCKED'].includes(error.code));
    return true;
  });
  assert.throws(() => validateUrl('not a url at all'), ValidationError);
});

test('rejects hostnames without a TLD', () => {
  assert.throws(() => validateUrl('https://intranet'), (error) => {
    assert.equal(error.code, 'URL_INVALID');
    return true;
  });
});

test('blocks SSRF targets: loopback, private ranges and cloud metadata', () => {
  const blocked = [
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://10.0.0.5',
    'http://192.168.1.1',
    'http://172.16.4.2',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal',
  ];

  for (const target of blocked) {
    assert.throws(() => validateUrl(target), (error) => {
      assert.equal(error.code, 'URL_BLOCKED', `${target} should be blocked`);
      return true;
    });
  }
});

test('rejects absurdly long URLs', () => {
  const long = `https://example.com/${'a'.repeat(2100)}`;
  assert.throws(() => validateUrl(long), (error) => {
    assert.equal(error.code, 'URL_TOO_LONG');
    return true;
  });
});
