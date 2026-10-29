import { createHash } from 'node:crypto';
import type { LogLevel } from './logger.ts';

export interface NewApiConfig {
  enabled: boolean;
  baseUrl: URL | null;
  adminToken: string | null;
  adminUserId: string | null;
  pageSize: number;
  syncIntervalMs: number;
  initialBackfillHours: number;
  overlapMs: number;
  safetyLagMs: number;
  timeoutMs: number;
  sourceKeyMode: 'composite' | 'id';
  sqlitePath: string | null;
}

export interface Config {
  port: number;
  host: string;
  deploymentId: string;
  logLevel: LogLevel;
  upstreamUrl: URL;
  upstreamIdleTimeoutMs: number;
  databaseUrl: string;
  adminToken: string | null;
  sessionSecret: string;
  sessionTtlMs: number;
  sessionCookieSecure: boolean;
  trustProxyHeaders: boolean;
  captureEnabled: boolean;
  captureRoutes: Set<string>;
  captureMaxBytes: number;
  captureMaxTotalBytes: number;
  captureMaxChars: number;
  promptRetentionDays: number;
  cleanupIntervalMs: number;
  queueMaxMetadata: number;
  queueMaxContent: number;
  queueFlushMs: number;
  queueBatchSize: number;
  associationPendingWindowMs: number;
  identityMode: 'auto' | 'user' | 'token';
  adminPath: string;
  healthPath: string;
  newapi: NewApiConfig;
}

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(name, `必须是 >= ${min} 的整数`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new ConfigError(name, '必须是 true/false');
}

function readUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): URL {
  const raw = readString(env, name, fallback);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('仅支持 http/https');
    }
    return url;
  } catch (error) {
    throw new ConfigError(name, `不是有效的 http(s) URL（${(error as Error).message}）`);
  }
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const value = readString(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new ConfigError('LOG_LEVEL', '必须是 debug/info/warn/error');
}

function readIdentityMode(env: NodeJS.ProcessEnv): 'auto' | 'user' | 'token' {
  const value = readString(env, 'IDENTITY_MODE', 'auto').toLowerCase();
  if (value === 'auto' || value === 'user' || value === 'token') return value;
  throw new ConfigError('IDENTITY_MODE', '必须是 auto/user/token');
}

function readPath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = readString(env, name, fallback).trim();
  if (!value.startsWith('/')) throw new ConfigError(name, '必须以 / 开头');
  if (value.length > 1 && value.endsWith('/')) return value.slice(0, -1);
  return value;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const adminToken = readOptional(env, 'ADMIN_API_TOKEN');
  const sessionSecret = readOptional(env, 'SESSION_SECRET') ??
    (adminToken ? createHash('sha256').update(`zhlx-session:${adminToken}`).digest('hex') : '');
  const sessionTtlHours = readInt(env, 'SESSION_TTL_HOURS', 8, 1);

  const captureRoutes = new Set(
    readString(env, 'CAPTURE_ROUTES', '/v1/chat/completions,/v1/responses,/v1/messages,/v1/completions')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

  const newapiBaseUrl = readOptional(env, 'NEWAPI_BASE_URL');
  const newapiAdminToken = readOptional(env, 'NEWAPI_ADMIN_TOKEN');
  const newapiSqlitePath = readOptional(env, 'NEWAPI_SQLITE_PATH');
  const newapiEnabled = readBool(env, 'NEWAPI_LOG_SYNC_ENABLED', false);
  if (newapiEnabled && !newapiSqlitePath && (!newapiBaseUrl || !newapiAdminToken)) {
    throw new ConfigError(
      'NEWAPI_LOG_SYNC_ENABLED',
      '启用同步时必须设置 NEWAPI_SQLITE_PATH，或同时设置 NEWAPI_BASE_URL 和 NEWAPI_ADMIN_TOKEN',
    );
  }
  const sourceKeyModeRaw = readString(env, 'NEWAPI_SOURCE_KEY_MODE', 'composite');
  if (sourceKeyModeRaw !== 'composite' && sourceKeyModeRaw !== 'id') {
    throw new ConfigError('NEWAPI_SOURCE_KEY_MODE', '必须是 composite 或 id');
  }

  const databaseUrl = readString(env, 'DATABASE_URL', 'file:./data/zhlx.db');

  return {
    port: readInt(env, 'PORT', 8080, 0),
    host: readString(env, 'HOST', '0.0.0.0'),
    deploymentId: readString(env, 'DEPLOYMENT_ID', 'local'),
    logLevel: readLogLevel(env),
    upstreamUrl: readUrl(env, 'UPSTREAM_URL', 'http://127.0.0.1:3000'),
    upstreamIdleTimeoutMs: readInt(env, 'UPSTREAM_IDLE_TIMEOUT_MS', 0, 0),
    databaseUrl,
    adminToken,
    sessionSecret,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    sessionCookieSecure: readBool(env, 'SESSION_COOKIE_SECURE', false),
    trustProxyHeaders: readBool(env, 'TRUST_PROXY_HEADERS', false),
    captureEnabled: readBool(env, 'CAPTURE_ENABLED', false),
    captureRoutes,
    captureMaxBytes: readInt(env, 'CAPTURE_MAX_BYTES', 4_194_304, 1024),
    captureMaxTotalBytes: readInt(env, 'CAPTURE_MAX_TOTAL_BYTES', 268_435_456, 4096),
    captureMaxChars: readInt(env, 'CAPTURE_MAX_CHARS', 8000, 100),
    promptRetentionDays: readInt(env, 'PROMPT_RETENTION_DAYS', 30, 1),
    cleanupIntervalMs: readInt(env, 'CLEANUP_INTERVAL_MS', 3_600_000, 10_000),
    queueMaxMetadata: readInt(env, 'QUEUE_MAX_METADATA', 5000, 1),
    queueMaxContent: readInt(env, 'QUEUE_MAX_CONTENT', 500, 1),
    queueFlushMs: readInt(env, 'QUEUE_FLUSH_MS', 1000, 10),
    queueBatchSize: readInt(env, 'QUEUE_BATCH_SIZE', 200, 1),
    associationPendingWindowMs: readInt(env, 'ASSOCIATION_PENDING_WINDOW_MS', 300_000, 0),
    identityMode: readIdentityMode(env),
    adminPath: readPath(env, 'ADMIN_PATH', '/_zhlx/admin'),
    healthPath: readPath(env, 'HEALTH_PATH', '/_zhlx/healthz'),
    newapi: {
      enabled: newapiEnabled,
      baseUrl: newapiBaseUrl ? readUrl(env, 'NEWAPI_BASE_URL', newapiBaseUrl) : null,
      adminToken: newapiAdminToken,
      adminUserId: readOptional(env, 'NEWAPI_ADMIN_USER_ID'),
      pageSize: readInt(env, 'NEWAPI_LOG_PAGE_SIZE', 100, 1),
      syncIntervalMs: readInt(env, 'NEWAPI_LOG_SYNC_INTERVAL_MS', 300_000, 10_000),
      initialBackfillHours: readInt(env, 'NEWAPI_LOG_INITIAL_BACKFILL_HOURS', 24, 1),
      overlapMs: readInt(env, 'NEWAPI_LOG_OVERLAP_MS', 600_000, 0),
      safetyLagMs: readInt(env, 'NEWAPI_LOG_SAFETY_LAG_MS', 30_000, 0),
      timeoutMs: readInt(env, 'NEWAPI_LOG_TIMEOUT_MS', 30_000, 1000),
      sourceKeyMode: sourceKeyModeRaw,
      sqlitePath: newapiSqlitePath,
    },
  };
}
