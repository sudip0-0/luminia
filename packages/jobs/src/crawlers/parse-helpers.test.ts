import { describe, it, expect } from 'vitest';
import {
  decodeEntities,
  extractAttr,
  extractBlocks,
  extractTagText,
  isRecord,
  readString,
  safeJsonParse,
  stripCdata,
  stripHtml,
  toIso,
} from './parse-helpers.js';

describe('decodeEntities', () => {
  it('decodes the common XML entities, ampersand last', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a & b <c> "d" \'e\'');
  });

  it('does not double-decode an encoded ampersand sequence', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('stripCdata', () => {
  it('unwraps a CDATA section and trims', () => {
    expect(stripCdata('  <![CDATA[ hello ]]>  ')).toBe('hello');
  });

  it('returns trimmed text when there is no CDATA wrapper', () => {
    expect(stripCdata('  plain  ')).toBe('plain');
  });
});

describe('stripHtml', () => {
  it('removes tags, decodes entities, and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   &amp;   <b>world</b></p>')).toBe('Hello & world');
  });
});

describe('extractBlocks / extractTagText / extractAttr', () => {
  const xml = '<item><title>A</title><link>https://x/1</link></item><item><title>B</title></item>';

  it('extracts every matching block', () => {
    expect(extractBlocks(xml, 'item')).toHaveLength(2);
  });

  it('reads the first matching tag text', () => {
    const block = extractBlocks(xml, 'item')[0]!;
    expect(extractTagText(block, 'title')).toBe('A');
    expect(extractTagText(block, 'link')).toBe('https://x/1');
  });

  it('returns empty string for an absent tag', () => {
    expect(extractTagText('<item></item>', 'title')).toBe('');
  });

  it('reads an attribute value from a tag (Atom link href)', () => {
    expect(extractAttr('<link href="https://x/abs" rel="alternate"/>', 'link', 'href')).toBe(
      'https://x/abs',
    );
    expect(extractAttr("<link href='https://y'/>", 'link', 'href')).toBe('https://y');
    expect(extractAttr('<link rel="self"/>', 'link', 'href')).toBe('');
  });
});

describe('toIso', () => {
  it('normalizes ISO-8601 input', () => {
    expect(toIso('2024-06-01T08:00:00Z')).toBe('2024-06-01T08:00:00.000Z');
  });

  it('normalizes RFC-822 (RSS pubDate) input', () => {
    expect(toIso('Sat, 01 Jun 2024 08:00:00 GMT')).toBe('2024-06-01T08:00:00.000Z');
  });

  it('treats a number below 1e12 as epoch seconds and above as milliseconds', () => {
    expect(toIso(1717228800)).toBe('2024-06-01T08:00:00.000Z');
    expect(toIso(1717228800000)).toBe('2024-06-01T08:00:00.000Z');
  });

  it('returns null for unparseable or empty input', () => {
    expect(toIso('not-a-date')).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso(Number.NaN)).toBeNull();
  });
});

describe('safeJsonParse / isRecord / readString', () => {
  it('parses valid JSON and returns null on malformed input', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('nope')).toBeNull();
  });

  it('isRecord narrows to non-array objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('readString returns the string field or empty string', () => {
    expect(readString({ a: 'x' }, 'a')).toBe('x');
    expect(readString({ a: 1 }, 'a')).toBe('');
    expect(readString({}, 'a')).toBe('');
  });
});
