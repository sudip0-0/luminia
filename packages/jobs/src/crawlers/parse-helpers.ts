// Small, dependency-free parsing helpers shared by the source crawlers.
//
// The six Sources expose two payload families: JSON APIs (Wikipedia, Hacker
// News) and RSS/Atom XML feeds (Medium, arXiv, MIT News, Quanta). These helpers
// keep the per-source `parse*` functions pure and total — they never throw on
// malformed input, returning empty extractions instead — so that source parsing
// can be unit-tested against representative payloads with no network.

/** Decode the small set of XML entities that appear in feed text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    // Ampersand last so earlier replacements are not double-decoded.
    .replace(/&amp;/g, '&');
}

/** Strip a surrounding `<![CDATA[ … ]]>` wrapper when present, trimming the result. */
export function stripCdata(text: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text);
  return (match ? match[1]! : text).trim();
}

/** Remove HTML tags from a fragment, then decode entities and collapse whitespace. */
export function stripHtml(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return the inner content of every `<tag>…</tag>` block in `xml`. The tag name
 * is matched literally (escaped for regex), and the match is case-sensitive to
 * mirror the feeds' element names. Self-closing tags yield no block.
 */
export function extractBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'g');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    blocks.push(match[1]!);
  }
  return blocks;
}

/**
 * Return the trimmed, CDATA-unwrapped, entity-decoded inner text of the first
 * `<tag>…</tag>` in `fragment`, or `''` when the tag is absent.
 */
export function extractTagText(fragment: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`);
  const match = re.exec(fragment);
  if (!match) return '';
  return decodeEntities(stripCdata(match[1]!));
}

/**
 * Return the value of attribute `attr` on the first `<tag …>` in `fragment`, or
 * `''` when the tag or attribute is absent. Handles both single and double
 * quotes. Useful for Atom `<link href="…"/>` elements.
 */
export function extractAttr(fragment: string, tag: string, attr: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRe = new RegExp(`<${escapedTag}\\b[^>]*>`);
  const tagMatch = tagRe.exec(fragment);
  if (!tagMatch) return '';
  const attrRe = new RegExp(`${escapedAttr}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const attrMatch = attrRe.exec(tagMatch[0]);
  if (!attrMatch) return '';
  return decodeEntities(attrMatch[2] ?? attrMatch[3] ?? '');
}

/**
 * Normalize a publication timestamp to an ISO-8601 string. Accepts ISO-8601,
 * RFC-822 (RSS `pubDate`), and epoch-seconds/-milliseconds numbers. Returns
 * `null` when the value cannot be interpreted as a date, so callers can skip
 * undatable items rather than emit an item that can never fall in a window.
 */
export function toIso(value: string | number): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Heuristic: 10-digit values are epoch seconds, larger are milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Safely parse JSON text, returning `null` instead of throwing on malformed input. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Narrowing guard for a non-null, non-array plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string field from a record, returning `''` when absent or non-string. */
export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
