import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));
const optionalRedisUrl = optionalString.pipe(
  z
    .string()
    .url('REDIS_URL must be a valid URL')
    .refine((v) => ['redis:', 'rediss:'].includes(new URL(v).protocol), {
      message: 'REDIS_URL must use redis:// or rediss://',
    })
    .optional(),
);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(30_000),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MAX_ATTACHMENT_MB: z.coerce.number().positive().default(50),
  DATABASE_URL: z.string().default('postgresql://gateway:gateway@localhost:5432/gateway'),
  ENCRYPTION_KEY: z.string().min(32).default('development-only-encryption-key-change-me'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12).default('development-admin-password'),
  ADMIN_SESSION_SECRET: z.string().min(32).default('development-only-session-secret-change-me'),
  REDIS_URL: optionalRedisUrl,
});

const legacySchema = baseSchema.extend({
  VK_MODE: z.enum(['longpoll', 'callback']).default('longpoll'),
  VK_TOKEN: z.string().min(1),
  VK_GROUP_ID: z.coerce.number().int().positive().optional(),
  VK_API_VERSION: z.string().min(1).default('5.199'),
  VK_CONFIRMATION: optionalString,
  VK_CALLBACK_SECRET: optionalString,
  CHATWOOT_URL: z.string().url(),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
  CHATWOOT_TOKEN: z.string().min(1),
  CHATWOOT_INBOX_ID: z.coerce.number().int().positive(),
  CHATWOOT_WEBHOOK_SECRET: optionalString,
});

const runtimeSchema = baseSchema.superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV !== 'test' && cfg.ADMIN_PASSWORD === 'development-admin-password') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ADMIN_PASSWORD'],
      message: 'ADMIN_PASSWORD must be changed',
    });
  }
  if (
    cfg.NODE_ENV !== 'test' &&
    cfg.ENCRYPTION_KEY === 'development-only-encryption-key-change-me'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ENCRYPTION_KEY'],
      message: 'ENCRYPTION_KEY must be changed',
    });
  }
  if (
    cfg.NODE_ENV !== 'test' &&
    cfg.ADMIN_SESSION_SECRET === 'development-only-session-secret-change-me'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ADMIN_SESSION_SECRET'],
      message: 'ADMIN_SESSION_SECRET must be changed',
    });
  }
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  shutdownTimeoutMs: number;
  publicUrl: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  maxAttachmentBytes: number;
  databaseUrl: string;
  encryptionKey: string;
  adminUsername: string;
  adminPassword: string;
  adminSessionSecret: string;
  redisUrl?: string;
  multiGroup: boolean;
  // Legacy singleton fields are retained for compatibility with the original testable core.
  vkMode: 'longpoll' | 'callback';
  vkToken: string;
  vkGroupId?: number;
  vkApiVersion: string;
  vkConfirmation?: string;
  vkCallbackSecret?: string;
  chatwootUrl: string;
  chatwootAccountId: number;
  chatwootToken: string;
  chatwootInboxId: number;
  chatwootWebhookSecret?: string;
}

function common(
  c: z.infer<typeof baseSchema>,
): Omit<
  Config,
  | 'multiGroup'
  | 'vkMode'
  | 'vkToken'
  | 'vkGroupId'
  | 'vkApiVersion'
  | 'vkConfirmation'
  | 'vkCallbackSecret'
  | 'chatwootUrl'
  | 'chatwootAccountId'
  | 'chatwootToken'
  | 'chatwootInboxId'
  | 'chatwootWebhookSecret'
> {
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    shutdownTimeoutMs: c.SHUTDOWN_TIMEOUT_MS,
    publicUrl: c.PUBLIC_URL.replace(/\/+$/, ''),
    logLevel: c.LOG_LEVEL,
    maxAttachmentBytes: Math.round(c.MAX_ATTACHMENT_MB * 1024 * 1024),
    databaseUrl: c.DATABASE_URL,
    encryptionKey: c.ENCRYPTION_KEY,
    adminUsername: c.ADMIN_USERNAME,
    adminPassword: c.ADMIN_PASSWORD,
    adminSessionSecret: c.ADMIN_SESSION_SECRET,
    redisUrl: c.REDIS_URL,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isLegacy = Boolean(env.VK_TOKEN);
  const parsed = (isLegacy ? legacySchema : runtimeSchema).safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  if (!isLegacy) {
    const multi = parsed.data;
    return {
      ...common(multi),
      multiGroup: true,
      adminSessionSecret: multi.ADMIN_SESSION_SECRET,
      vkMode: 'callback',
      vkToken: '',
      vkGroupId: undefined,
      vkApiVersion: '5.199',
      chatwootUrl: '',
      chatwootAccountId: 0,
      chatwootToken: '',
      chatwootInboxId: 0,
    };
  }
  const legacy = parsed.data as z.infer<typeof legacySchema>;
  if (legacy.VK_MODE === 'longpoll' && legacy.VK_GROUP_ID === undefined)
    throw new Error('Invalid configuration:\n  - VK_GROUP_ID: required in longpoll mode');
  if (legacy.VK_MODE === 'callback' && !legacy.VK_CONFIRMATION)
    throw new Error('Invalid configuration:\n  - VK_CONFIRMATION: required in callback mode');
  return {
    ...common(legacy),
    multiGroup: false,
    adminSessionSecret: legacy.ADMIN_SESSION_SECRET,
    vkMode: legacy.VK_MODE,
    vkToken: legacy.VK_TOKEN,
    vkGroupId: legacy.VK_GROUP_ID,
    vkApiVersion: legacy.VK_API_VERSION,
    vkConfirmation: legacy.VK_CONFIRMATION,
    vkCallbackSecret: legacy.VK_CALLBACK_SECRET,
    chatwootUrl: legacy.CHATWOOT_URL.replace(/\/+$/, ''),
    chatwootAccountId: legacy.CHATWOOT_ACCOUNT_ID,
    chatwootToken: legacy.CHATWOOT_TOKEN,
    chatwootInboxId: legacy.CHATWOOT_INBOX_ID,
    chatwootWebhookSecret: legacy.CHATWOOT_WEBHOOK_SECRET,
  };
}
