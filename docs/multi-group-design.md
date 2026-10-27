# Multi-group VK–Chatwoot gateway design

**Status:** accepted
**Date:** 2026-10-26

## Goal

Run one gateway instance for many VK communities. Each community has isolated VK credentials and one Chatwoot API Inbox. Operators configure groups through a protected web UI; only infrastructure/bootstrap values remain in environment variables.

## Architecture

- Fastify HTTP service exposes `/health`, `/vk/callback`, `/chatwoot/webhook`, and `/admin`.
- PostgreSQL stores group configuration and encrypted credentials.
- AES-256-GCM encrypts VK and Chatwoot tokens at rest using an infrastructure encryption key.
- Basic-auth protects the initial admin UI; bootstrap username/password remain technical deployment secrets.
- A group manager loads enabled groups, creates one VK client per group, routes Callback API events by `group_id`, and routes Chatwoot messages by `inbox_id`.
- Long Poll is retained as an optional per-group mode; Callback API is the production default.

## Isolation rules

- Chatwoot contact source IDs are `vk:<group_id>:<peer_id>`.
- Deduplication keys include the group ID.
- Outbound Chatwoot webhooks are accepted only when their inbox ID maps to an enabled group.
- Unknown groups, unknown inboxes, and invalid per-group secrets are rejected without trying another tenant's credentials.

## UI MVP

- List, enable/disable, create, edit, and delete group records.
- Configure group ID, display name, VK token, callback secret/confirmation, API version, Chatwoot URL/account/token/inbox, and webhook secret.
- Test VK credentials and Chatwoot credentials independently.
- Show the common callback URL and per-group operational status without displaying secrets.

## Explicit non-goals for this rollout

- Native Chatwoot channel changes.
- Multi-user admin roles or SSO.
- Billing, tenant self-service, or attachment policy customization.
- Background job queue; existing in-process deduplication remains the first MVP behavior.

## Verification gates

- Unit tests cover config, encryption, routing, tenant-scoped identifiers, and admin redaction.
- `format:check`, lint, typecheck, tests, and build pass.
- Docker Compose validates with a PostgreSQL dependency.
- Dokploy deploys the fork into `companyOS` on `147.45.124.98` with domain `vk.youcompany.ru`.
- Public `/health` and protected `/admin` are verified after deployment; no VK or Chatwoot credentials are entered during this rollout.
