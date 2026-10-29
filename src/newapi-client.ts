import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEventInsert, UsageSource } from './store/types.ts';

export interface RawLog {
  [key: string]: unknown;
}

export class NewApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'NewApiError';
    this.status = status;
  }
}

export interface NewApiClientOptions {
  baseUrl: URL;
  adminToken: string;
  adminUserId: string | null;
  timeoutMs: number;
  pageSize: number;
}

export interface LogSource {
  fetchPage(
    type: number,
    startSeconds: number,
    endSeconds: number,
    page: number,
    pageSize: number,
  ): Promise<RawLog[]>;
  describe(): string;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/.test(value)) {
      const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function parseOther(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function mapRawLog(
  raw: RawLog,
  deploymentId: string,
  sourceKeyMode: 'composite' | 'id',
): UsageEventInsert | null {
  const createdAt = toIsoTimestamp(raw.created_at ?? raw.createdAt ?? raw.timestamp);
  const logType = numberOrNull(raw.type ?? raw.log_type);
  if (!createdAt || logType === null) return null;

  const sourceId = stringOrNull(raw.id);
  const requestId = stringOrNull(raw.request_id);
  const model = stringOrNull(raw.model_name ?? raw.model);
  const promptTokens = numberOrNull(raw.prompt_tokens);
  const completionTokens = numberOrNull(raw.completion_tokens);
  const quota = numberOrNull(raw.quota);
  const other = parseOther(raw.other);
  const adminInfo = other && typeof other.admin_info === 'object' && other.admin_info !== null
    ? (other.admin_info as Record<string, unknown>)
    : null;
  const estimated = adminInfo?.local_count_tokens === true;

  let usageSource: UsageSource;
  if (estimated) usageSource = 'estimated';
  else if (promptTokens === null || completionTokens === null) usageSource = 'missing';
  else usageSource = 'reported';

  const userId = numberOrNull(raw.user_id);
  const tokenId = numberOrNull(raw.token_id);
  // New API 各版本字段不同：v0.13 使用 channel_id，较新版本使用 channel。
  const channel = numberOrNull(raw.channel ?? raw.channel_id);
  const sourceIdentity =
    sourceKeyMode === 'id' && sourceId !== null
      ? `id:${sourceId}`
      : [
          'composite',
          createdAt,
          requestId ?? '',
          stringOrNull(raw.upstream_request_id) ?? '',
          logType,
          model ?? '',
          promptTokens ?? '',
          completionTokens ?? '',
          quota ?? '',
          channel ?? '',
          tokenId ?? '',
          userId ?? '',
          numberOrNull(raw.use_time) ?? '',
          raw.is_stream === true ? '1' : raw.is_stream === false ? '0' : '',
        ].join('|');
  const sourceKey = `${deploymentId}:${createHash('sha256').update(sourceIdentity).digest('hex').slice(0, 40)}`;

  const sanitizedRaw = {
    id: raw.id ?? null,
    created_at: raw.created_at ?? null,
    type: raw.type ?? raw.log_type ?? null,
    request_id: requestId,
    upstream_request_id: stringOrNull(raw.upstream_request_id),
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    quota,
    channel,
    channel_name: stringOrNull(raw.channel_name),
    use_time: numberOrNull(raw.use_time),
    is_stream: raw.is_stream ?? null,
    token_id: tokenId,
    user_id: userId,
    other: adminInfo ? { admin_info: { local_count_tokens: adminInfo.local_count_tokens === true } } : null,
  };

  return {
    source_key: sourceKey,
    deployment_id: deploymentId,
    source_id: sourceId,
    newapi_request_id: requestId,
    log_type: logType,
    created_at: createdAt,
    user_id: userId,
    username: stringOrNull(raw.username),
    token_id: tokenId,
    token_name: stringOrNull(raw.token_name),
    model,
    channel,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    quota,
    usage_source: usageSource,
    raw: JSON.stringify(sanitizedRaw),
    synced_at: new Date().toISOString(),
  };
}

export class NewApiLogClient implements LogSource {
  private readonly options: NewApiClientOptions;

  constructor(options: NewApiClientOptions) {
    this.options = options;
  }

  describe(): string {
    return `http:${this.options.baseUrl.origin}`;
  }

  async fetchPage(
    type: number,
    startSeconds: number,
    endSeconds: number,
    page: number,
    pageSize: number,
  ): Promise<RawLog[]> {
    const basePath = this.options.baseUrl.pathname.replace(/\/$/, '');
    const url = new URL(`${this.options.baseUrl.origin}${basePath}/api/log/`);
    url.searchParams.set('type', String(type));
    url.searchParams.set('start_timestamp', String(startSeconds));
    url.searchParams.set('end_timestamp', String(endSeconds));
    url.searchParams.set('p', String(page));
    url.searchParams.set('page_size', String(pageSize));

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.adminToken}`,
      accept: 'application/json',
    };
    if (this.options.adminUserId) headers['new-api-user'] = this.options.adminUserId;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new NewApiError(`请求日志接口失败：${(error as Error).message}`, 0);
    }

    if (!response.ok) {
      throw new NewApiError(`日志接口返回 HTTP ${response.status}`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new NewApiError('日志接口返回非 JSON 响应', response.status);
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new NewApiError('日志接口响应格式异常', response.status);
    }
    const record = payload as Record<string, unknown>;
    if (record.success === false) {
      throw new NewApiError(`日志接口报告失败：${String(record.message ?? 'unknown')}`, response.status);
    }

    const data = record.data ?? record;
    if (Array.isArray(data)) return data as RawLog[];
    if (typeof data === 'object' && data !== null) {
      const nested = data as Record<string, unknown>;
      if (Array.isArray(nested.items)) return nested.items as RawLog[];
      if (Array.isArray(nested.data)) return nested.data as RawLog[];
    }
    return [];
  }
}

export interface SqliteLogSourceOptions {
  path: string;
}

/**
 * 只读打开 New API 的 SQLite 日志库，适用于与 New API 同机部署
 * 且管理员 access_token 不可用的场景。每次查询独立打开，避免长期占用写锁。
 */
export class SqliteLogSource implements LogSource {
  private readonly path: string;

  constructor(options: SqliteLogSourceOptions) {
    this.path = options.path;
  }

  describe(): string {
    return `sqlite:${this.path}`;
  }

  async fetchPage(
    type: number,
    startSeconds: number,
    endSeconds: number,
    page: number,
    pageSize: number,
  ): Promise<RawLog[]> {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path, { readOnly: true, timeout: 5000 });
    } catch (error) {
      throw new NewApiError(`无法打开 New API 日志库：${(error as Error).message}`, 0);
    }
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const offset = (page - 1) * pageSize;
      const statement = db.prepare(
        `SELECT id, user_id, created_at, type, content, username, token_name, model_name,
                quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id,
                channel_name, token_id, "group", ip, request_id, other
         FROM logs
         WHERE type = ? AND created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC, id ASC
         LIMIT ? OFFSET ?`,
      );
      const rows = statement.all(type, startSeconds, endSeconds, pageSize, offset) as RawLog[];
      return rows.map((row) => ({ ...row }));
    } catch (error) {
      throw new NewApiError(`读取 New API 日志库失败：${(error as Error).message}`, 0);
    } finally {
      db.close();
    }
  }
}
