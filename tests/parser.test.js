import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHtml,
  extractTitle,
  extractMetaDescription,
  countH1,
  countImagesMissingAlt,
  countWords,
} from '../src/parser.js';

const HAPPY_PATH = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>  Coffee   Roasters of Vellore </title>
    <meta name="description" content="Small-batch coffee roasted daily." />
  </head>
  <body>
    <h1>Fresh Roasted Daily</h1>
    <p>We roast arabica beans every morning before the shop opens.</p>
    <img src="/beans.jpg" alt="A scoop of roasted beans" />
    <img src="/divider.png" alt="" />
    <img src="/shop.jpg" />
    <img src="/team.jpg" alt="   " />
    <script>const noise = "this text must not be counted at all";</script>
    <style>body { color: red; }</style>
  </body>
</html>`;

test('happy path: extracts every field from a well-formed page', () => {
  const report = parseHtml(HAPPY_PATH);

  assert.equal(report.title, 'Coffee Roasters of Vellore', 'collapses internal whitespace');
  assert.equal(report.metaDescription, 'Small-batch coffee roasted daily.');
  assert.equal(report.h1Count, 1);
  assert.equal(report.images.total, 4);

  // /shop.jpg has no alt attribute; /team.jpg has a whitespace-only alt.
  // /divider.png uses alt="" which is the valid decorative-image pattern
  // and must NOT be flagged.
  assert.equal(report.images.missingAlt, 2);
  assert.deepEqual(report.images.missingAltSamples, ['/shop.jpg', '/team.jpg']);

  // "Fresh Roasted Daily" (3) + the paragraph (10) = 13. Script/style excluded.
  assert.equal(report.wordCount, 13);
  assert.ok(
    !JSON.stringify(report).includes('noise'),
    'script contents must never leak into the report'
  );
});

test('failure case 1: page missing title, meta description and H1 reports absence, not a crash', () => {
  const html = `
    <html>
      <head></head>
      <body>
        <h2>Subheading only</h2>
        <p>Body copy without any top-level heading.</p>
      </body>
    </html>`;

  const report = parseHtml(html);

  assert.equal(report.title, null, 'absent title is null, never undefined or ""');
  assert.equal(report.metaDescription, null);
  assert.equal(report.h1Count, 0);
  assert.equal(report.images.total, 0);
  assert.equal(report.images.missingAlt, 0);
  assert.ok(report.wordCount > 0);
});

test('failure case 2: malformed / unclosed markup is parsed leniently instead of throwing', () => {
  const broken = `
    <html><head><title>Broken Shop
    <body>
      <h1>Sale
      <h1>Also Sale
      <p>Unclosed paragraph
      <img src="a.png"
      <div><span>nested chaos</div></span>
    `;

  assert.doesNotThrow(() => parseHtml(broken));

  const report = parseHtml(broken);
  // The unclosed <img> tag swallows subsequent siblings — cheerio recovers
  // without throwing, which is the property under test. The exact salvaged
  // count is a parser implementation detail, so we assert it stays sane.
  assert.ok(report.h1Count >= 0, 'returns a count rather than throwing');
  assert.equal(typeof report.wordCount, 'number');
  assert.ok(Number.isFinite(report.wordCount));
});

test('failure case 3: empty string and non-HTML text do not throw', () => {
  const empty = parseHtml('');
  assert.equal(empty.title, null);
  assert.equal(empty.h1Count, 0);
  assert.equal(empty.wordCount, 0);
  assert.equal(empty.images.total, 0);

  const plain = parseHtml('just some bare words, no tags');
  assert.equal(plain.title, null);
  assert.equal(plain.wordCount, 6);
});

test('parseHtml rejects non-string input loudly', () => {
  assert.throws(() => parseHtml(null), TypeError);
  assert.throws(() => parseHtml(42), TypeError);
  assert.throws(() => parseHtml({ html: '<p>hi</p>' }), TypeError);
});

test('title falls back gracefully and whitespace-only titles count as missing', () => {
  const cheerioOf = (html) => parseHtml(html);
  assert.equal(cheerioOf('<title>   </title>').title, null);
  assert.equal(cheerioOf('<title>Real Title</title>').title, 'Real Title');
});

test('meta description tolerates attribute casing and falls back to og:description', () => {
  assert.equal(
    parseHtml('<meta name="Description" content="Cased attribute">').metaDescription,
    'Cased attribute'
  );
  assert.equal(
    parseHtml('<meta property="og:description" content="OG fallback">').metaDescription,
    'OG fallback'
  );
  assert.equal(
    parseHtml('<meta name="description" content="Wins"><meta property="og:description" content="Loses">')
      .metaDescription,
    'Wins',
    'the standard tag takes precedence over the OG fallback'
  );
});

test('word count approximates visible text only', () => {
  const html = `
    <body>
      <p>one two three</p>
      <script>alpha beta gamma delta epsilon</script>
      <noscript>hidden words here</noscript>
      <style>.x { content: "zeta"; }</style>
      <span>four</span>
    </body>`;
  assert.equal(parseHtml(html).wordCount, 4);
});

test('granular helpers stay exported so refactors cannot silently drop them', () => {
  for (const fn of [extractTitle, extractMetaDescription, countH1, countImagesMissingAlt, countWords]) {
    assert.equal(typeof fn, 'function');
  }
});
