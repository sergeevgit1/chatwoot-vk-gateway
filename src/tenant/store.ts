import { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import { decryptSecret, encryptSecret } from './crypto.js';

export interface Tenant {
  id: number;
  name: string;
  enabled: boolean;
  vkMode: 'longpoll' | 'callback';
  vkGroupId: number;
  vkApiVersion: string;
  vkToken: string;
  vkConfirmation?: string;
  vkCallbackSecret?: string;
  chatwootUrl: string;
  chatwootAccountId: number;
  chatwootToken: string;
  chatwootInboxId: number;
  chatwootWebhookSecret?: string;
}

interface TenantRow {
  id: number;
  name: string;
  enabled: boolean;
  vk_mode: 'longpoll' | 'callback';
  vk_group_id: number;
  vk_api_version: string;
  vk_token: string;
  vk_confirmation: string | null;
  vk_callback_secret: string | null;
  chatwoot_url: string;
  chatwoot_account_id: number;
  chatwoot_token: string;
  chatwoot_inbox_id: number;
  chatwoot_webhook_secret: string | null;
}

export class TenantStore {
  readonly pool: Pool;
  private readonly encryptionKey: string;

  constructor(
    config: Config,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    this.encryptionKey = config.encryptionKey;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vk_tenants (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        vk_mode TEXT NOT NULL DEFAULT 'callback' CHECK (vk_mode IN ('longpoll','callback')),
        vk_group_id BIGINT NOT NULL UNIQUE,
        vk_api_version TEXT NOT NULL DEFAULT '5.199',
        vk_token TEXT NOT NULL,
        vk_confirmation TEXT,
        vk_callback_secret TEXT,
        chatwoot_url TEXT NOT NULL,
        chatwoot_account_id BIGINT NOT NULL,
        chatwoot_token TEXT NOT NULL,
        chatwoot_inbox_id BIGINT NOT NULL UNIQUE,
        chatwoot_webhook_secret TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    this.logger.info('tenant store initialized');
  }

  async list(): Promise<Tenant[]> {
    const result = await this.pool.query<TenantRow>('SELECT * FROM vk_tenants ORDER BY name');
    return result.rows.map((row) => this.map(row));
  }

  async getByGroupId(groupId: number): Promise<Tenant | undefined> {
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM vk_tenants WHERE vk_group_id = $1',
      [groupId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async getByInboxId(inboxId: number): Promise<Tenant | undefined> {
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM vk_tenants WHERE chatwoot_inbox_id = $1',
      [inboxId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async upsert(input: Omit<Tenant, 'id'>): Promise<Tenant> {
    const result = await this.pool.query<TenantRow>(
      `INSERT INTO vk_tenants
       (name, enabled, vk_mode, vk_group_id, vk_api_version, vk_token, vk_confirmation,
        vk_callback_secret, chatwoot_url, chatwoot_account_id, chatwoot_token,
        chatwoot_inbox_id, chatwoot_webhook_secret)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (vk_group_id) DO UPDATE SET
        name=EXCLUDED.name, enabled=EXCLUDED.enabled, vk_mode=EXCLUDED.vk_mode,
        vk_api_version=EXCLUDED.vk_api_version, vk_token=EXCLUDED.vk_token,
        vk_confirmation=EXCLUDED.vk_confirmation, vk_callback_secret=EXCLUDED.vk_callback_secret,
        chatwoot_url=EXCLUDED.chatwoot_url, chatwoot_account_id=EXCLUDED.chatwoot_account_id,
        chatwoot_token=EXCLUDED.chatwoot_token, chatwoot_inbox_id=EXCLUDED.chatwoot_inbox_id,
        chatwoot_webhook_secret=EXCLUDED.chatwoot_webhook_secret, updated_at=now()
       RETURNING *`,
      [
        input.name,
        input.enabled,
        input.vkMode,
        input.vkGroupId,
        input.vkApiVersion,
        encryptSecret(input.vkToken, this.encryptionKey),
        input.vkConfirmation ? encryptSecret(input.vkConfirmation, this.encryptionKey) : null,
        input.vkCallbackSecret ? encryptSecret(input.vkCallbackSecret, this.encryptionKey) : null,
        input.chatwootUrl,
        input.chatwootAccountId,
        encryptSecret(input.chatwootToken, this.encryptionKey),
        input.chatwootInboxId,
        input.chatwootWebhookSecret
          ? encryptSecret(input.chatwootWebhookSecret, this.encryptionKey)
          : null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Tenant upsert returned no row');
    return this.map(row);
  }

  async remove(id: number): Promise<void> {
    await this.pool.query('DELETE FROM vk_tenants WHERE id = $1', [id]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private map(row: TenantRow): Tenant {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      vkMode: row.vk_mode,
      vkGroupId: Number(row.vk_group_id),
      vkApiVersion: row.vk_api_version,
      vkToken: decryptSecret(row.vk_token, this.encryptionKey),
      vkConfirmation: row.vk_confirmation
        ? decryptSecret(row.vk_confirmation, this.encryptionKey)
        : undefined,
      vkCallbackSecret: row.vk_callback_secret
        ? decryptSecret(row.vk_callback_secret, this.encryptionKey)
        : undefined,
      chatwootUrl: row.chatwoot_url,
      chatwootAccountId: Number(row.chatwoot_account_id),
      chatwootToken: decryptSecret(row.chatwoot_token, this.encryptionKey),
      chatwootInboxId: Number(row.chatwoot_inbox_id),
      chatwootWebhookSecret: row.chatwoot_webhook_secret
        ? decryptSecret(row.chatwoot_webhook_secret, this.encryptionKey)
        : undefined,
    };
  }
}
