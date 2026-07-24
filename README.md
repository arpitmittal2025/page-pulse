# Page Pulse

A small web tool that audits any public URL and returns a JSON health report: HTTP status, response time, page title, meta description, H1 count, images missing alt text, and approximate word count.

**Live:** `https://<your-deployment>.onrender.com`
**Repo:** `https://github.com/<you>/page-pulse`

---

## Setup

Requires Node 18+ (uses the built-in `fetch` and `node:test`).

```bash
git clone https://github.com/<you>/page-pulse.git
cd page-pulse
npm install
npm start          # http://localhost:3000
```

```bash
npm test           # runs the full suite
```

No environment variables are required. `PORT` is read if set (deployment platforms set it automatically).

---

## API contract

Every response — success or failure — uses the same envelope, so a client only ever branches on `ok`.

```jsonc
{ "ok": true,  "data":  { /* report */ } }
{ "ok": false, "error": { "code": "...", "message": "...", "details": { } } }
```

### `POST /api/audit`

```bash
curl -X POST https://<host>/api/audit \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

### `GET /api/audit?url=...`

```bash
curl 'https://<host>/api/audit?url=example.com'
```

Both accept a bare host (`example.com`) and default it to `https://`.

#### Success — `200`

```json
{
  "ok": true,
  "data": {
    "url": "https://example.com/",
    "requestedUrl": "https://example.com/",
    "redirected": false,
    "httpStatus": 200,
    "httpStatusText": "OK",
    "ok": true,
    "responseTimeMs": 214,
    "contentType": "text/html; charset=UTF-8",
    "bytes": 1256,
    "truncated": false,
    "title": "Example Domain",
    "metaDescription": null,
    "h1Count": 1,
    "images": { "total": 0, "missingAlt": 0, "missingAltSamples": [] },
    "wordCount": 28,
    "checkedAt": "2026-07-24T11:00:00.000Z"
  }
}
```

#### Errors

| HTTP | `code` | When |
|------|--------|------|
| 400 | `URL_REQUIRED` | `url` missing or blank |
| 400 | `URL_INVALID` | Unparseable, or hostname has no TLD |
| 400 | `URL_TOO_LONG` | Over 2048 characters |
| 400 | `URL_PROTOCOL_UNSUPPORTED` | Not `http`/`https` (e.g. `file:`, `ftp:`) |
| 400 | `URL_BLOCKED` | Loopback, private range, or cloud metadata host |
| 400 | `BAD_JSON` | Body was not valid JSON |
| 415 | `NOT_HTML` | Server returned a PDF, image, JSON, etc. |
| 429 | `RATE_LIMITED` | More than 20 requests/minute per IP |
| 502 | `DNS_FAILURE` / `CONNECTION_REFUSED` / `CONNECTION_RESET` / `TLS_ERROR` / `FETCH_FAILED` | Upstream network problem |
| 504 | `TIMEOUT` | No response within 10s |
| 404 | `NOT_FOUND` | Unknown route |
| 500 | `INTERNAL_ERROR` | Unexpected — should never fire |

Note that a **404 or 500 from the audited page is a success**, not an error: you get a normal report with `httpStatus: 404`. Only failures to *obtain and parse* a page produce the error envelope.

### `GET /api/health`

```json
{ "ok": true, "service": "page-pulse", "uptimeSeconds": 421 }
```

---

## Design decisions

### 1. Parsing logic is pure and separated from I/O

`src/parser.js` takes an HTML **string** and returns an object. It never touches the network, the clock, or the filesystem. Fetching lives in `src/audit.js`; validation lives in `src/validateUrl.js`.

*Reasoning:* the parsing rules are where the actual bugs live — whitespace-only titles, `alt=""` vs missing `alt`, script text polluting word counts. Keeping that layer pure means those cases are tested against string literals in microseconds, with no fixture server, no network flakiness, and no mocking framework. The one dependency that *does* need faking (`fetch`) is passed into `auditUrl` as an option, so every network failure branch — timeout, DNS, TLS, refused — is exercised deterministically. The test suite runs offline.

### 2. HTTP status from the audited page is data; only fetch failures are errors

A 404 page still has a title, headings, and images worth auditing, so it returns `200` with a full report. The error envelope is reserved for cases where there is genuinely no report to give.

*Reasoning:* this is the distinction between "your request failed" and "the thing you asked about is in a bad state." Collapsing the two would force clients into awkward logic — a user auditing a broken page wants the audit, not an exception. Correspondingly, non-HTML gets `415 NOT_HTML` but still returns the status, timing, and content type it *did* learn, in `error.details`, so the frontend can show something useful rather than a dead end.

### 3. The URL is validated and allow-listed before any request leaves the server

`validateUrl` permits only `http`/`https` and blocks loopback, RFC1918, CGNAT, and link-local addresses — including `169.254.169.254`.

*Reasoning:* an endpoint that fetches an arbitrary attacker-supplied URL is server-side request forgery by default. Deployed on a cloud host, `http://169.254.169.254/latest/meta-data/` can return instance credentials, and `http://localhost:5432` turns the tool into a port scanner for the internal network. Blocking these costs a few regexes and loses no legitimate use case, since the tool's whole purpose is auditing *public* pages. Validation deliberately runs before the fetch, and a test asserts the fetch is never called for a rejected URL.

**Known limitation, stated honestly:** this is hostname-level blocking. A domain with a DNS record pointing at `127.0.0.1` would slip past, because the check happens before resolution. Closing that properly means resolving DNS first and validating the resolved IP with a custom agent that re-checks on redirect. That is the first thing I would fix with more time.

---

## Other decisions worth noting

- **5 MB read cap.** The response body is streamed and cut off past 5 MB, with `truncated: true` in the report. A server streaming endlessly cannot exhaust memory.
- **In-memory rate limit (20/min/IP).** Correct for the single free-tier instance this runs on; it would need Redis behind more than one instance.
- **`alt=""` is not flagged.** It is the spec-sanctioned marker for a decorative image. Counting it would produce false positives on well-built sites, so only a missing or whitespace-only `alt` counts.
- **Absent fields are `null`, never `""` or `undefined`.** Clients get one thing to check.

---

## Project structure

```
src/
  parser.js       pure HTML → report fields  (no I/O)
  validateUrl.js  URL parsing + SSRF allow-list
  audit.js        fetch, timeout, content-type gate, orchestration
  server.js       Express routes, rate limit, error funnel
public/
  index.html      frontend (no build step)
tests/
  parser.test.js
  validateUrl.test.js
  audit.test.js
```

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com)
