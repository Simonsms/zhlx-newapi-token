import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 把脱敏占位符与节选标记从正文里拆出来单独着色，
 * 让管理员一眼看出哪些内容是系统替换过、哪些是被截断的。
 */
function segments(text: string): Array<{ kind: 'text' | 'redacted' | 'omitted'; value: string }> {
  const pattern = /(\[REDACTED:[A-Z_]+\]|…\[中间省略 \d+ 字\]…)/g;
  const parts: Array<{ kind: 'text' | 'redacted' | 'omitted'; value: string }> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: 'text', value: text.slice(last, index) });
    const value = match[0];
    parts.push({ kind: value.startsWith('[REDACTED:') ? 'redacted' : 'omitted', value });
    last = index + value.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

function Body({ text, wrap }: { text: string; wrap: boolean }): ReactNode {
  const parts = useMemo(() => segments(text), [text]);
  return (
    <div className={`prompt-scroll ${wrap ? '' : 'nowrap'}`}>
      {parts.map((part, index) =>
        part.kind === 'text'
          ? <span key={index}>{part.value}</span>
          : <mark key={index} className={part.kind}>{part.value}</mark>,
      )}
    </div>
  );
}

export interface PromptViewerProps {
  text: string | null;
  scope: string | null;
  chars: number | null;
  truncated: number;
  extractionVersion: string | null;
  redactionVersion: string | null;
}

export function PromptViewer({ text, scope, chars, truncated, extractionVersion, redactionVersion }: PromptViewerProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  if (!text) {
    return (
      <div className="empty">
        这条请求没有保存正文（仅元数据）。原因见上方「采集」与跳过原因，例如附件、工具结果或超出上限。
      </div>
    );
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('已复制');
      setTimeout(() => setCopied(''), 1600);
    } catch {
      setCopied('复制失败，请手动选择');
      setTimeout(() => setCopied(''), 2400);
    }
  };

  const toolbar = (
    <div className="prompt-toolbar">
      <button type="button" className="ghost" onClick={() => void copy()}>{copied || '复制'}</button>
      <button type="button" className="ghost" onClick={() => setWrap(!wrap)}>{wrap ? '不换行' : '自动换行'}</button>
      <button type="button" className="ghost" onClick={() => setExpanded(true)}>全屏查看</button>
      <span className="spacer" />
      <span className="tiny muted">
        {scope ?? '未知范围'}{truncated ? ' · 已截断' : ''}
      </span>
    </div>
  );

  return (
    <>
      {toolbar}
      <Body text={text} wrap={wrap} />
      <div className="prompt-meta">
        <span>{chars ?? text.length} 字符</span>
        {truncated ? <span>中间部分已省略</span> : null}
        <span>提取 {extractionVersion ?? '—'}</span>
        <span>脱敏 {redactionVersion ?? '—'}</span>
      </div>

      {expanded ? createPortal(
        <div
          className="prompt-modal"
          role="dialog"
          aria-modal="true"
          aria-label="脱敏用户文本全屏查看"
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          <div className="prompt-modal-inner">
            <div className="modal-head">
              <h2>脱敏用户文本</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="ghost" onClick={() => setWrap(!wrap)}>{wrap ? '不换行' : '自动换行'}</button>
                <button type="button" className="ghost" onClick={() => void copy()}>{copied || '复制'}</button>
                <button type="button" className="primary" onClick={() => setExpanded(false)}>关闭 (Esc)</button>
              </div>
            </div>
            <Body text={text} wrap={wrap} />
            <div className="prompt-meta">
              <span>{scope ?? '未知范围'}</span>
              <span>{chars ?? text.length} 字符</span>
              {truncated ? <span>中间部分已省略</span> : null}
              <span>提取 {extractionVersion ?? '—'} / 脱敏 {redactionVersion ?? '—'}</span>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
