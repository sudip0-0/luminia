import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_SECRET_ENV,
  ALLOW_TEST_SECRET_ENV,
  MIN_ACCESS_TOKEN_SECRET_LENGTH,
  TEST_DEFAULT_ACCESS_TOKEN_SECRET,
  allowsTestAccessTokenSecret,
  getAccessTokenSecret,
} from './config.js';

describe('getAccessTokenSecret', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns a sufficiently long env secret', () => {
    const secret = 'x'.repeat(MIN_ACCESS_TOKEN_SECRET_LENGTH);
    expect(
      getAccessTokenSecret({
        [ACCESS_TOKEN_SECRET_ENV]: secret,
      }),
    ).toBe(secret);
  });

  it('rejects a too-short env secret', () => {
    expect(() =>
      getAccessTokenSecret({
        NODE_ENV: 'production',
        [ACCESS_TOKEN_SECRET_ENV]: 'too-short',
      }),
    ).toThrow(/at least/);
  });

  it('throws when unset outside test without allow flag', () => {
    expect(() =>
      getAccessTokenSecret({
        NODE_ENV: 'production',
      }),
    ).toThrow(new RegExp(ACCESS_TOKEN_SECRET_ENV));
  });

  it('falls back to the test default when NODE_ENV=test', () => {
    expect(getAccessTokenSecret({ NODE_ENV: 'test' })).toBe(
      TEST_DEFAULT_ACCESS_TOKEN_SECRET,
    );
  });

  it('falls back when AUTH_ALLOW_TEST_SECRET is truthy', () => {
    expect(
      getAccessTokenSecret({
        NODE_ENV: 'development',
        [ALLOW_TEST_SECRET_ENV]: '1',
      }),
    ).toBe(TEST_DEFAULT_ACCESS_TOKEN_SECRET);
  });
});

describe('allowsTestAccessTokenSecret', () => {
  it('is true for NODE_ENV=test and allow-flag values', () => {
    expect(allowsTestAccessTokenSecret({ NODE_ENV: 'test' })).toBe(true);
    expect(allowsTestAccessTokenSecret({ [ALLOW_TEST_SECRET_ENV]: 'true' })).toBe(
      true,
    );
    expect(allowsTestAccessTokenSecret({ [ALLOW_TEST_SECRET_ENV]: 'yes' })).toBe(
      true,
    );
    expect(allowsTestAccessTokenSecret({ NODE_ENV: 'production' })).toBe(false);
  });
});
