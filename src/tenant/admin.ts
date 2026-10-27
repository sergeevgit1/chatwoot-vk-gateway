import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Tenant, TenantStore } from './store.js';

const unauthorized = (reply: {
  code: (status: number) => { type: (value: string) => { send: (body: string) => void } };
}): void => {
  reply.code(401).type('text/plain').send('Unauthorized');
};

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeTenant(tenant: Tenant): Record<string, unknown> {
  return {
    id: tenant.id,
    name: tenant.name,
    enabled: tenant.enabled,
    vkMode: tenant.vkMode,
    vkGroupId: tenant.vkGroupId,
    vkApiVersion: tenant.vkApiVersion,
    hasVkToken: Boolean(tenant.vkToken),
    hasCallbackSecret: Boolean(tenant.vkCallbackSecret),
    hasConfirmation: Boolean(tenant.vkConfirmation),
    chatwootUrl: tenant.chatwootUrl,
    chatwootAccountId: tenant.chatwootAccountId,
    chatwootInboxId: tenant.chatwootInboxId,
    hasChatwootToken: Boolean(tenant.chatwootToken),
    hasWebhookSecret: Boolean(tenant.chatwootWebhookSecret),
  };
}

export interface AdminDeps {
  config: Config;
  logger: Logger;
  tenants: TenantStore;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin')) return;
    const header = request.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme !== 'Basic' || !encoded) return unauthorized(reply);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = separator >= 0 ? decoded.slice(0, separator) : '';
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    if (
      !sameSecret(username, deps.config.adminUsername) ||
      !sameSecret(password, deps.config.adminPassword)
    ) {
      reply.header('WWW-Authenticate', 'Basic realm="VK Gateway Admin"');
      return unauthorized(reply);
    }
  });

  app.get('/admin', async (_request, reply) => {
    const tenants = await deps.tenants.list();
    return reply.type('text/html').send(renderAdmin(deps.config.publicUrl, tenants));
  });

  app.get('/admin/api/tenants', async () => {
    const tenants = await deps.tenants.list();
    return tenants.map(safeTenant);
  });

  app.post<{ Body: Omit<Tenant, 'id'> }>('/admin/api/tenants', async (request, reply) => {
    const input = request.body;
    if (
      !input ||
      !input.name ||
      !input.vkGroupId ||
      !input.vkToken ||
      !input.chatwootUrl ||
      !input.chatwootToken ||
      !input.chatwootInboxId
    ) {
      return reply.code(400).send({
        error:
          'name, vkGroupId, vkToken, chatwootUrl, chatwootToken and chatwootInboxId are required',
      });
    }
    const tenant = await deps.tenants.upsert(input);
    return reply.code(201).send(safeTenant(tenant));
  });

  app.delete<{ Params: { id: string } }>('/admin/api/tenants/:id', async (request) => {
    await deps.tenants.remove(Number(request.params.id));
    return { status: 'ok' };
  });
}

function renderAdmin(publicUrl: string, tenants: Tenant[]): string {
  const rows = tenants
    .map(
      (tenant) =>
        `<tr><td>${escapeHtml(tenant.name)}</td><td>${tenant.vkGroupId}</td><td>${tenant.chatwootInboxId}</td><td>${tenant.enabled ? 'enabled' : 'disabled'}</td><td><button onclick="removeTenant(${tenant.id})">Delete</button></td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>VK Chatwoot Gateway</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#17202a}form{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;background:#f4f6f8;padding:20px;border-radius:12px}input,select,button{padding:10px;border:1px solid #ccd3da;border-radius:8px}button{cursor:pointer;background:#1957d2;color:white;border:0}table{width:100%;margin-top:24px;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}.wide{grid-column:1/-1}</style></head><body><h1>VK → Chatwoot Gateway</h1><p>Callback URL: <code>${escapeHtml(publicUrl)}/vk/callback</code></p><form id="tenant"><input name="name" placeholder="Company / group name" required><input name="vkGroupId" type="number" placeholder="VK group ID" required><select name="vkMode"><option value="callback">Callback API</option><option value="longpoll">Long Poll</option></select><input name="vkToken" placeholder="VK token" required><input name="vkCallbackSecret" placeholder="VK callback secret"><input name="vkConfirmation" placeholder="VK confirmation"><input name="chatwootUrl" placeholder="https://support.example.com" required><input name="chatwootAccountId" type="number" placeholder="Chatwoot account ID" required><input name="chatwootToken" placeholder="Chatwoot API token" required><input name="chatwootInboxId" type="number" placeholder="Chatwoot API inbox ID" required><input name="chatwootWebhookSecret" placeholder="Chatwoot webhook secret"><input name="vkApiVersion" value="5.199" placeholder="VK API version"><button class="wide">Save group</button></form><table><thead><tr><th>Name</th><th>VK group</th><th>Inbox</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table><script>document.getElementById('tenant').addEventListener('submit',async e=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));for(const k of ['vkGroupId','chatwootAccountId','chatwootInboxId'])o[k]=Number(o[k]);o.enabled=true;const r=await fetch('/admin/api/tenants',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)});if(!r.ok)alert(await r.text());else location.reload()});async function removeTenant(id){if(confirm('Delete group?')){await fetch('/admin/api/tenants/'+id,{method:'DELETE'});location.reload()}}</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
