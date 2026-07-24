import * as cheerio from 'cheerio';

/**
 * Elements whose text is not human-readable page copy.
 * Stripped before word counting so scripts/styles don't inflate the number.
 */
const NON_CONTENT_SELECTORS = 'script, style, noscript, template, svg, iframe';

/**
 * Normalises whitespace and returns a trimmed string, or null if empty.
 * Keeps the report free of "" vs "   " ambiguity — absent is always null.
 */
function clean(value) {
  if (typeof value !== 'string') return null;
  const normalised = value.replace(/\s+/g, ' ').trim();
  return normalised.length > 0 ? normalised : null;
}

/**
 * Extracts the document title. Falls back to null when missing or blank.
 */
export function extractTitle($) {
  return clean($('head > title').first().text() || $('title').first().text());
}

/**
 * Extracts the meta description, tolerating attribute-case variations
 * (name="description" / name="Description") and the OpenGraph fallback.
 */
export function extractMetaDescription($) {
  const direct = $('meta[name]')
    .filter((_, el) => String($(el).attr('name')).toLowerCase() === 'description')
    .first()
    .attr('content');

  if (clean(direct)) return clean(direct);

  const og = $('meta[property="og:description"]').first().attr('content');
  return clean(og);
}

/**
 * Counts H1 elements. More than one is an SEO smell; zero is worse.
 */
export function countH1($) {
  return $('h1').length;
}

/**
 * Counts <img> tags that lack a usable alt attribute.
 *
 * A missing attribute and an all-whitespace value both count as missing.
 * alt="" is intentionally NOT counted: it is the valid, spec-sanctioned way
 * to mark a decorative image, and flagging it would produce false positives.
 */
export function countImagesMissingAlt($) {
  const images = $('img');
  let missing = 0;
  const offenders = [];

  images.each((_, el) => {
    const alt = $(el).attr('alt');
    const isMissing = alt === undefined || (alt.length > 0 && alt.trim().length === 0);
    if (isMissing) {
      missing += 1;
      if (offenders.length < 10) {
        offenders.push(clean($(el).attr('src')) || '(no src)');
      }
    }
  });

  return { total: images.length, missingAlt: missing, sample: offenders };
}

/**
 * Approximate visible word count. Script/style content is removed first,
 * then whitespace-delimited tokens are counted. "Approximate" is honest:
 * we do not attempt to resolve CSS-hidden nodes.
 */
export function countWords($) {
  const $body = $('body').length ? $('body') : $.root();
  const $clone = cheerio.load($body.html() || '');
  $clone(NON_CONTENT_SELECTORS).remove();

  const text = $clone.root().text().replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  return text.split(' ').filter(Boolean).length;
}

/**
 * Parses an HTML string into the audit payload.
 *
 * Pure: takes a string, returns an object, touches no network or clock.
 * This is what makes the interesting logic testable without fixtures servers.
 *
 * @param {string} html - raw HTML document
 * @returns {object} audit fields
 */
export function parseHtml(html) {
  if (typeof html !== 'string') {
    throw new TypeError('parseHtml expects an HTML string');
  }

  const $ = cheerio.load(html);
  const images = countImagesMissingAlt($);

  return {
    title: extractTitle($),
    metaDescription: extractMetaDescription($),
    h1Count: countH1($),
    images: {
      total: images.total,
      missingAlt: images.missingAlt,
      missingAltSamples: images.sample,
    },
    wordCount: countWords($),
  };
}
