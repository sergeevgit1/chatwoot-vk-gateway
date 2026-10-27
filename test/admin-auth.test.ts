import { describe, expect, it } from 'vitest';
import {
  createAdminSession,
  getCookieValue,
  isValidAdminSession,
  sessionCookie,
} from '../src/tenant/auth.js';

describe('admin session authentication', () => {
  const secret = 'synthetic-session-secret-with-enough-entropy';

  it('creates a session that verifies for the configured user', () => {
    const token = createAdminSession('admin', secret, 60_000, 1_700_000_000_000);
    expect(isValidAdminSession(token, 'admin', secret, 1_700_000_001_000)).toBe(true);
    expect(isValidAdminSession(token, 'other', secret, 1_700_000_001_000)).toBe(false);
  });

  it('rejects tampered, expired, and differently signed sessions', () => {
    const token = createAdminSession('admin', secret, 60_000, 1_700_000_000_000);
    const [payload, signature] = token.split('.');
    expect(
      isValidAdminSession(`${payload}.${signature}x`, 'admin', secret, 1_700_000_001_000),
    ).toBe(false);
    expect(isValidAdminSession(token, 'admin', secret, 1_700_000_061_000)).toBe(false);
    expect(
      isValidAdminSession(token, 'admin', 'another-secret-with-enough-entropy', 1_700_000_001_000),
    ).toBe(false);
  });

  it('reads only the named cookie from a cookie header', () => {
    const token = 'opaque.token';
    expect(getCookieValue(`other=x; ${sessionCookie}=${token}; theme=dark`, sessionCookie)).toBe(
      token,
    );
    expect(getCookieValue(`${sessionCookie}=bad%20value`, sessionCookie)).toBe('bad value');
    expect(getCookieValue('theme=dark', sessionCookie)).toBeUndefined();
  });
});
