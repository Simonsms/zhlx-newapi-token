import type { ReactNode } from 'react';
import { api, type Overview, type UsageResponse } from '../api';
import { Bars, Card, Stat } from '../components';
import { num, rangeQuery, shortTime, time, type Range } from '../format';
import { useFetch } from '../hooks';

export function OverviewView({ range }: { range: Range }): ReactNode {
  const query = rangeQuery(range);
  const overview = useFetch<Overview>(() => api<Overview>(`api/overview?${query}`), [query]);
  const usage = useFetch<UsageResponse>(() => api<UsageResponse>(`api/usage?${query}&group_by=day`), [query]);

  if (overview.error) return <div className="error-box">加载失败：{overview.error}</div>;
  const data = overview.data;
  if (!data) return <div className="card">正在加载…</div>;

  const { totals, capture, association, sync } = data;
  const coverage = capture.total > 0 ? Math.round((capture.prompt_stored / capture.total) * 1000) / 10 : 0;
  const mode = data.identity_mode === 'token' ? '按凭证（Key）' : '按账号';
  const trend = (usage.data?.breakdown ?? []).map((row) => ({
    label: row.bucket_label ?? row.bucket_id ?? '—',
    value: row.prompt_tokens,
    total: totals.prompt_tokens,
  }));

  return (
    <>
      <Card title="全量原生日志用量">
        <div className="stats">
          <Stat name="消费事件" value={num(totals.consume_events)} hint="调用口径另见请求检索" />
          <Stat name="错误事件" value={num(totals.error_events)} />
          <Stat name="输入 Token" value={num(totals.prompt_tokens)} />
          <Stat name="输出 Token" value={num(totals.completion_tokens)} />
          <Stat name="网关额度" value={num(totals.quota)} hint="非供应商现金成本" />
          <Stat name="账号数" value={num(totals.active_users)} />
          <Stat name="凭证数" value={num(totals.active_tokens)} />
          <Stat name="估算用量" value={num(totals.estimated_events)} hint="本地估算" />
          <Stat name="缺失用量" value={num(totals.missing_events)} hint="不记为零" />
        </div>
        <p className="note">
          人员归属：{mode}（配置 {data.identity_configured}；区间内 {data.identity_stats.distinct_users} 个账号、
          {data.identity_stats.distinct_tokens} 个凭证）。有 Prompt 子集输入 Token：{num(data.captured_totals.prompt_tokens)}。
        </p>
      </Card>

      <Card title="采集与关联">
        <div className="stats">
          <Stat name="入口请求" value={num(capture.total)} />
          <Stat name="已存 Prompt" value={num(capture.prompt_stored)} hint={`覆盖率 ${coverage}%`} />
          <Stat name="已采集" value={num(capture.captured)} />
          <Stat name="已跳过" value={num(capture.skipped)} />
          <Stat name="队列丢弃" value={num(capture.dropped)} />
          <Stat name="已匹配" value={num(association.matched)} />
          <Stat name="等待日志" value={num(association.pending)} />
          <Stat name="未匹配" value={num(association.unmatched)} />
          <Stat name="无网关 ID" value={num(association.no_gateway_id)} />
        </div>
      </Card>

      <div className="panes">
        <Card title="按天输入 Token" note="只反映网关侧输入 Token，不是人工输入字数，也不等于用户生产力。">
          {trend.length ? <Bars rows={trend} /> : <div className="empty">区间内暂无用量</div>}
        </Card>
        <Card title="日志同步">
          {sync ? (
            <>
              <div className="kv"><span className="k">累计事件</span><span className="n">{num(sync.events_total)}</span></div>
              <div className="kv"><span className="k">同步水位</span><span className="n">{time(sync.watermark)}</span></div>
              <div className="kv"><span className="k">上次成功</span><span className="n">{shortTime(sync.last_success_at)}</span></div>
              <div className="kv"><span className="k">最近错误</span><span className="n">{sync.last_error ?? '无'}</span></div>
            </>
          ) : (
            <div className="empty">同步未运行</div>
          )}
          <p className="note">
            采集队列丢元数据 {num(data.metrics.metadata_dropped)}、丢正文 {num(data.metrics.content_dropped)}，
            写库错误 {num(data.metrics.write_errors)}。请求体字节计量见「数据质量」。
          </p>
        </Card>
      </div>
    </>
  );
}
