import { useState, type ReactNode } from 'react';
import { api, type ClassificationStats, type UsageResponse } from '../api';
import { Bars, Card, Stat } from '../components';
import { LABEL_NAMES, num, rangeQuery, type Range } from '../format';
import { useFetch } from '../hooks';

type GroupBy = 'identity' | 'day' | 'user' | 'token' | 'model';

export function ScenesView({ range }: { range: Range }): ReactNode {
  const query = rangeQuery(range);
  const stats = useFetch<ClassificationStats>(() => api<ClassificationStats>(`api/classification?${query}`), [query]);
  const [groupBy, setGroupBy] = useState<GroupBy>('identity');
  const usage = useFetch<UsageResponse>(
    () => api<UsageResponse>(`api/usage?${rangeQuery(range, { group_by: groupBy })}`),
    [range.from, range.to, groupBy],
  );

  if (stats.error) return <div className="error-box">加载失败：{stats.error}</div>;
  const data = stats.data;
  if (!data) return <div className="card">正在加载…</div>;

  const labelRows = data.labels.map((row) => ({
    label: LABEL_NAMES[row.label] ?? row.label,
    value: row.count,
    total: data.classified,
    suffix: data.classified > 0 ? ` · ${Math.round((row.count / data.classified) * 1000) / 10}%` : '',
  }));

  const breakdown = usage.data?.breakdown ?? [];
  const groups = (usage.data?.group_by ?? groupBy) as string;

  return (
    <>
      <Card
        title="分类覆盖"
        extra={<span className="mono muted tiny">分类器：{data.enabled ? data.mode : '未启用'}</span>}
        note="分母是区间内有正文的请求。未分类、失败与待复核单独计数，不合并成“采集失败”。"
      >
        <div className="stats">
          <Stat name="有正文" value={num(data.with_prompt)} hint="分母" />
          <Stat name="已分类" value={num(data.classified)} hint={`覆盖率 ${data.coverage}%`} />
          <Stat name="未分类" value={num(data.unclassified)} />
          <Stat name="分类失败" value={num(data.failed)} />
          <Stat name="待复核" value={num(data.review)} hint="低置信或规则并列" />
        </div>
        {!data.enabled ? (
          <p className="note">设置 CLASSIFIER_MODE=keyword 或 llm 后，后台会按批次处理历史与新增正文。</p>
        ) : null}
      </Card>

      <div className="panes">
        <Card title="场景分布" note="场景比例只代表已分类请求的分布，不等于员工时间占比，也不是用户意图事实。">
          {labelRows.length ? <Bars rows={labelRows} /> : <div className="empty">区间内暂无已分类请求</div>}
          {data.versions.length ? (
            <p className="note">
              分类器版本：{data.versions.map((row) => `${row.version} ${row.count} 条`).join('，')}
            </p>
          ) : null}
        </Card>

        <Card
          title="用量分组"
          extra={(
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
              <option value="identity">按人员（自动口径）</option>
              <option value="day">按天</option>
              <option value="user">按账号</option>
              <option value="token">按凭证</option>
              <option value="model">按模型</option>
            </select>
          )}
          note="分组维度是网关用量，不是场景用量；两者分母不同，不能互相推算。"
        >
          {usage.error ? <div className="error-box">加载失败：{usage.error}</div> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{groups === 'day' ? '日期' : groups === 'user' ? '账号' : groups === 'token' ? '凭证' : '模型'}</th>
                  <th className="num">消费事件</th>
                  <th className="num">输入</th>
                  <th className="num">输出</th>
                  <th className="num">额度</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row) => (
                  <tr key={`${row.bucket_id}-${row.bucket_label}`}>
                    <td className="truncate" style={{ maxWidth: 160 }}>{row.bucket_label ?? row.bucket_id ?? '—'}</td>
                    <td className="num">{num(row.consume_events)}</td>
                    <td className="num">{num(row.prompt_tokens)}</td>
                    <td className="num">{num(row.completion_tokens)}</td>
                    <td className="num">{num(row.quota)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {breakdown.length === 0 && !usage.loading ? <div className="empty">区间内暂无用量</div> : null}
        </Card>
      </div>
    </>
  );
}
