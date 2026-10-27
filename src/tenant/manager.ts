import type { Config } from '../config.js';
import { createVkClient } from '../vk/client.js';
import { startLongPoll } from '../vk/updates.js';
import { ChatwootClient } from '../chatwoot/client.js';
import { processVkUpdate } from '../core/inbound.js';
import { processChatwootWebhook } from '../core/outbound.js';
import type { ChatwootWebhookPayload } from '../chatwoot/types.js';
import type { VkCallbackBody, VkUpdate } from '../vk/types.js';
import type { DedupStore } from '../core/dedup.js';
import type { Logger } from '../logger.js';
import type { Tenant, TenantStore } from './store.js';

export interface MultiGroupDeps {
  baseConfig: Config;
  tenants: TenantStore;
  dedup: DedupStore;
  logger: Logger;
}

function tenantConfig(base: Config, tenant: Tenant): Config {
  return {
    ...base,
    vkMode: tenant.vkMode,
    vkToken: tenant.vkToken,
    vkGroupId: tenant.vkGroupId,
    vkApiVersion: tenant.vkApiVersion,
    vkConfirmation: tenant.vkConfirmation,
    vkCallbackSecret: tenant.vkCallbackSecret,
    chatwootUrl: tenant.chatwootUrl,
    chatwootAccountId: tenant.chatwootAccountId,
    chatwootToken: tenant.chatwootToken,
    chatwootInboxId: tenant.chatwootInboxId,
    chatwootWebhookSecret: tenant.chatwootWebhookSecret,
  };
}

export class MultiGroupManager {
  private readonly abort = new AbortController();
  private readonly polls = new Map<number, Promise<void>>();

  constructor(private readonly deps: MultiGroupDeps) {}

  async startLongPolls(): Promise<void> {
    const tenants = await this.deps.tenants.list();
    for (const tenant of tenants.filter((item) => item.enabled && item.vkMode === 'longpoll')) {
      const config = tenantConfig(this.deps.baseConfig, tenant);
      const vk = createVkClient(config);
      const chatwoot = ChatwootClient.forTenant(tenant, this.deps.logger);
      const onUpdate = (update: VkUpdate): Promise<void> =>
        processVkUpdate(
          { vk, chatwoot, config, logger: this.deps.logger, dedup: this.deps.dedup },
          update,
        );
      this.polls.set(
        tenant.id,
        startLongPoll(vk, tenant.vkGroupId, onUpdate, this.deps.logger, this.abort.signal).catch(
          (err: unknown) => {
            if (!this.abort.signal.aborted)
              this.deps.logger.error({ err, tenantId: tenant.id }, 'tenant long poll terminated');
          },
        ),
      );
    }
  }

  async handleVkCallback(body: VkCallbackBody): Promise<{ status: number; body: string }> {
    const groupId = body.group_id;
    if (!groupId) return { status: 400, body: 'missing group_id' };
    const tenant = await this.deps.tenants.getByGroupId(groupId);
    if (!tenant?.enabled || tenant.vkMode !== 'callback')
      return { status: 404, body: 'unknown group' };
    if (tenant.vkCallbackSecret && body.secret !== tenant.vkCallbackSecret)
      return { status: 403, body: 'forbidden' };
    if (body.type === 'confirmation') return { status: 200, body: tenant.vkConfirmation ?? '' };
    const config = tenantConfig(this.deps.baseConfig, tenant);
    const vk = createVkClient(config);
    const chatwoot = ChatwootClient.forTenant(tenant, this.deps.logger);
    void processVkUpdate(
      { vk, chatwoot, config, logger: this.deps.logger, dedup: this.deps.dedup },
      body,
    ).catch((err: unknown) =>
      this.deps.logger.error({ err, tenantId: tenant.id }, 'VK callback processing failed'),
    );
    return { status: 200, body: 'ok' };
  }

  async verifyChatwootWebhook(
    rawBody: Buffer,
    timestamp: string | undefined,
    signature: string | undefined,
    payload: ChatwootWebhookPayload,
  ): Promise<boolean> {
    const inboxId =
      payload.inbox?.id ??
      payload.inbox_id ??
      payload.conversation?.inbox_id ??
      payload.conversation?.inbox?.id;
    const tenant = inboxId ? await this.deps.tenants.getByInboxId(inboxId) : undefined;
    if (!tenant?.enabled) return false;
    if (!tenant.chatwootWebhookSecret) return true;
    if (!timestamp || !signature) return false;
    const { verifySignature } = await import('../chatwoot/webhook.js');
    return verifySignature(rawBody, timestamp, signature, tenant.chatwootWebhookSecret);
  }

  async handleChatwootWebhook(payload: ChatwootWebhookPayload): Promise<void> {
    const inboxId =
      payload.inbox?.id ??
      payload.inbox_id ??
      payload.conversation?.inbox_id ??
      payload.conversation?.inbox?.id;
    if (!inboxId) return;
    const tenant = await this.deps.tenants.getByInboxId(inboxId);
    if (!tenant?.enabled) return;
    const config = tenantConfig(this.deps.baseConfig, tenant);
    const vk = createVkClient(config);
    await processChatwootWebhook(
      { vk, config, logger: this.deps.logger, dedup: this.deps.dedup },
      payload,
    );
  }

  async close(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.polls.values());
  }
}
