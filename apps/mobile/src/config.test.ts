import { describe, it, expect } from 'vitest';
import { APP_NAME, DEFAULT_API_BASE_URL } from './config.js';

describe('@lumina/mobile config', () => {
  it('exposes the app name', () => {
    expect(APP_NAME).toBe('Lumina');
  });

  it('exposes a default API base URL', () => {
    expect(DEFAULT_API_BASE_URL).toMatch(/^https?:\/\//);
  });
});
