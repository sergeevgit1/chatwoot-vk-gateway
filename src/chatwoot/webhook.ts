import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { ChatwootWebhookPayload } from './types.js';

/**
 * Verify a Chatwoot webhook HMAC signature.
 *
 * Chatwoot account and API inbox webhooks sign deliveries when their webhook
 * secret is present. The signature is `sha256=<hex>` where `<hex>` is
 * HMAC-SHA256(`{timestamp}.{raw_body}`, secret), sent in the
 * `X-Chatwoot-Signature` header alongside `X-Chatwoot-Timestamp`.
 *
 * Automation/macro webhook actions in Chatwoot 4.15.1 call the same delivery
 * job without a secret, so they are unsigned. When no gateway secret is
 * configured, the gateway accepts unsigned payloads. See docs/TROUBLESHOOTING.md.
 */
export function verifySignature(
  rawBody: string | Buffer,
  timestamp: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!timestamp || !signatureHeader?.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Decide whether an outbound webhook payload should be relayed to VK.
 *
 * Only agent-authored, non-private, outgoing messages on the configured VK
 * inbox are forwarded. Bot/echo and incoming events are ignored.
 */
export function shouldForwardOutbound(payload: ChatwootWebhookPayload, config: Config): boolean {
  if (payload.event && payload.event !== 'message_created') return false;
  if (payload.message_type !== 'outgoing') return false;
  if (payload.private) return false;
  return extractInboxId(payload) === config.chatwootInboxId;
}

function extractInboxId(payload: ChatwootWebhookPayload): number | undefined {
  return (
    payload.inbox?.id ??
    payload.inbox_id ??
    payload.conversation?.inbox_id ??
    payload.conversation?.inbox?.id
  );
}

/** Extract the VK peer id (= contact `source_id`) from an outbound payload. */
export function extractPeerId(payload: ChatwootWebhookPayload): number | undefined {
  const sourceId =
    payload.conversation?.contact_inbox?.source_id ??
    payload.source_id ??
    payload.conversation?.meta?.sender?.identifier ??
    undefined;
  if (!sourceId) return undefined;
  const source = String(sourceId);
  const scopedPeer = source.startsWith('vk:') ? source.split(':').at(-1) : source;
  const peerId = Number.parseInt(scopedPeer ?? '', 10);
  return Number.isFinite(peerId) ? peerId : undefined;
}
