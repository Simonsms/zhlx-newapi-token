import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from './db.ts';
import type {
  AssociationCounts,
  BreakdownRow,
  CaptureStats,
  IdentityStats,
  ProxyRequestFilter,
  ProxyRequestInsert,
  ProxyRequestRecord,
  SyncState,
  UsageEventInsert,
  UsageEventRecord,
  UsageFilter,
  UsageTotals,
} from './types.ts';

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapProxyRow(row: Row): ProxyRequestRecord {
  return {
    proxy_request_id: String(row.proxy_request_id),
    deployment_id: String(row.deployment_id),
    newapi_request_id: strOrNull(row.newapi_request_id),
    received_at: String(row.received_at),
    method: String(row.method),
    path: String(row.path),
    http_status: numOrNull(row.http_status),
    transport_outcome: row.transport_outcome as ProxyRequestRecord['transport_outcome'],
    capture_status: row.capture_status as ProxyRequestRecord['capture_status'],
    skip_reason: strOrNull(row.skip_reason),
    prompt_text: strOrNull(row.prompt_text),
    prompt_scope: strOrNull(row.prompt_scope),
    prompt_chars: numOrNull(row.prompt_chars),
    prompt_truncated: num(row.prompt_truncated),
    extraction_version: strOrNull(row.extraction_version),
    redaction_version: strOrNull(row.redaction_version),
    model: strOrNull(row.model),
    is_stream: numOrNull(row.is_stream),
    duration_ms: numOrNull(row.duration_ms),
    usage_event_count: num(row.usage_event_count),
    prompt_tokens: numOrNull(row.prompt_tokens),
    completion_tokens: numOrNull(row.completion_tokens),
    quota: numOrNull(row.quota),
    association_status: row.association_status as ProxyRequestRecord['association_status'],
  };
}

function mapUsageRow(row: Row): UsageEventRecord {
  return {
    source_key: String(row.source_key),
    source_id: strOrNull(row.source_id),
    newapi_request_id: strOrNull(row.newapi_request_id),
    log_type: num(row.log_type),
    created_at: String(row.created_at),
    user_id: numOrNull(row.user_id),
    username: strOrNull(row.username),
    token_id: numOrNull(row.token_id),
    token_name: strOrNull(row.token_name),
    model: strOrNull(row.model),
    channel: numOrNull(row.channel),
    prompt_tokens: numOrNull(row.prompt_tokens),
    completion_tokens: numOrNull(row.completion_tokens),
    quota: numOrNull(row.quota),
    usage_source: row.usage_source as UsageEventRecord['usage_source'],
  };
}

const PROXY_COLUMNS = [
  'proxy_request_id',
  'deployment_id',
  'newapi_request_id',
  'received_at',
  'method',
  'path',
  'http_status',
  'transport_outcome',
  'capture_status',
  'skip_reason',
  'prompt_text',
  'prompt_scope',
  'prompt_chars',
  'prompt_truncated',
  'extraction_version',
  'redaction_version',
  'model',
  'is_stream',
  'duration_ms',
] as const;

const USAGE_COLUMNS = [
  'source_key',
  'deployment_id',
  'source_id',
  'newapi_request_id',
  'log_type',
  'created_at',
  'user_id',
  'username',
  'token_id',
  'token_name',
  'model',
  'channel',
  'prompt_tokens',
  'completion_tokens',
  'quota',
  'usage_source',
  'raw',
  'synced_at',
] as const;

function placeholders(columns: readonly string[], startAt = 1): string {
  return columns.map((_column, index) => `$${startAt + index}`).join(', ');
}

export class Store {
  readonly db: Db;
  readonly deploymentId: string;

  constructor(db: Db, deploymentId: string) {
    this.db = db;
    this.deploymentId = deploymentId;
  }

