import { describe, it, expect } from 'vitest';
import {
  BCRYPT_ROUNDS,
  hashPassword,
  verifyPassword,
} from './passwords.js';

// Verifies user-password hashing uses a salted bcrypt digest (distinct from the
// refresh-token SHA-256): equal passwords hash differently, the digest verifies
// the original password, a wrong password fails, and a malformed digest is a
// safe `false` rather than a throw (Requirements 1.1, 1.4).

describe('hashPassword', () => {
  it('produces a self-describing bcrypt digest at the configured cost', async () => {
    const hash = await hashPassword('correct horse battery staple');
    // bcrypt digests start with $2a$/$2b$ followed by the zero-padded cost.
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(hash).toContain(`$${BCRYPT_ROUNDS}$`);
  });

  it('salts each hash so equal passwords produce different digests', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the original password against its digest', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword('s3cret-passphrase', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword('wrong-passphrase', hash)).toBe(false);
  });

  it('returns false for a malformed digest instead of throwing', async () => {
    expect(await verifyPassword('whatever', 'not-a-bcrypt-hash')).toBe(false);
  });
});
