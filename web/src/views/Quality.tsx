import type { ReactNode } from 'react';
import { api, type CaptureQuality, type Overview } from '../api';
import { Bars, Card, Stat, Tag } from '../components';
import {
  OUTCOME_NAMES,
  SKIP_REASON_NAMES,
  bytes,
  num,
  rangeQuery,
  shortTime,
  type Range,
} from '../format';
import { useFetch } from '../hooks';

export function QualityView({ range }: { range: Range }): ReactNode {
  const query = rangeQuery(range);
  const quality = useFetch<CaptureQuality>(() => api<CaptureQuality>(`api/capture-quality?${query}`), [query]);
  const overview = useFetch<Overview>(() => api<Overview>(`api/overview?${query}`), [query]);

  if (quality.error) return <div className="error-box">加载失败：{quality.error}</div>;
  const data = quality.data;
  if (!data) return <div className="card">正在加载…</div>;

  const outcomeRows = OUTCOME_NAMES.map((entry) => ({
    label: entry.name,
    value: data.outcomes[entry.key],
    total: data.capture.total,
  }));
  const skipRows = data.skip_reasons.map((row) => ({
    label: SKIP_REASON_NAMES[row.reason] ?? row.reason,
    value: row.count,
    total: data.capture.total,
  }));
  const totalRequests = data.capture.total;
  const association = data.association;
  const sync = overview.data?.sync ?? null;

  return (
    <>
      <Card
        title="正文结果分布"
        extra={<Tag tone={data.capture_enabled ? 'good' : 'plain'}>{data.capture_enabled ? '采集已启用' : '采集已关闭'}</Tag>}
        note={`分母为 ${num(totalRequests)} 条进入采集范围的推理请求。主动省略、资源受限与系统故障分开计数；历史 extract-v1 记录按原含义展示。`}
      >
        <div className="stats">
          {OUTCOME_NAMES.map((entry) => (
            <Stat
              key={entry.key}
              name={entry.name}
              value={num(data.outcomes[entry.key])}
              hint={entry.hint || undefined}
            />
          ))}
        </div>
      </Card>

      <div className="panes">
        <Card title="请求体计量">
          <div className="stats">
            <Stat name="观察合计" value={bytes(data.request_bytes.observed_bytes)} hint="不含 HTTP 头" />
            <Stat name="最大单请求" value={bytes(data.request_bytes.max_bytes)} />
            <Stat name="读取完整" value={num(data.request_bytes.complete)} />
            <Stat name="未读完" value={num(data.request_bytes.incomplete)} hint="取消或提前结束" />
          </div>
          <p className="note">
            字节数来自实际收到的数据块，不使用 Content-Length，也不等于 Token。
            {data.extraction_versions.length
              ? ` 提取版本：${data.extraction_versions.map((row) => `${row.version} ${row.count} 条`).join('，')}。`
              : ''}
          </p>
        </Card>

        <Card title="关联状态">
          <div className="stats">
            <Stat name="已匹配" value={num(association.matched)} />
            <Stat name="等待日志" value={num(association.pending)} />
            <Stat name="未匹配" value={num(association.unmatched)} />
            <Stat name="无网关 ID" value={num(association.no_gateway_id)} />
          </div>
          {sync ? (
            <p className="note">
              同步水位 {shortTime(sync.watermark)}，上次成功 {shortTime(sync.last_success_at)}
              {sync.last_error ? `，最近错误：${sync.last_error}` : '，同步运行正常'}。
            </p>
          ) : null}
        </Card>
      </div>

      <div className="panes">
        <Card title="正文结果构成">
          <Bars rows={outcomeRows} />
        </Card>
        <Card title="跳过原因" note="主动省略（附件／工具／无文本）与资源受限、系统故障应分别看待。">
          {skipRows.length ? <Bars rows={skipRows} /> : <div className="empty">区间内没有跳过的请求</div>}
        </Card>
      </div>
    </>
  );
}
