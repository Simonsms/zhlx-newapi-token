export type TransportOutcome =
  | 'completed'
  | 'client_cancel'
  | 'upstream_error'
  | 'timeout'
  | 'proxy_error'
  | 'no_response';

export type CaptureStatus = 'disabled' | 'captured' | 'skipped' | 'dropped' | 'expired';

export type UsageSource = 'reported' | 'estimated' | 'missing';

export type AssociationStatus = 'matched' | 'pending' | 'unmatched' | 'no_gateway_id';

export interface ProxyRequestInsert {
  proxy_request_id: string;
  deployment_id: string;
  newapi_request_id: string | null;
  received_at: string;
  method: string;
  path: string;
  http_status: number | null;
  transport_outcome: TransportOutcome;
  capture_status: CaptureStatus;
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
}

export interface UsageEventInsert {
  source_key: string;
  deployment_id: string;
  source_id: string | null;
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
  usage_source: UsageSource;
  raw: string;
  synced_at: string;
}

export interface ProxyRequestRecord extends ProxyRequestInsert {
  usage_event_count: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  quota: number | null;
  association_status: AssociationStatus;
}

export interface UsageEventRecord {
  source_key: string;
  source_id: string | null;
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
  usage_source: UsageSource;
}

export interface ProxyRequestFilter {
  from: string;
  to: string;
  userId?: number | null;
  tokenId?: number | null;
  model?: string | null;
  status?: AssociationStatus | null;
  query?: string | null;
  page: number;
  pageSize: number;
}

export interface UsageFilter {
  from: string;
  to: string;
  userId?: number | null;
  tokenId?: number | null;
  model?: string | null;
}

export interface IdentityStats {
  distinct_users: number;
  distinct_tokens: number;
  mode: 'user' | 'token';
}

export interface UsageTotals {
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

export interface BreakdownRow {
  bucket_id: string | null;
  bucket_label: string | null;
  consume_events: number;
  error_events: number;
  prompt_tokens: number;
  completion_tokens: number;
  quota: number;
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
  deployment_id: string;
  watermark: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  events_total: number;
}
