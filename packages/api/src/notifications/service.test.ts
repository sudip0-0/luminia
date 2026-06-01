import { describe, it, expect, beforeEach } from 'vitest';
import {
  PUSH_COPY,
  NOTIFICATION_WINDOW_MS,
  sendDaily,
  setPreferences,
  type NotificationPreferenceStore,
  type NotificationRateLimitStore,
  type PushSender,
} from './service.js';

// Verifies the Notification_Service hygiene policy (Requirement 18):
//   - default-off / disabled users never receive a push (18.1, 18.4)
//   - at most one push per rolling 24 hours when enabled (18.2)
//   - the fixed copy is delivered and the timestamp recorded on send (18.3)
//   - the preferences toggle persists (PATCH /notifications/preferences)
//
// External concerns are exercised through in-memory fakes of the narrow
// injected interfaces, so no live DB, Redis, or push provider is required.

/** In-memory push-enabled preference store backed by a Map. */
class FakePreferenceStore implements NotificationPreferenceStore {
  readonly enabled = new Map<string, boolean>();
  /** Users known to exist (so a missing entry can mean "default-off" vs "absent"). */
  readonly known = new Set<string>();

  constructor(seed: Record<string, boolean> = {}) {
    for (const [userId, value] of Object.entries(seed)) {
      this.known.add(userId);
      this.enabled.set(userId, value);
    }
  }

  async getPushEnabled(userId: string): Promise<boolean | null> {
    if (!this.known.has(userId)) return null;
    // Absent entry => account-creation default of disabled (Requirement 18.1).
    return this.enabled.get(userId) ?? false;
  }

  async setPushEnabled(userId: string, value: boolean): Promise<boolean | null> {
    if (!this.known.has(userId)) return null;
    this.enabled.set(userId, value);
    return value;
  }
}

/** In-memory rolling-window store recording last-notification timestamps + TTL. */
class FakeRateLimitStore implements NotificationRateLimitStore {
  readonly timestamps = new Map<string, number>();
  readonly ttls = new Map<string, number>();

  async getLastNotificationAt(userId: string): Promise<number | null> {
    return this.timestamps.get(userId) ?? null;
  }

  async setLastNotificationAt(
    userId: string,
    timestampMs: number,
    ttlSeconds?: number,
  ): Promise<void> {
    this.timestamps.set(userId, timestampMs);
    if (ttlSeconds !== undefined) this.ttls.set(userId, ttlSeconds);
  }
}

/** Recording push transport that captures every delivery. */
class FakePushSender implements PushSender {
  readonly sent: Array<{ userId: string; message: string }> = [];
  async send(userId: string, message: string): Promise<void> {
    this.sent.push({ userId, message });
  }
}

const NOW = 1_700_000_000_000;

describe('sendDaily — disabled / default-off', () => {
  let preferences: FakePreferenceStore;
  let rateLimit: FakeRateLimitStore;
  let push: FakePushSender;
  beforeEach(() => {
    preferences = new FakePreferenceStore({ 'u-disabled': false, 'u-enabled': true });
    rateLimit = new FakeRateLimitStore();
    push = new FakePushSender();
  });

  it('never sends when push is disabled (18.1, 18.4)', async () => {
    const result = await sendDaily({ preferences, rateLimit, push }, 'u-disabled', NOW);

    expect(result).toEqual({ status: 'suppressed-disabled' });
    expect(push.sent).toEqual([]);
    expect(rateLimit.timestamps.has('u-disabled')).toBe(false);
  });

  it('never sends to an unknown (default-off) user (18.1)', async () => {
    const result = await sendDaily({ preferences, rateLimit, push }, 'u-absent', NOW);

    expect(result).toEqual({ status: 'suppressed-disabled' });
    expect(push.sent).toEqual([]);
  });
});

