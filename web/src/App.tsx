import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onUnauthorized, post, type Session } from './api';
import { rangeOf, toLocalInput, fromLocalInput, type Range } from './format';
import { Login } from './views/Login';
import { OverviewView } from './views/Overview';
import { RequestsView } from './views/Requests';
import { ScenesView } from './views/Scenes';
import { QualityView } from './views/Quality';

type ViewKey = 'overview' | 'requests' | 'scenes' | 'quality';

const NAV: Array<{ key: ViewKey; name: string; hint: string }> = [
  { key: 'overview', name: '概览', hint: '总量、采集、同步' },
  { key: 'requests', name: '请求检索', hint: '筛选、明细、脱敏文本' },
  { key: 'scenes', name: '场景分析', hint: '分类覆盖率与分布' },
  { key: 'quality', name: '数据质量', hint: '跳过原因与计量' },
];

const PRESETS: Array<{ name: string; hours: number }> = [
  { name: '24 小时', hours: 24 },
  { name: '7 天', hours: 24 * 7 },
  { name: '30 天', hours: 24 * 30 },
];

export function App(): ReactNode {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [view, setView] = useState<ViewKey>('overview');
  const [range, setRange] = useState<Range>(() => rangeOf(24));

  useEffect(() => {
    onUnauthorized(() => setSession(null));
    api<Session>('session')
      .then((value) => setSession(value))
      .catch(() => setSession(null))
      .finally(() => setChecked(true));
  }, []);

  const setPreset = useCallback((hours: number) => setRange(rangeOf(hours)), []);

  const rangeBar = useMemo(() => (
    <div className="range-bar">
      <div>
        <label htmlFor="range-from">开始</label>
        <input
          id="range-from"
          type="datetime-local"
          value={toLocalInput(range.from)}
          onChange={(event) => {
            const value = fromLocalInput(event.target.value);
            if (value) setRange({ ...range, from: value });
          }}
        />
      </div>
      <div>
        <label htmlFor="range-to">结束</label>
        <input
          id="range-to"
          type="datetime-local"
          value={toLocalInput(range.to)}
          onChange={(event) => {
            const value = fromLocalInput(event.target.value);
            if (value) setRange({ ...range, to: value });
          }}
        />
      </div>
      <div className="presets">
        {PRESETS.map((preset) => (
          <button key={preset.name} className="ghost" type="button" onClick={() => setPreset(preset.hours)}>
            {preset.name}
          </button>
        ))}
      </div>
    </div>
  ), [range, setPreset]);

  if (!checked) return <div className="login-wrap"><span className="muted">正在加载…</span></div>;
  if (!session) return <Login configured onDone={(value) => setSession(value)} />;
  if (!session.configured) {
    return (
      <Login
        configured={false}
        onDone={(value) => setSession(value)}
      />
    );
  }

  const logout = async (): Promise<void> => {
    await post<{ ok: boolean }>('logout', {}).catch(() => undefined);
    setSession(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>New API 用量与 Prompt 采集</h1>
          <span className="sub">{session.deployment_id}</span>
        </div>
        <div className="right">
          <span className="status">
            <span className={session.captured_enabled ? 'dot' : 'dot off'} />
            {session.captured_enabled ? 'Prompt 采集已启用' : 'Prompt 采集已关闭'}
          </span>
          <button className="ghost" type="button" onClick={() => void logout()}>退出</button>
        </div>
      </header>

      <div className="layout">
        <nav className="sidebar" aria-label="管理视图">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item ${view === item.key ? 'active' : ''}`}
              aria-current={view === item.key ? 'page' : undefined}
              onClick={() => setView(item.key)}
            >
              {item.name}
              <span className="hint">{item.hint}</span>
            </button>
          ))}
        </nav>

        <main className="content">
          <div className="card">{rangeBar}</div>
          {view === 'overview' ? <OverviewView range={range} /> : null}
          {view === 'requests' ? <RequestsView range={range} /> : null}
          {view === 'scenes' ? <ScenesView range={range} /> : null}
          {view === 'quality' ? <QualityView range={range} /> : null}
        </main>
      </div>
    </div>
  );
}
