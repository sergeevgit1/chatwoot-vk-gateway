import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createAdminSession, getCookieValue, isValidAdminSession, sessionCookie } from './auth.js';
import type { Tenant, TenantStore } from './store.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const unauthorized = (reply: {
  code: (status: number) => {
    type: (value: string) => { send: (body: string) => void };
  };
}): void => {
  reply.code(401).type('text/plain').send('Unauthorized');
};

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
  app.register(formbody);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin') || request.url === '/admin/login') return;
    if (
      isValidAdminSession(
        getCookieValue(request.headers.cookie, sessionCookie),
        deps.config.adminUsername,
        deps.config.adminSessionSecret,
      )
    )
      return;
    if (request.url === '/admin' || request.url === '/admin/') {
      reply.code(302).header('location', '/admin/login').send();
      return;
    }
    return unauthorized(reply);
  });

  app.get('/admin/login', async (_request, reply) => reply.type('text/html').send(renderLogin()));

  app.post<{ Body: { username?: string; password?: string } }>(
    '/admin/login',
    async (request, reply) => {
      if (
        request.body?.username !== deps.config.adminUsername ||
        request.body?.password !== deps.config.adminPassword
      ) {
        return reply.code(401).type('text/html').send(renderLogin('Неверный логин или пароль'));
      }
      const token = createAdminSession(
        deps.config.adminUsername,
        deps.config.adminSessionSecret,
        SESSION_TTL_MS,
      );
      return reply
        .code(302)
        .header(
          'set-cookie',
          `${sessionCookie}=${token}; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`,
        )
        .header('location', '/admin')
        .send();
    },
  );

  app.post('/admin/logout', async (_request, reply) =>
    reply
      .code(302)
      .header(
        'set-cookie',
        `${sessionCookie}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      )
      .header('location', '/admin/login')
      .send(),
  );

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

function renderLogin(error?: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход — VK Gateway</title><style>:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#17202a;background:#eef1ee}*{box-sizing:border-box}body{margin:0;min-height:100vh}.shell{min-height:100vh;display:grid;grid-template-columns:1fr 480px}.brand{padding:9vw 8vw;background:#193b36;color:#f5f0e6;display:flex;flex-direction:column;justify-content:space-between}.brand h1{font-size:clamp(42px,6vw,88px);line-height:.94;letter-spacing:-.06em;margin:0}.brand p{max-width:380px;color:#bdd0c9;line-height:1.6}.mark{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#e5b85f}.panel{background:#f7f5ef;padding:48px;display:flex;align-items:center}.card{width:100%;max-width:380px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#718078}.card h2{font-size:34px;letter-spacing:-.04em;margin:12px 0 8px}.muted{color:#65736d;line-height:1.5}.label{display:block;font-size:13px;font-weight:700;margin:22px 0 8px}.input{width:100%;padding:14px 15px;border:1px solid #cbd4cc;border-radius:10px;background:#fff;font:inherit}.button{width:100%;margin-top:24px;border:0;border-radius:10px;padding:14px;background:#d49b3c;font-weight:800;cursor:pointer}.error{background:#f8ded8;color:#9c3d2f;padding:11px 13px;border-radius:9px;margin:18px 0;font-size:14px}@media(max-width:760px){.shell{display:block}.brand{min-height:35vh;padding:32px}.brand h1{font-size:48px}.panel{min-height:65vh;padding:32px}}</style></head><body><main class="shell"><section class="brand"><div class="mark">VK / Chatwoot gateway</div><div><h1>Сообщения<br>без потерь.</h1><p>Единая панель для подключения VK-сообществ к рабочим пространствам Chatwoot.</p></div><div class="eyebrow">secure operator access</div></section><section class="panel"><div class="card"><div class="eyebrow">закрытая зона</div><h2>Войти в панель</h2><p class="muted">Используйте учётные данные администратора gateway.</p>${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<form method="post" action="/admin/login"><label class="label" for="username">Логин</label><input class="input" id="username" name="username" autocomplete="username" required autofocus><label class="label" for="password">Пароль</label><input class="input" id="password" name="password" type="password" autocomplete="current-password" required><button class="button" type="submit">Продолжить</button></form></div></section></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
