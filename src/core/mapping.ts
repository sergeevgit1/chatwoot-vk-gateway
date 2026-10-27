import type { VK } from 'vk-io';
import type { Config } from '../config.js';
import type { ChatwootClient } from '../chatwoot/client.js';
import type { Logger } from '../logger.js';
import { getUserProfile } from '../vk/client.js';

/**
 * Resolve (or create) the Chatwoot contact for a VK user.
 * Contact identifiers are scoped by VK group so the same person can talk to
 * two communities without sharing a Chatwoot contact.
 */
export async function resolveContactId(
  chatwoot: ChatwootClient,
  vk: VK,
  vkUserId: number,
  logger: Logger,
  config?: Config,
): Promise<number> {
  const sourceId = scopedSourceId(vkUserId, config);
  const existing = await chatwoot.searchContacts(sourceId);
  const match = existing.find(
    (c) =>
      c.identifier === sourceId ||
      (c.contact_inboxes?.some((ci) => ci.source_id === sourceId) ?? false),
  );
  if (match) return match.id;

  const profile = await getUserProfile(vk, vkUserId);
  const created = await chatwoot.createContact({
    sourceId,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  });
  logger.info({ contactId: created.id, vkUserId }, 'created Chatwoot contact');
  return created.id;
}

/**
 * Resolve (or create) an open conversation for the contact in the VK inbox.
 * Reuses any non-resolved conversation to keep the dialog continuous.
 */
export async function resolveConversationId(
  chatwoot: ChatwootClient,
  contactId: number,
  vkUserId: number,
  config?: Config,
): Promise<number> {
  const conversations = await chatwoot.listContactConversations(contactId);
  const open = conversations.find((c) => c.status !== 'resolved');
  if (open) return open.id;

  const created = await chatwoot.createConversation({
    sourceId: scopedSourceId(vkUserId, config),
    contactId,
  });
  return created.id;
}

export function scopedSourceId(vkUserId: number, config?: Config): string {
  return config?.multiGroup && config.vkGroupId
    ? `vk:${config.vkGroupId}:${vkUserId}`
    : String(vkUserId);
}
