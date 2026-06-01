// Read_Time_Estimator — Ingestion_Pipeline component (Requirements 6.5, 6.6).
//
// Estimates an Article's reading time as a whole number of minutes with a
// minimum value of 1, computed when an Article lacks an estimated read time
// before it is stored (Requirement 6.6). The estimation is PURE and total: it
// never throws and never performs I/O, so it is cheap to property-test and
// reproducible.
//
// Design reference: Requirement 6.6 ("WHERE an Article lacks an estimated read
// time, THE Read_Time_Estimator SHALL compute a read time expressed as a whole
// number of minutes with a minimum value of 1 before the Article is stored")
// and Property 7 (a stored Article has "a read time that is a whole number of
// minutes >= 1").

/**
 * Default reading speed in words per minute used when no override is supplied.
 * 200 wpm is a conventional average adult silent-reading rate and keeps the
 * estimate conservative (slightly longer) rather than understating effort.
 */
export const DEFAULT_WORDS_PER_MINUTE = 200;

/**
 * The minimum read time, in minutes, that the estimator ever returns. Even
 * empty or whitespace-only content yields at least this value (Requirement 6.6).
 */
export const MIN_READ_TIME_MINUTES = 1;

/** Optional tuning for {@link estimateReadTimeMinutes}. */
export interface ReadTimeOptions {
  /**
   * Reading speed in words per minute. Defaults to
   * {@link DEFAULT_WORDS_PER_MINUTE}. A non-finite or non-positive value is
   * ignored and the default is used instead, so the function stays total.
   */
  wordsPerMinute?: number;
}

/**
 * Estimate the whole-minute reading time for content of `wordCount` words.
 *
 * The read time is `max(1, round(words / wpm))`:
 * - `words` is `wordCount` when it is a finite, positive number, otherwise 0
 *   (so missing, empty, negative, or non-finite counts contribute no time);
 * - `wpm` is {@link ReadTimeOptions.wordsPerMinute} when it is finite and
 *   positive, otherwise {@link DEFAULT_WORDS_PER_MINUTE};
 * - the quotient is rounded to the nearest whole minute and then floored at
 *   {@link MIN_READ_TIME_MINUTES}, so the result is always an integer >= 1
 *   (Requirement 6.6, Property 7).
 *
 * Pure and total: the same inputs always yield the same integer, and no input
 * (including empty content) causes a throw or a value below 1.
 */
export function estimateReadTimeMinutes(
  wordCount: number,
  opts?: ReadTimeOptions,
): number {
  const words = Number.isFinite(wordCount) && wordCount > 0 ? wordCount : 0;

  const requestedWpm = opts?.wordsPerMinute;
  const wpm =
    requestedWpm !== undefined &&
    Number.isFinite(requestedWpm) &&
    requestedWpm > 0
      ? requestedWpm
      : DEFAULT_WORDS_PER_MINUTE;

  const rounded = Math.round(words / wpm);

  return Math.max(MIN_READ_TIME_MINUTES, rounded);
}