  async insertProxyRequests(rows: ProxyRequestInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      const sql = `INSERT INTO proxy_request (${PROXY_COLUMNS.join(', ')}) VALUES (${placeholders(PROXY_COLUMNS)}) ON CONFLICT (proxy_request_id) DO NOTHING`;
      for (const row of rows) {
        inserted += await tx.execute(
          sql,
          PROXY_COLUMNS.map((column) => row[column] ?? null),
        );
      }
      return inserted;
    });
  }

  async insertUsageEvents(rows: UsageEventInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      const sql = `INSERT INTO usage_event (${USAGE_COLUMNS.join(', ')}) VALUES (${placeholders(USAGE_COLUMNS)}) ON CONFLICT (source_key) DO NOTHING`;
      for (const row of rows) {
        inserted += await tx.execute(
          sql,
          USAGE_COLUMNS.map((column) => row[column] ?? null),
        );
      }
      return inserted;
    });
  }

  async getProxyRequest(
    proxyRequestId: string,
    pendingWindowMs = 300_000,
    now: Date = new Date(),
  ): Promise<{
    request: ProxyRequestRecord;
    usage_events: UsageEventRecord[];
  } | null> {
    const rows = await this.db.query<Row>(
      `SELECT p.*, 0 AS usage_event_count, NULL AS prompt_tokens, NULL AS completion_tokens, NULL AS quota,
        CASE WHEN p.newapi_request_id IS NULL OR p.newapi_request_id = '' THEN 'no_gateway_id' ELSE 'matched' END AS association_status
       FROM proxy_request p
       WHERE p.proxy_request_id = $1 AND p.deployment_id = $2`,
      [proxyRequestId, this.deploymentId],
    );
    const row = rows[0];
    if (!row) return null;
    const usage = await this.db.query<Row>(
      `SELECT ${USAGE_COLUMNS.filter((column) => column !== 'raw').join(', ')}
       FROM usage_event
       WHERE deployment_id = $1 AND newapi_request_id = $2
       ORDER BY created_at ASC, source_key ASC`,
      [this.deploymentId, row.newapi_request_id],
    );
    const request = mapProxyRow(row);
    request.usage_event_count = usage.length;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let quota: number | null = null;
    for (const event of usage) {
      if (Number(event.log_type) !== 2) continue;
      promptTokens = (promptTokens ?? 0) + (numOrNull(event.prompt_tokens) ?? 0);
      completionTokens = (completionTokens ?? 0) + (numOrNull(event.completion_tokens) ?? 0);
      quota = (quota ?? 0) + (numOrNull(event.quota) ?? 0);
    }
    request.prompt_tokens = promptTokens;
    request.completion_tokens = completionTokens;
    request.quota = quota;
    const pendingCutoff = new Date(now.getTime() - pendingWindowMs).toISOString();
    request.association_status = request.newapi_request_id
      ? usage.length > 0
        ? 'matched'
        : request.received_at >= pendingCutoff
          ? 'pending'
          : 'unmatched'
      : 'no_gateway_id';
    return { request, usage_events: usage.map(mapUsageRow) };
  }

  private requestCte(filter: ProxyRequestFilter, pendingCutoff: string): { cte: string; params: unknown[] } {
    const params: unknown[] = [this.deploymentId, filter.from, filter.to];
    const joinConditions = [
      'u.deployment_id = p.deployment_id',
      'u.newapi_request_id = p.newapi_request_id',
    ];
    const where = ['p.deployment_id = $1', 'p.received_at >= $2', 'p.received_at < $3'];
    if (filter.userId !== null && filter.userId !== undefined) {
      params.push(filter.userId);
      where.push(`EXISTS (
        SELECT 1 FROM usage_event uf
        WHERE uf.deployment_id = p.deployment_id
          AND uf.newapi_request_id = p.newapi_request_id
          AND uf.user_id = $${params.length}
      )`);
    }
    if (filter.tokenId !== null && filter.tokenId !== undefined) {
      params.push(filter.tokenId);
      where.push(`EXISTS (
        SELECT 1 FROM usage_event uf
        WHERE uf.deployment_id = p.deployment_id
          AND uf.newapi_request_id = p.newapi_request_id
          AND uf.token_id = $${params.length}
      )`);
    }
    if (filter.model) {
      params.push(filter.model);
      const first = params.length;
      params.push(filter.model);
      where.push(`(p.model = $${first} OR EXISTS (
        SELECT 1 FROM usage_event uf
        WHERE uf.deployment_id = p.deployment_id
          AND uf.newapi_request_id = p.newapi_request_id
          AND uf.model = $${params.length}
      ))`);
    }
    if (filter.query) {
      params.push(`%${filter.query}%`);
      where.push(`LOWER(p.prompt_text) LIKE LOWER($${params.length})`);
    }
    params.push(pendingCutoff);
    const pendingParam = `$${params.length}`;

    const cte = `WITH base AS (
      SELECT p.*,
        COUNT(u.source_key) AS usage_event_count,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.completion_tokens ELSE 0 END), 0) AS completion_tokens,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.quota ELSE 0 END), 0) AS quota
      FROM proxy_request p
      LEFT JOIN usage_event u ON ${joinConditions.join(' AND ')}
      WHERE ${where.join(' AND ')}
      GROUP BY p.proxy_request_id
    ), enriched AS (
      SELECT base.*,
        CASE
          WHEN base.newapi_request_id IS NULL OR base.newapi_request_id = '' THEN 'no_gateway_id'
          WHEN base.usage_event_count > 0 THEN 'matched'
          WHEN base.received_at >= ${pendingParam} THEN 'pending'
          ELSE 'unmatched'
        END AS association_status
      FROM base
    )`;
    return { cte, params };
  }

  async listProxyRequests(
    filter: ProxyRequestFilter,
    pendingWindowMs: number,
    now: Date = new Date(),
  ): Promise<{ items: ProxyRequestRecord[]; total: number }> {
    const pendingCutoff = new Date(now.getTime() - pendingWindowMs).toISOString();
    const { cte, params } = this.requestCte(filter, pendingCutoff);
    const statusFilter = filter.status ? 'WHERE association_status = $STATUS' : '';
    const statusParam = filter.status ? params.length + 1 : 0;
    const limitParam = params.length + (filter.status ? 2 : 1);
    const offsetParam = limitParam + 1;

    const countSql = `${cte} SELECT COUNT(*) AS total FROM enriched ${statusFilter.replace('$STATUS', `$${statusParam}`)}`;
    const countParams = filter.status ? [...params, filter.status] : params;
    const countRows = await this.db.query<Row>(countSql, countParams);
    const total = num(countRows[0]?.total);

    if (total === 0) return { items: [], total: 0 };

    const itemsSql = `${cte} SELECT * FROM enriched ${statusFilter.replace('$STATUS', `$${statusParam}`)}
      ORDER BY received_at DESC, proxy_request_id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const itemParams = [
      ...params,
      ...(filter.status ? [filter.status] : []),
      filter.pageSize,
      (filter.page - 1) * filter.pageSize,
    ];
    const rows = await this.db.query<Row>(itemsSql, itemParams);
    return { items: rows.map(mapProxyRow), total };
  }

  private usageWhere(filter: UsageFilter, capturedOnly = false): { where: string; params: unknown[] } {
    const params: unknown[] = [this.deploymentId, filter.from, filter.to];
    const clauses = ['u.deployment_id = $1', 'u.created_at >= $2', 'u.created_at < $3'];
    if (filter.userId !== null && filter.userId !== undefined) {
      params.push(filter.userId);
      clauses.push(`u.user_id = $${params.length}`);
    }
    if (filter.tokenId !== null && filter.tokenId !== undefined) {
      params.push(filter.tokenId);
      clauses.push(`u.token_id = $${params.length}`);
    }
    if (filter.model) {
      params.push(filter.model);
      clauses.push(`u.model = $${params.length}`);
    }
    if (capturedOnly) {
      clauses.push(`EXISTS (
        SELECT 1 FROM proxy_request p
        WHERE p.deployment_id = u.deployment_id
          AND p.newapi_request_id = u.newapi_request_id
          AND p.prompt_text IS NOT NULL
      )`);
    }
    return { where: clauses.join(' AND '), params };
  }

  async usageTotals(filter: UsageFilter, capturedOnly = false): Promise<UsageTotals> {
    const { where, params } = this.usageWhere(filter, capturedOnly);
    const rows = await this.db.query<Row>(
      `SELECT
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN 1 ELSE 0 END), 0) AS consume_events,
        COALESCE(SUM(CASE WHEN u.log_type = 5 THEN 1 ELSE 0 END), 0) AS error_events,
        COALESCE(SUM(CASE WHEN u.log_type = 6 THEN 1 ELSE 0 END), 0) AS refund_events,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.completion_tokens ELSE 0 END), 0) AS completion_tokens,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.quota ELSE 0 END), 0) AS quota,
        COALESCE(SUM(CASE WHEN u.log_type = 2 AND u.usage_source = 'estimated' THEN 1 ELSE 0 END), 0) AS estimated_events,
        COALESCE(SUM(CASE WHEN u.log_type = 2 AND u.usage_source = 'missing' THEN 1 ELSE 0 END), 0) AS missing_events,
        COUNT(DISTINCT CASE WHEN u.log_type = 2 AND u.user_id IS NOT NULL THEN u.user_id END) AS active_users,
        COUNT(DISTINCT CASE WHEN u.log_type = 2 AND u.token_id IS NOT NULL THEN u.token_id END) AS active_tokens,
        COUNT(DISTINCT CASE WHEN u.log_type = 2 THEN u.model END) AS model_count
       FROM usage_event u
       WHERE ${where}`,
      params,
    );
    const row = rows[0] ?? {};
    return {
      consume_events: num(row.consume_events),
      error_events: num(row.error_events),
      refund_events: num(row.refund_events),
      prompt_tokens: num(row.prompt_tokens),
      completion_tokens: num(row.completion_tokens),
      quota: num(row.quota),
      estimated_events: num(row.estimated_events),
      missing_events: num(row.missing_events),
      active_users: num(row.active_users),
      active_tokens: num(row.active_tokens),
      model_count: num(row.model_count),
    };
  }

  async identityStats(filter: UsageFilter, preferred: 'auto' | 'user' | 'token' = 'auto'): Promise<IdentityStats> {
    const rows = await this.db.query<Row>(
      `SELECT
        COUNT(DISTINCT CASE WHEN log_type = 2 AND user_id IS NOT NULL THEN user_id END) AS distinct_users,
        COUNT(DISTINCT CASE WHEN log_type = 2 AND token_id IS NOT NULL THEN token_id END) AS distinct_tokens
       FROM usage_event
       WHERE deployment_id = $1 AND created_at >= $2 AND created_at < $3`,
      [this.deploymentId, filter.from, filter.to],
    );
    const row = rows[0] ?? {};
    const distinctUsers = num(row.distinct_users);
    const distinctTokens = num(row.distinct_tokens);
    let mode: 'user' | 'token';
    if (preferred === 'token') mode = 'token';
    else if (preferred === 'user') mode = 'user';
    else mode = distinctUsers <= 1 && distinctTokens > 1 ? 'token' : 'user';
    return { distinct_users: distinctUsers, distinct_tokens: distinctTokens, mode };
  }

  async usageBreakdown(
    filter: UsageFilter,
    groupBy: 'day' | 'user' | 'token' | 'model',
    limit = 30,
  ): Promise<BreakdownRow[]> {
    const { where, params } = this.usageWhere(filter);
    let bucket: string;
    let group: string;
    if (groupBy === 'day') {
      bucket = "substr(u.created_at, 1, 10) AS bucket_id, NULL AS bucket_label";
      group = 'substr(u.created_at, 1, 10)';
    } else if (groupBy === 'user') {
      bucket = 'u.user_id AS bucket_id, u.username AS bucket_label';
      group = 'u.user_id, u.username';
    } else if (groupBy === 'token') {
      bucket = 'u.token_id AS bucket_id, u.token_name AS bucket_label';
      group = 'u.token_id, u.token_name';
    } else {
      bucket = 'u.model AS bucket_id, u.model AS bucket_label';
      group = 'u.model';
    }
    params.push(limit);
    const rows = await this.db.query<Row>(
      `SELECT ${bucket},
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN 1 ELSE 0 END), 0) AS consume_events,
        COALESCE(SUM(CASE WHEN u.log_type = 5 THEN 1 ELSE 0 END), 0) AS error_events,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.completion_tokens ELSE 0 END), 0) AS completion_tokens,
        COALESCE(SUM(CASE WHEN u.log_type = 2 THEN u.quota ELSE 0 END), 0) AS quota
       FROM usage_event u
       WHERE ${where}
       GROUP BY ${group}
       ORDER BY ${groupBy === 'day' ? 'bucket_id ASC' : 'prompt_tokens DESC'}
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      bucket_id: row.bucket_id === null || row.bucket_id === undefined ? null : String(row.bucket_id),
      bucket_label: strOrNull(row.bucket_label),
      consume_events: num(row.consume_events),
      error_events: num(row.error_events),
      prompt_tokens: num(row.prompt_tokens),
      completion_tokens: num(row.completion_tokens),
      quota: num(row.quota),
    }));
  }

  async captureStats(filter: UsageFilter): Promise<CaptureStats> {
    const rows = await this.db.query<Row>(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN capture_status = 'captured' THEN 1 ELSE 0 END), 0) AS captured,
        COALESCE(SUM(CASE WHEN capture_status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
        COALESCE(SUM(CASE WHEN capture_status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled,
        COALESCE(SUM(CASE WHEN capture_status = 'dropped' THEN 1 ELSE 0 END), 0) AS dropped,
        COALESCE(SUM(CASE WHEN capture_status = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
        COALESCE(SUM(CASE WHEN prompt_text IS NOT NULL THEN 1 ELSE 0 END), 0) AS prompt_stored
       FROM proxy_request
       WHERE deployment_id = $1 AND received_at >= $2 AND received_at < $3`,
      [this.deploymentId, filter.from, filter.to],
    );
    const row = rows[0] ?? {};
    return {
      total: num(row.total),
      captured: num(row.captured),
      skipped: num(row.skipped),
      disabled: num(row.disabled),
      dropped: num(row.dropped),
      expired: num(row.expired),
      prompt_stored: num(row.prompt_stored),
    };
  }

  async captureSkipReasons(filter: UsageFilter): Promise<Array<{ reason: string; count: number }>> {
    const rows = await this.db.query<Row>(
      `SELECT COALESCE(skip_reason, 'unknown') AS reason, COUNT(*) AS count
       FROM proxy_request
       WHERE deployment_id = $1 AND received_at >= $2 AND received_at < $3
         AND capture_status IN ('skipped', 'dropped')
       GROUP BY COALESCE(skip_reason, 'unknown')
       ORDER BY count DESC`,
      [this.deploymentId, filter.from, filter.to],
    );
    return rows.map((row) => ({ reason: String(row.reason), count: num(row.count) }));
  }

  async associationCounts(
    filter: UsageFilter,
    pendingWindowMs: number,
    now: Date = new Date(),
  ): Promise<AssociationCounts> {
    const pendingCutoff = new Date(now.getTime() - pendingWindowMs).toISOString();
    const rows = await this.db.query<Row>(
      `SELECT
        COALESCE(SUM(CASE WHEN p.newapi_request_id IS NULL OR p.newapi_request_id = '' THEN 1 ELSE 0 END), 0) AS no_gateway_id,
        COALESCE(SUM(CASE WHEN p.newapi_request_id IS NOT NULL AND p.newapi_request_id <> ''
          AND EXISTS (SELECT 1 FROM usage_event u WHERE u.deployment_id = p.deployment_id AND u.newapi_request_id = p.newapi_request_id)
          THEN 1 ELSE 0 END), 0) AS matched,
        COALESCE(SUM(CASE WHEN p.newapi_request_id IS NOT NULL AND p.newapi_request_id <> ''
          AND NOT EXISTS (SELECT 1 FROM usage_event u WHERE u.deployment_id = p.deployment_id AND u.newapi_request_id = p.newapi_request_id)
          AND p.received_at >= $4 THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN p.newapi_request_id IS NOT NULL AND p.newapi_request_id <> ''
          AND NOT EXISTS (SELECT 1 FROM usage_event u WHERE u.deployment_id = p.deployment_id AND u.newapi_request_id = p.newapi_request_id)
          AND p.received_at < $4 THEN 1 ELSE 0 END), 0) AS unmatched
       FROM proxy_request p
       WHERE p.deployment_id = $1 AND p.received_at >= $2 AND p.received_at < $3`,
      [this.deploymentId, filter.from, filter.to, pendingCutoff],
    );
    const row = rows[0] ?? {};
    return {
      matched: num(row.matched),
      pending: num(row.pending),
      unmatched: num(row.unmatched),
      no_gateway_id: num(row.no_gateway_id),
    };
  }

  async usageSourceCounts(filter: UsageFilter): Promise<Array<{ source: string; count: number }>> {
    const rows = await this.db.query<Row>(
      `SELECT usage_source AS source, COUNT(*) AS count
       FROM usage_event
       WHERE deployment_id = $1 AND created_at >= $2 AND created_at < $3 AND log_type = 2
       GROUP BY usage_source
       ORDER BY count DESC`,
      [this.deploymentId, filter.from, filter.to],
    );
    return rows.map((row) => ({ source: String(row.source), count: num(row.count) }));
  }

  async getSyncState(): Promise<SyncState | null> {
    const rows = await this.db.query<Row>(
      'SELECT * FROM sync_state WHERE deployment_id = $1',
      [this.deploymentId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      deployment_id: String(row.deployment_id),
      watermark: strOrNull(row.watermark),
      last_run_at: strOrNull(row.last_run_at),
      last_success_at: strOrNull(row.last_success_at),
      last_error: strOrNull(row.last_error),
      events_total: num(row.events_total),
    };
  }

  async saveSyncState(state: SyncState): Promise<void> {
    await this.db.execute(
      `INSERT INTO sync_state (deployment_id, watermark, last_run_at, last_success_at, last_error, events_total)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (deployment_id) DO UPDATE SET
         watermark = excluded.watermark,
         last_run_at = excluded.last_run_at,
         last_success_at = excluded.last_success_at,
         last_error = excluded.last_error,
         events_total = excluded.events_total`,
      [
        state.deployment_id,
        state.watermark,
        state.last_run_at,
        state.last_success_at,
        state.last_error,
        state.events_total,
      ],
    );
  }

  async countUsageEvents(): Promise<number> {
    const rows = await this.db.query<Row>(
      'SELECT COUNT(*) AS count FROM usage_event WHERE deployment_id = $1',
      [this.deploymentId],
    );
    return num(rows[0]?.count);
  }

  async expirePrompts(cutoffIso: string): Promise<number> {
    return this.db.execute(
      `UPDATE proxy_request
       SET prompt_text = NULL, capture_status = 'expired', skip_reason = 'retention_expired'
       WHERE deployment_id = $1 AND prompt_text IS NOT NULL AND received_at < $2`,
      [this.deploymentId, cutoffIso],
    );
  }

  async audit(principal: string, action: string, detail: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO admin_audit (audit_id, occurred_at, principal, action, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), new Date().toISOString(), principal, action, detail],
    );
  }

  async countAudit(): Promise<number> {
    const rows = await this.db.query<Row>('SELECT COUNT(*) AS count FROM admin_audit');
    return num(rows[0]?.count);
  }

  async raw<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.query<T>(sql, params);
  }

  async rawTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
}
