import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { createDedupStore } from './core/dedup.js';
import { TenantStore } from './tenant/store.js';
import { MultiGroupManager } from './tenant/manager.js';
import { registerAdminRoutes } from './tenant/admin.js';
import { ChatwootClient } from './chatwoot/client.js';
import { createVkClient } from './vk/client.js';
import { startLongPoll, buildCallbackHandler } from './vk/updates.js';
import { processVkUpdate } from './core/inbound.js';

import type { ChatwootWebhookPayload } from './chatwoot/types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const tenants = new TenantStore(config, logger);
  const dedup = await createDedupStore(config, logger);
  const manager = new MultiGroupManager({ baseConfig: config, tenants, dedup, logger });
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>): Promise<void> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const legacyTrack = track;
  if (config.multiGroup) {
    await tenants.initialize();
    await manager.startLongPolls();
  }
  const legacyVk = !config.multiGroup ? createVkClient(config) : undefined;
  const legacyChatwoot = !config.multiGroup ? new ChatwootClient(config, logger) : undefined;
  const legacyUpdate =
    !config.multiGroup && legacyVk && legacyChatwoot
      ? (update: Parameters<typeof processVkUpdate>[1]) =>
          legacyTrack(
            processVkUpdate(
              { vk: legacyVk, chatwoot: legacyChatwoot, config, logger, dedup },
              update,
            ),
          )
      : undefined;
  const onChatwootWebhook = (payload: ChatwootWebhookPayload): Promise<void> => {
    if (config.multiGroup) return track(manager.handleChatwootWebhook(payload));
    return Promise.resolve();
  };

  const app = buildServer({
    config,
    logger,
    onChatwootWebhook,
    onVkCallback:
      !config.multiGroup && legacyUpdate
        ? buildCallbackHandler(config, legacyUpdate, logger)
        : config.multiGroup
          ? (body) => manager.handleVkCallback(body)
          : undefined,
    verifyChatwootWebhook: config.multiGroup
      ? (rawBody, timestamp, signature, payload) =>
          manager.verifyChatwootWebhook(rawBody, timestamp, signature, payload)
      : undefined,
  });
  if (config.multiGroup) registerAdminRoutes(app, { config, logger, tenants });
  if (
    !config.multiGroup &&
    config.vkMode === 'longpoll' &&
    legacyVk &&
    legacyUpdate &&
    config.vkGroupId !== undefined
  ) {
    const abort = new AbortController();
    void startLongPoll(legacyVk, config.vkGroupId, legacyUpdate, logger, abort.signal);
  }
  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info({ port: config.port, publicUrl: config.publicUrl }, 'multi-group gateway listening');

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      logger.error({ pendingTasks: pending.size }, 'shutdown timed out');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    try {
      await Promise.all([app.close(), manager.close()]);
      logger.info({ pendingTasks: pending.size }, 'draining background deliveries');
      await Promise.allSettled(pending);
      await dedup.close();
      if (config.multiGroup) await tenants.close();
      clearTimeout(deadline);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
