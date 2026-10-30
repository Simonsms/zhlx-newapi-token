import type { ReactNode } from 'react';

export function Stat({ name, value, hint }: { name: string; value: ReactNode; hint?: string }): ReactNode {
  return (
    <div className="stat">
      <div className="k">{name}</div>
      <div className="v">{value}</div>
      {hint ? <div className="s">{hint}</div> : null}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'plain';

export function Tag({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return <span className={`tag ${tone === 'plain' ? '' : tone}`}>{children}</span>;
}

export function Card({ title, extra, children, note }: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
  note?: ReactNode;
}): ReactNode {
  return (
    <section className="card">
      {title || extra ? (
        <div className="head-row">
          {title ? <h2>{title}</h2> : <span />}
          {extra}
        </div>
      ) : null}
      {children}
      {note ? <p className="note">{note}</p> : null}
    </section>
  );
}

export function Bars({ rows }: { rows: Array<{ label: string; value: number; total: number; suffix?: string }> }): ReactNode {
  const max = rows.reduce((acc, row) => Math.max(acc, row.value), 0) || 1;
  return (
    <div>
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <span className="label truncate">{row.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.round((row.value / max) * 100)}%` }} />
          </span>
          <span className="value">
            {row.value.toLocaleString('zh-CN')}
            {row.suffix ?? ''}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>;
}
