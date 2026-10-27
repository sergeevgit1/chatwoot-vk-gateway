import type { VK } from 'vk-io';
import type { ChatwootClient } from '../chatwoot/client.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { DownloadedFile } from '../types.js';
import type { VkUpdate } from '../vk/types.js';
import { normalizeVkMessage } from '../vk/attachments.in.js';
import { downloadFile } from '../util/download.js';
import { resolveContactId, resolveConversationId } from './mapping.js';
import type { DedupStore } from './dedup.js';

export interface InboundDeps {
  vk: VK;
  chatwoot: ChatwootClient;
  config: Config;
  logger: Logger;
  dedup: DedupStore;
}

/**
 * Inbound pipeline: VK update -> Chatwoot incoming message.
 *
 * 1. Drop non-message and duplicate updates.
 * 2. Resolve/create contact and conversation.
 * 3. Download relayable attachments; build content.
 * 4. Create an incoming message (multipart when there are files).
 */
export async function processVkUpdate(deps: InboundDeps, update: VkUpdate): Promise<void> {
  if (update.type !== 'message_new') return;
  const message = update.object.message;
  if (!message) return;

  const groupScope =
    deps.config.multiGroup && deps.config.vkGroupId ? `${deps.config.vkGroupId}:` : '';
  const dedupKey = `vk:${groupScope}${update.event_id ?? `${message.peer_id}:${message.id}`}`;
  if (await deps.dedup.seen(dedupKey)) {
    deps.logger.debug({ dedupKey }, 'duplicate VK update ignored');
    return;
  }

  const incoming = normalizeVkMessage(message);
  const contactId = await resolveContactId(
    deps.chatwoot,
    deps.vk,
    incoming.vkUserId,
    deps.logger,
    deps.config,
  );
  const conversationId = await resolveConversationId(
    deps.chatwoot,
    contactId,
    incoming.vkUserId,
    deps.config,
  );

  const files: DownloadedFile[] = [];
  const textParts: string[] = incoming.text ? [incoming.text] : [];

  for (const att of incoming.attachments) {
    const downloadable = att.kind === 'image' || att.kind === 'file' || att.kind === 'audio';
    if (downloadable && att.url) {
      try {
        files.push(await downloadFile(att.url, deps.config.maxAttachmentBytes, att.title));
        continue;
      } catch {
        deps.logger.error('failed to download VK attachment');
        textParts.push(att.url);
        continue;
      }
    }
    if (att.text) textParts.push(att.text);
  }

  const content = textParts.join('\n');
  if (files.length > 0) {
    await deps.chatwoot.createMessageWithAttachments(conversationId, content, files);
  } else {
    await deps.chatwoot.createTextMessage(conversationId, content);
  }
  deps.logger.info(
    { conversationId, vkUserId: incoming.vkUserId, files: files.length },
    'relayed VK -> Chatwoot',
  );
}
