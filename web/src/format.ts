export const LABEL_NAMES: Record<string, string> = {
  code_dev: '代码开发',
  doc_writing: '文档写作',
  knowledge_qa: '知识问答',
  data_analysis: '数据分析',
  translation: '翻译润色',
  other: '其他',
};

export const LABELS = Object.keys(LABEL_NAMES);

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN');
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未记录';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function time(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function shortTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export interface Range {
  from: string;
  to: string;
}

export function rangeOf(hours: number): Range {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function rangeQuery(range: Range, extra?: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function bodyOutcome(item: {
  capture_status: string;
  skip_reason: string | null;
  prompt_truncated: number;
}): { text: string; tone: 'good' | 'warn' | 'bad' | 'plain' } {
  if (item.capture_status === 'captured') {
    return item.prompt_truncated ? { text: '已截断', tone: 'warn' } : { text: '已采集文本', tone: 'good' };
  }
  if (item.capture_status === 'disabled') return { text: '采集关闭', tone: 'plain' };
  if (item.capture_status === 'expired') return { text: '已过期', tone: 'plain' };
  if (item.capture_status === 'dropped') return { text: '资源受限', tone: 'bad' };
  const reason = item.skip_reason ?? '';
  if (['over_limit', 'capture_budget_exhausted', 'incomplete_request_body'].includes(reason)) {
    return { text: '资源受限', tone: 'bad' };
  }
  if (['invalid_json', 'redaction_failed'].includes(reason)) return { text: '采集故障', tone: 'bad' };
  if (['upstream_status', 'no_upstream_response'].includes(reason)) return { text: '上游未成功', tone: 'warn' };
  return { text: '仅元数据', tone: 'warn' };
}

export const ASSOCIATION_NAMES: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' | 'plain' }> = {
  matched: { text: '已匹配', tone: 'good' },
  pending: { text: '等待日志', tone: 'warn' },
  unmatched: { text: '未匹配', tone: 'bad' },
  no_gateway_id: { text: '无网关 ID', tone: 'bad' },
};

export const OUTCOME_NAMES: Array<{ key: keyof OutcomeCounts; name: string; hint: string }> = [
  { key: 'text', name: '已采集文本', hint: '完整保存' },
  { key: 'excerpt', name: '已截断节选', hint: '头尾节选' },
  { key: 'metadata', name: '仅元数据', hint: '附件／工具／无文本' },
  { key: 'limit', name: '资源受限', hint: '超限或预算不足' },
  { key: 'failure', name: '采集故障', hint: '解析或脱敏失败' },
  { key: 'disabled', name: '采集关闭', hint: '' },
  { key: 'dropped', name: '队列丢弃', hint: '' },
  { key: 'expired', name: '已过期', hint: '' },
];

export interface OutcomeCounts {
  text: number;
  excerpt: number;
  metadata: number;
  limit: number;
  failure: number;
  disabled: number;
  dropped: number;
  expired: number;
}

export const SKIP_REASON_NAMES: Record<string, string> = {
  over_limit: '超过单请求上限',
  capture_budget_exhausted: '并发预算不足',
  incomplete_request_body: '请求体未读完',
  invalid_json: '请求体不是有效 JSON',
  redaction_failed: '脱敏失败',
  upstream_status: '上游返回非 2xx',
  no_upstream_response: '上游无响应',
  tool_result_only: '仅工具结果',
  attachment_only: '仅附件',
  unknown_content_only: '仅未知内容块',
  no_user_text: '无用户文本',
  route_not_in_scope: '不在采集范围',
  unsupported_content_type: '不支持的内容类型',
  unsupported_content_encoding: '不支持的内容编码',
  queue_full: '队列已满',
  retention_expired: '超过保留期',
};
