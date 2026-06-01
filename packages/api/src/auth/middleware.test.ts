import { describe, it, expect, beforeEach } from 'vitest';
import { ERROR_CODES } from '@lumina/shared';
import { TEST_DEFAULT_ACCESS_TOKEN_SECRET } from './config.js';
import { issueAccessToken, type AccessTokenDenylist } from './tokens.js';
import { makeAccessTokenGuard } from './middleware.js';

const SECRET = TEST_DEFAULT_ACCESS_TOKEN_SECRET;
const FIXED_NOW = 1_700_000_000_000;
const clock = () => FIXED_NOW;

class FakeDenylist implements AccessTokenDenylist {
  readonly denied = new Set<string>();
  async denyAccessToken(jti: string): Promise<void> {
    this.denied.add(jti);
  }
  async isAccessTokenDenied(jti: string): Promise<boolean> {
    return this.denied.has(jti);
  }
}

/** A minimal Fastify reply double capturing the status and JSON body. */
function fakeReply() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    async send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

/** A minimal Fastify request double carrying just headers + auth slot. */
function fakeRequest(authorization?: string) {
  return {
    headers: authorization ? { authorization } : ({} as Record<string, string>),
    auth: undefined as unknown,
  };
}

describe('makeAccessTokenGuard', () => {
  let denylist: FakeDenylist;
  beforeEach(() => {
    denylist = new FakeDenylist();
  });

  it('attaches verified claims and does not respond on a valid token', async () => {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    const guard = makeAccessTokenGuard({ denylist, secret: SECRET, now: clock });
    const req = fakeRequest(`Bearer ${issued.token}`);
    const reply = fakeReply();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guard(req as any, reply as any);

    expect(reply.statusCode).toBe(0); // guard did not short-circuit
    expect(req.auth).toMatchObject({ userId: 'u-1', jti: issued.jti });
  });

  it('responds 401 with the generic envelope when the header is missing', async () => {
    const guard = makeAccessTokenGuard({ denylist, secret: SECRET, now: clock });
    const req = fakeRequest();
    const reply = fakeReply();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guard(req as any, reply as any);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({
      error: { code: ERROR_CODES.AUTH_FAILED, message: 'Authentication required.' },
    });
    expect(req.auth).toBeUndefined();
  });

  it('responds 401 for a denylisted token', async () => {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    await denylist.denyAccessToken(issued.jti);
    const guard = makeAccessTokenGuard({ denylist, secret: SECRET, now: clock });
    const req = fakeRequest(`Bearer ${issued.token}`);
    const reply = fakeReply();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guard(req as any, reply as any);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: { code: string } }).error.code).toBe(
      ERROR_CODES.AUTH_FAILED,
    );
  });

  it('responds 401 for a malformed token', async () => {
    const guard = makeAccessTokenGuard({ denylist, secret: SECRET, now: clock });
    const req = fakeRequest('Bearer garbage');
    const reply = fakeReply();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guard(req as any, reply as any);

    expect(reply.statusCode).toBe(401);
  });
});
