import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type RequestDetail, type RequestsResponse } from '../api';
import { Card, Empty, Tag } from '../components';
import {
  ASSOCIATION_NAMES,
  LABELS,
  LABEL_NAMES,
  bodyOutcome,
  bytes,
  num,
  rangeQuery,
  shortTime,
  time,
  type Range,
} from '../format';
import { useFetch } from '../hooks';
import { PromptViewer } from './PromptViewer';

interface Filters {
  userId: string;
  tokenId: string;
  model: string;
  status: string;
  label: string;
  review: boolean;
  q: string;
}

const EMPTY_FILTERS: Filters = {
  userId: '',
  tokenId: '',
  model: '',
  status: '',
  label: '',
  review: false,
  q: '',
};

export function RequestsView({ range }: { range: Range }): ReactNode {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const pageSize = 25;

  useEffect(() => {
    if (!selected) return;
    const node = detailRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      node.scrollIntoView({ block: 'start' });
    }
  }, [selected]);

  const query = rangeQuery(range, {
    user_id: filters.userId,
    token_id: filters.tokenId,
    model: filters.model,
    status: filters.status,
    label: filters.label,
    review: filters.review ? '1' : '',
    q: filters.q,
    page,
    page_size: pageSize,
  });

  const list = useFetch<RequestsResponse>(() => api<RequestsResponse>(`api/requests?${query}`), [query]);

  useEffect(() => {
    setPage(1);
  }, [filters, range]);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <Card>
        <div className="filters">
          <div>
            <label htmlFor="f-user">账号 ID</label>
            <input
              id="f-user"
              type="number"
              placeholder="全部"
              style={{ width: 96 }}
              value={filters.userId}
              onChange={(event) => setFilters({ ...filters, userId: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="f-token">凭证 ID</label>
            <input
              id="f-token"
              type="number"
              placeholder="全部"
              style={{ width: 96 }}
              value={filters.tokenId}
              onChange={(event) => setFilters({ ...filters, tokenId: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="f-model">模型</label>
            <input
              id="f-model"
              placeholder="全部"
              style={{ width: 150 }}
              value={filters.model}
              onChange={(event) => setFilters({ ...filters, model: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="f-status">关联</label>
            <select
              id="f-status"
              value={filters.status}
              onChange={(event) => setFilters({ ...filters, status: event.target.value })}
            >
              <option value="">全部</option>
              <option value="matched">已匹配</option>
              <option value="pending">等待日志</option>
              <option value="unmatched">未匹配</option>
              <option value="no_gateway_id">无网关 ID</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-label">场景</label>
            <select
              id="f-label"
              value={filters.label}
              onChange={(event) => setFilters({ ...filters, label: event.target.value })}
            >
              <option value="">全部</option>
              {LABELS.map((label) => (
                <option key={label} value={label}>{LABEL_NAMES[label]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-q">Prompt 关键字</label>
            <input
              id="f-q"
              placeholder="已保存的脱敏文本"
              style={{ width: 190 }}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
          </div>
          <div className="actions">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0, textTransform: 'none', letterSpacing: 0 }}>
              <input
                type="checkbox"
                checked={filters.review}
                onChange={(event) => setFilters({ ...filters, review: event.target.checked })}
              />
              仅待复核
            </label>
            <button className="ghost" type="button" onClick={() => { setFilters(EMPTY_FILTERS); list.reload(); }}>
              清空
            </button>
            <button className="primary" type="button" onClick={() => list.reload()}>刷新</button>
          </div>
        </div>
        <p className="note">
          关键字只匹配已保存的脱敏正文：头尾节选被省略的中间部分、以及仅元数据的记录都搜不到。共 {num(total)} 条。
        </p>
      </Card>

      <div className="panes">
        <Card title="采集请求" extra={<span className="mono muted tiny">点击一行查看详情</span>}>
          {list.error ? <div className="error-box">加载失败：{list.error}</div> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>接口</th>
                  <th>模型</th>
                  <th>正文</th>
                  <th>场景</th>
                  <th>关联</th>
                  <th className="num" style={{ width: 84 }}>字节</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const outcome = bodyOutcome(item);
                  const assoc = ASSOCIATION_NAMES[item.association_status] ?? { text: item.association_status, tone: 'plain' as const };
                  return (
                    <tr
                      key={item.proxy_request_id}
                      className={`clickable ${selected === item.proxy_request_id ? 'selected' : ''}`}
                      tabIndex={0}
                      onClick={() => setSelected(item.proxy_request_id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelected(item.proxy_request_id);
                        }
                      }}
                    >
                      <td className="mono nowrap">{shortTime(item.received_at)}</td>
                      <td className="mono nowrap">{item.path}</td>
                      <td className="truncate" style={{ maxWidth: 150 }} title={item.model ?? ''}>{item.model ?? '—'}</td>
                      <td>
                        <Tag tone={outcome.tone}>{outcome.text}</Tag>
                      </td>
                      <td>
                        {item.classification_status === 'classified' && item.classification_label
                          ? <Tag tone={item.classification_review ? 'warn' : 'good'}>{LABEL_NAMES[item.classification_label] ?? item.classification_label}</Tag>
                          : <span className="muted tiny">{item.classification_status === 'failed' ? '分类失败' : '未分类'}</span>}
                      </td>
                      <td><Tag tone={assoc.tone}>{assoc.text}</Tag></td>
                      <td className="num">{bytes(item.request_bytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!list.loading && items.length === 0 ? <Empty>没有符合条件的请求</Empty> : null}
          <div className="pager">
            <span className="mono muted tiny">第 {page} / {pages} 页</span>
            <button className="ghost" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <button className="ghost" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </Card>

        <div ref={detailRef}>
          <DetailPanel id={selected} onClose={() => setSelected(null)} />
        </div>
      </div>
    </>
  );
}

function DetailPanel({ id, onClose }: { id: string | null; onClose: () => void }): ReactNode {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setError('');
    api<RequestDetail>(`api/requests/${encodeURIComponent(id)}`)
      .then((value) => {
        if (alive) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (alive && (cause as Error).message !== 'unauthorized') setError((cause as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id) {
    return (
      <Card title="请求详情">
        <Empty>从左侧选择一条请求查看脱敏文本与关联用量</Empty>
      </Card>
    );
  }

  const request = detail?.request;
  return (
    <div className="detail-sticky">
    <Card
      title="请求详情"
      extra={<button className="ghost" type="button" onClick={onClose}>关闭</button>}
      note={request ? `本地请求 ID：${request.proxy_request_id}` : undefined}
    >
      {error ? <div className="error-box">加载失败：{error}</div> : null}
      {!request ? <div className="muted">正在加载…</div> : (
        <>
          <div className="kv"><span className="k">网关请求 ID</span><span className="n">{request.newapi_request_id ?? '无'}</span></div>
          <div className="kv"><span className="k">HTTP</span><span className="n">{request.http_status ?? '—'}</span></div>
          <div className="kv"><span className="k">传输终态</span><span className="n">{request.transport_outcome}</span></div>
          <div className="kv"><span className="k">采集</span><span className="n">{request.capture_status}{request.skip_reason ? `（${request.skip_reason}）` : ''}</span></div>
          <div className="kv"><span className="k">提取范围</span><span className="n">{request.prompt_scope ?? '—'}</span></div>
          <div className="kv"><span className="k">提取版本</span><span className="n">{request.extraction_version ?? '—'} / {request.redaction_version ?? '—'}</span></div>
          <div className="kv"><span className="k">请求体</span><span className="n">{bytes(request.request_bytes)}{request.request_bytes_complete ? '' : '（未读完）'}</span></div>
          <div className="kv"><span className="k">耗时</span><span className="n">{request.duration_ms ?? 0} ms</span></div>
          <div className="kv">
            <span className="k">场景</span>
            <span className="n">
              {request.classification_status === 'classified'
                ? `${LABEL_NAMES[request.classification_label ?? ''] ?? request.classification_label}（${request.classification_confidence ?? '—'}%）`
                : request.classification_status === 'failed' ? '分类失败' : '未分类'}
            </span>
          </div>

          {request.content_summary ? (
            <p className="note">
              内容概要：附件 {request.content_summary.attachment_count} 个
              {request.content_summary.attachment_types.length ? `（${request.content_summary.attachment_types.join('、')}）` : ''}
              {request.content_summary.has_tool_result ? '；含工具结果（正文不保存）' : ''}
              {request.content_summary.has_unknown_content ? `；含未知块 ${request.content_summary.unknown_types.join('、') || '未识别'}` : ''}
            </p>
          ) : null}

          <h2 style={{ marginTop: 18 }}>脱敏用户文本</h2>
          <PromptViewer
            text={request.prompt_text}
            scope={request.prompt_scope}
            chars={request.prompt_chars}
            truncated={request.prompt_truncated}
            extractionVersion={request.extraction_version}
            redactionVersion={request.redaction_version}
          />
          <p className="note" style={{ marginTop: 8 }}>
            这里保存的是该请求最后一条 user 输入。客户端可能在其中注入自身上下文（例如 system-reminder），
            因此文本不等于用户逐字输入；绿色标记为脱敏替换，斜体标记为头尾节选省略。
          </p>

          <h2 style={{ marginTop: 18 }}>原生消费事件</h2>
          {detail.usage_events.length === 0 ? <Empty>暂无原生消费事件</Empty> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>时间</th>
                    <th>账号/凭证</th>
                    <th className="num">输入</th>
                    <th className="num">输出</th>
                    <th className="num">额度</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.usage_events.map((event) => (
                    <tr key={event.source_key}>
                      <td>{event.log_type === 2 ? '消费' : event.log_type === 5 ? '错误' : event.log_type === 6 ? '退款' : event.log_type}</td>
                      <td className="mono">{shortTime(event.created_at)}</td>
                      <td>{(event.username ?? event.user_id ?? '—')} / {(event.token_name ?? event.token_id ?? '—')}</td>
                      <td className="num">{num(event.prompt_tokens)}</td>
                      <td className="num">{num(event.completion_tokens)}</td>
                      <td className="num">{num(event.quota)}</td>
                      <td>{event.usage_source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note">读取正文会写入管理员审计记录。时间：{time(request.received_at)}</p>
        </>
      )}
    </Card>
    </div>
  );
}
