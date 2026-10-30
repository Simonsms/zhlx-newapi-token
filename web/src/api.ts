export const BASE = location.pathname.replace(/\/+$/, '') + '/';

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export class Unauthorized extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'Unauthorized';
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { credentials: 'same-origin', ...init });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Unauthorized();
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* 非 JSON 错误体保持状态码 */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface Session {
  authenticated: boolean;
  configured: boolean;
  captured_enabled: boolean;
  deployment_id: string;
}

export interface Totals {
  consume_events: number;
  error_events: number;
  refund_events: number;
  prompt_tokens: number;
  completion_tokens: number;
  quota: number;
  estimated_events: number;
  missing_events: number;
  active_users: number;
  active_tokens: number;
  model_count: number;
}

export interface Overview {
  from: string;
  to: string;
  deployment_id: string;
  capture_enabled: boolean;
  identity_mode: 'user' | 'token';
  identity_configured: string;
  identity_stats: { distinct_users: number; distinct_tokens: number };
  totals: Totals;
  captured_totals: Totals;
  capture: CaptureStats;
  association: AssociationCounts;
  usage_sources: Array<{ source: string; count: number }>;
  sync: SyncState | null;
  metrics: {
    metadata_dropped: number;
    content_dropped: number;
    write_errors: number;
    last_write_error: string | null;
    started_at: string;
  };
}

export interface CaptureStats {
  total: number;
  captured: number;
  skipped: number;
  disabled: number;
  dropped: number;
  expired: number;
  prompt_stored: number;
}

export interface AssociationCounts {
  matched: number;
  pending: number;
  unmatched: number;
  no_gateway_id: number;
}

export interface SyncState {
  watermark: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  events_total: number;
}

export interface BreakdownRow {
  bucket_id: string | null;
  bucket_label: string | null;
  consume_events: number;
  error_events: number;
  prompt_tokens: number;
  completion_tokens: number;
  quota: number;
}

export interface UsageResponse {
  group_by: 'day' | 'user' | 'token' | 'model';
  identity_mode: 'user' | 'token';
  identity_configured: string;
  totals: Totals;
  breakdown: BreakdownRow[];
}

export interface ContentSummary {
  attachment_count: number;
  attachment_types: string[];
  has_tool_result: boolean;
  has_unknown_content: boolean;
  unknown_types: string[];
  declared_bytes: number | null;
}

export interface ProxyRequest {
  proxy_request_id: string;
  newapi_request_id: string | null;
  received_at: string;
  method: string;
  path: string;
  http_status: number | null;
  transport_outcome: string;
  capture_status: string;
  skip_reason: string | null;
  prompt_text: string | null;
  prompt_scope: string | null;
  prompt_chars: number | null;
  prompt_truncated: number;
  extraction_version: string | null;
  redaction_version: string | null;
  model: string | null;
  is_stream: number | null;
  duration_ms: number | null;
  request_bytes: number | null;
  request_bytes_complete: number | null;
  content_summary: ContentSummary | null;
  usage_event_count: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  quota: number | null;
  association_status: 'matched' | 'pending' | 'unmatched' | 'no_gateway_id';
  classification_status: 'unclassified' | 'classified' | 'failed';
  classification_label: string | null;
  classifier_version: string | null;
  classification_confidence: number | null;
  classification_review: number;
  classified_at: string | null;
}

export interface UsageEvent {
  source_key: string;
  newapi_request_id: string | null;
  log_type: number;
  created_at: string;
  user_id: number | null;
  username: string | null;
  token_id: number | null;
  token_name: string | null;
  model: string | null;
  channel: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  quota: number | null;
  usage_source: string;
}

export interface RequestsResponse {
  from: string;
  to: string;
  page: number;
  page_size: number;
  total: number;
  items: ProxyRequest[];
}

export interface RequestDetail {
  request: ProxyRequest;
  usage_events: UsageEvent[];
}

export interface CaptureQuality {
  from: string;
  to: string;
  capture_enabled: boolean;
  capture: CaptureStats;
  skip_reasons: Array<{ reason: string; count: number }>;
  association: AssociationCounts;
  outcomes: {
    text: number;
    excerpt: number;
    metadata: number;
    limit: number;
    failure: number;
    disabled: number;
    dropped: number;
    expired: number;
  };
  request_bytes: { observed_bytes: number; complete: number; incomplete: number; max_bytes: number };
  extraction_versions: Array<{ version: string; count: number }>;
}

export interface ClassificationStats {
  from: string;
  to: string;
  enabled: boolean;
  mode: 'off' | 'keyword' | 'llm';
  with_prompt: number;
  classified: number;
  unclassified: number;
  failed: number;
  review: number;
  coverage: number;
  labels: Array<{ label: string; count: number }>;
  versions: Array<{ version: string; count: number }>;
}