describe('sendDaily — enabled delivery and rate limiting', () => {
  let preferences: FakePreferenceStore;
  let rateLimit: FakeRateLimitStore;
  let push: FakePushSender;
  beforeEach(() => {
    preferences = new FakePreferenceStore({ 'u-enabled': true });
    rateLimit = new FakeRateLimitStore();
    push = new FakePushSender();
  });

  it('sends with PUSH_COPY and records the timestamp when there is no prior send (18.2, 18.3)', async () => {
    const result = await sendDaily({ preferences, rateLimit, push }, 'u-enabled', NOW);

    expect(result).toEqual({ status: 'sent', sentAt: NOW });
    expect(push.sent).toEqual([{ userId: 'u-enabled', message: PUSH_COPY }]);
    expect(push.sent[0]?.message).toBe('Your curiosity feed has new picks.');
    expect(rateLimit.timestamps.get('u-enabled')).toBe(NOW);
  });

  it('suppresses a second push within the rolling 24h window (18.2)', async () => {
    await sendDaily({ preferences, rateLimit, push }, 'u-enabled', NOW);
    const within = NOW + NOTIFICATION_WINDOW_MS - 1;

    const result = await sendDaily({ preferences, rateLimit, push }, 'u-enabled', within);

    expect(result).toEqual({
      status: 'suppressed-rate-limited',
      lastSentAt: NOW,
      nextEligibleAt: NOW + NOTIFICATION_WINDOW_MS,
    });
    // Only the first send reached the transport; the timestamp is unchanged.
    expect(push.sent).toHaveLength(1);
    expect(rateLimit.timestamps.get('u-enabled')).toBe(NOW);
  });

  it('sends again once the last send is more than 24h old (18.2)', async () => {
    rateLimit.timestamps.set('u-enabled', NOW - NOTIFICATION_WINDOW_MS - 1);

    const result = await sendDaily({ preferences, rateLimit, push }, 'u-enabled', NOW);

    expect(result).toEqual({ status: 'sent', sentAt: NOW });
    expect(push.sent).toEqual([{ userId: 'u-enabled', message: PUSH_COPY }]);
    expect(rateLimit.timestamps.get('u-enabled')).toBe(NOW);
  });

  it('sends again when the last send is exactly 24h ago (window boundary is exclusive) (18.2)', async () => {
    rateLimit.timestamps.set('u-enabled', NOW - NOTIFICATION_WINDOW_MS);

    const result = await sendDaily({ preferences, rateLimit, push }, 'u-enabled', NOW);

    expect(result.status).toBe('sent');
    expect(push.sent).toHaveLength(1);
  });

  it('does not consume the daily allowance when delivery fails', async () => {
    const failing: PushSender = {
      async send() {
        throw new Error('transport down');
      },
    };

    await expect(
      sendDaily({ preferences, rateLimit, push: failing }, 'u-enabled', NOW),
    ).rejects.toThrow('transport down');
    // No timestamp recorded, so a later retry is still eligible.
    expect(rateLimit.timestamps.has('u-enabled')).toBe(false);
  });
});

describe('setPreferences — toggle persistence', () => {
  it('persists enabling the toggle and reflects it on the next read', async () => {
    const preferences = new FakePreferenceStore({ 'u-1': false });

    const result = await setPreferences({ preferences }, 'u-1', true);

    expect(result).toEqual({ status: 'updated', enabled: true });
    expect(await preferences.getPushEnabled('u-1')).toBe(true);
  });

  it('persists disabling the toggle', async () => {
    const preferences = new FakePreferenceStore({ 'u-1': true });

    const result = await setPreferences({ preferences }, 'u-1', false);

    expect(result).toEqual({ status: 'updated', enabled: false });
    expect(await preferences.getPushEnabled('u-1')).toBe(false);
  });

  it('returns not-found for an unknown user without persisting', async () => {
    const preferences = new FakePreferenceStore();

    const result = await setPreferences({ preferences }, 'u-absent', true);

    expect(result).toEqual({ status: 'not-found' });
    expect(preferences.enabled.has('u-absent')).toBe(false);
  });

  it('end-to-end: enabling via setPreferences then sending delivers a push', async () => {
    const preferences = new FakePreferenceStore({ 'u-1': false });
    const rateLimit = new FakeRateLimitStore();
    const push = new FakePushSender();

    // Disabled by default => suppressed.
    const before = await sendDaily({ preferences, rateLimit, push }, 'u-1', NOW);
    expect(before.status).toBe('suppressed-disabled');

    await setPreferences({ preferences }, 'u-1', true);

    const after = await sendDaily({ preferences, rateLimit, push }, 'u-1', NOW);
    expect(after).toEqual({ status: 'sent', sentAt: NOW });
    expect(push.sent).toEqual([{ userId: 'u-1', message: PUSH_COPY }]);
  });
});
