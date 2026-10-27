import { createHmac, timingSafeEqual } from 'node:crypto';

export const sessionCookie = 'vk_gateway_session';

interface SessionPayload {
  username: string;
  expiresAt: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createAdminSession(
  username: string,
  secret: string,
  ttlMs: number,
  now = Date.now(),
): string {
  const payload: SessionPayload = { username, expiresAt: now + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function isValidAdminSession(
  token: string | undefined,
  username: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const [encoded, provided] = token.split('.');
  if (!encoded || !provided) return false;
  const expected = sign(encoded, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as SessionPayload;
    return (
      payload.username === username &&
      Number.isSafeInteger(payload.expiresAt) &&
      payload.expiresAt > now
    );
  } catch {
    return false;
  }
}

export function getCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return undefined;
}
