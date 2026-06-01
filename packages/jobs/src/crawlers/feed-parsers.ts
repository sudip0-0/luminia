// Shared RSS and Atom feed parsers.
//
// Four of the six Sources publish XML feeds: Medium, MIT News, and Quanta use
// RSS 2.0 (`<item>` elements), while arXiv uses Atom (`<entry>` elements).
// These parsers turn a feed body into per-item field bundles; each source's
// crawler maps those bundles into RawContentItem with its own Source tag. Both
// parsers are pure and total — malformed or undatable items are skipped rather
// than throwing.

import type { Source } from '@lumina/shared';
import type { RawContentItem } from './types.js';
import {
  extractAttr,
  extractBlocks,
  extractTagText,
  stripHtml,
  toIso,
} from './parse-helpers.js';

/** Parse an RSS 2.0 feed body into items tagged with `source`. */
export function parseRssFeed(xml: string, source: Source): RawContentItem[] {
  const items: RawContentItem[] = [];
  for (const block of extractBlocks(xml, 'item')) {
    const title = extractTagText(block, 'title');
    const url = extractTagText(block, 'link');
    const publishedAt = toIso(extractTagText(block, 'pubDate'));
    // Prefer the full content element; fall back to the description summary.
    const rawBody = extractTagText(block, 'content:encoded') || extractTagText(block, 'description');
    const body = stripHtml(rawBody);

    // An item must have a URL and a parseable publication time to be useful.
    if (url === '' || publishedAt === null) continue;

    items.push({ url, title, body, publishedAt, source });
  }
  return items;
}

/** Parse an Atom feed body into items tagged with `source`. */
export function parseAtomFeed(xml: string, source: Source): RawContentItem[] {
  const items: RawContentItem[] = [];
  for (const block of extractBlocks(xml, 'entry')) {
    const title = stripHtml(extractTagText(block, 'title'));
    // Atom links carry the URL in the `href` attribute; fall back to `<id>`.
    const url = extractAttr(block, 'link', 'href') || extractTagText(block, 'id');
    const publishedAt = toIso(extractTagText(block, 'published') || extractTagText(block, 'updated'));
    const body = stripHtml(extractTagText(block, 'summary') || extractTagText(block, 'content'));

    if (url === '' || publishedAt === null) continue;

    items.push({ url, title, body, publishedAt, source });
  }
  return items;
}
