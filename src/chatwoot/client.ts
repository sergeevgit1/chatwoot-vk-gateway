import type { Tenant } from '../tenant/store.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { DownloadedFile } from '../types.js';
import type { ChatwootContact, ChatwootConversation, ChatwootMessage } from './types.js';

/**
 * Thin client over the Chatwoot Application API.
 *
 * Base URL: `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}`.
 * Auth: `api_access_token` header.
 */
export class ChatwootClient {
  private readonly base: string;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.base = `${config.chatwootUrl}/api/v1/accounts/${config.chatwootAccountId}`;
  }

  static forTenant(tenant: Tenant, logger: Logger): ChatwootClient {
    return new ChatwootClient(
      {
        nodeEnv: 'production',
        port: 3000,
        shutdownTimeoutMs: 30_000,
        publicUrl: tenant.chatwootUrl,
        logLevel: 'info',
        maxAttachmentBytes: 50 * 1024 * 1024,
        databaseUrl: '',
        encryptionKey: '',
        adminUsername: '',
        adminPassword: '',
        chatwootUrl: tenant.chatwootUrl,
        chatwootAccountId: tenant.chatwootAccountId,
        chatwootToken: tenant.chatwootToken,
        chatwootInboxId: tenant.chatwootInboxId,
      } as Config,
      logger,
    );
  }

  private async request<T>(path: string, init: RequestInit = {}, expectJson = true): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        api_access_token: this.config.chatwootToken,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Chatwoot ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return (expectJson ? await res.json() : undefined) as T;
  }

  /** Search contacts by free-text query (matches name/identifier/email/phone). */
  async searchContacts(query: string): Promise<ChatwootContact[]> {
    const res = await this.request<{ payload?: ChatwootContact[] }>(
      `/contacts/search?q=${encodeURIComponent(query)}`,
    );
    return res.payload ?? [];
  }

  /** Create a contact bound to the VK inbox via `source_id`. */
  async createContact(params: {
    sourceId: string;
    name: string;
    avatarUrl?: string;
  }): Promise<ChatwootContact> {
    const res = await this.request<{ payload?: { contact?: ChatwootContact } }>('/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inbox_id: this.config.chatwootInboxId,
        source_id: params.sourceId,
        identifier: params.sourceId,
        name: params.name,
        avatar_url: params.avatarUrl,
      }),
    });
    const contact = res.payload?.contact;
    if (!contact) throw new Error('Chatwoot createContact returned no contact');
    return contact;
  }

  /** List a contact's conversations (used to reuse an open one). */
  async listContactConversations(contactId: number): Promise<ChatwootConversation[]> {
    const res = await this.request<{ payload?: ChatwootConversation[] } | ChatwootConversation[]>(
      `/contacts/${contactId}/conversations`,
    );
    return Array.isArray(res) ? res : (res.payload ?? []);
  }

  async createConversation(params: {
    sourceId: string;
    contactId: number;
  }): Promise<ChatwootConversation> {
    return this.request<ChatwootConversation>('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inbox_id: this.config.chatwootInboxId,
        source_id: params.sourceId,
        contact_id: params.contactId,
      }),
    });
  }

  /** Create an incoming text message in a conversation. */
  async createTextMessage(conversationId: number, content: string): Promise<ChatwootMessage> {
    return this.request<ChatwootMessage>(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'incoming' }),
    });
  }

  /** Create an incoming message with one or more file attachments (multipart). */
  async createMessageWithAttachments(
    conversationId: number,
    content: string,
    files: DownloadedFile[],
  ): Promise<ChatwootMessage> {
    const form = new FormData();
    form.append('content', content);
    form.append('message_type', 'incoming');
    for (const file of files) {
      const blob = new Blob([new Uint8Array(file.bytes)], { type: file.mimeType });
      form.append('attachments[]', blob, file.filename);
    }
    return this.request<ChatwootMessage>(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: form,
    });
  }
}
