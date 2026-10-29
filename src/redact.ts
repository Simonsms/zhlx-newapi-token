export const REDACTION_VERSION = 'redact-v2';

interface Rule {
  label: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    label: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    label: 'AUTH_HEADER',
    pattern: /\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
  },
  {
    label: 'BEARER',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    label: 'API_KEY',
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    label: 'SECRET',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  },
  {
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: 'URL_CREDENTIALS',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  },
  {
    // 带签名的对象存储链接：整条 URL 不进入分析副本。
    label: 'SIGNED_URL',
    pattern:
      /\bhttps?:\/\/[^\s"'<>]*(?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Signature=|sig=|se=|sp=|sv=|token=)[^\s"'<>]*/gi,
  },
  {
    // 本地绝对路径会暴露目录结构与用户名。
    label: 'LOCAL_PATH',
    pattern: /\b[A-Za-z]:\\[^\s"'<>|?*\r\n]+/g,
  },
  {
    // Unix 绝对路径：至少两级目录，且以常见用户目录或系统目录开头，避免误伤普通斜杠文本。
    label: 'LOCAL_PATH',
    pattern:
      /(?<![\w/:.-])\/(?:home|Users|root|var|opt|srv|tmp|mnt|data|workspace|Volumes)\/[^\s"'<>|?*\r\n]*/g,
  },
  {
    label: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    label: 'CN_ID',
    pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  },
  {
    label: 'CN_PHONE',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
];

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactPrompt(input: string): RedactionResult {
  let text = input;
  let redactions = 0;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, () => {
      redactions += 1;
      return `[REDACTED:${rule.label}]`;
    });
  }
  return { text, redactions };
}

export interface ExcerptResult {
  text: string;
  truncated: boolean;
  omittedChars: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function headEnd(text: string, end: number): number {
  // 不把代理对切成两个孤立码元。
  return end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

function tailStart(text: string, start: number): number {
  return start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
}

/**
 * 头尾节选。字符口径为 JS 字符串长度（UTF-16 码元），与 UTF-8 字节数无关。
 * 省略标记本身计入 maxChars 预算，保证保存文本不超限。
 */
export function excerptHeadTail(text: string, maxChars: number): ExcerptResult {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0, omittedChars: text.length };
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };

  // 先按最长的省略标记估算预算，再据实际省略字数收敛。
  const sampleMarker = `\n…[中间省略 ${text.length} 字]…\n`;
  if (maxChars <= sampleMarker.length + 8) {
    const cut = headEnd(text, maxChars);
    return { text: text.slice(0, cut), truncated: true, omittedChars: text.length - cut };
  }

  let budget = maxChars - sampleMarker.length;
  let headLength = Math.ceil(budget / 2);
  let head = text.slice(0, headEnd(text, headLength));
  let tail = text.slice(tailStart(text, text.length - (budget - headLength)));
  let omitted = text.length - head.length - tail.length;
  const marker = `\n…[中间省略 ${omitted} 字]…\n`;
  budget = maxChars - marker.length;
  if (budget < 2) {
    const cut = headEnd(text, maxChars);
    return { text: text.slice(0, cut), truncated: true, omittedChars: text.length - cut };
  }
  headLength = Math.ceil(budget / 2);
  head = text.slice(0, headEnd(text, headLength));
  tail = text.slice(tailStart(text, text.length - (budget - headLength)));
  omitted = text.length - head.length - tail.length;
  return { text: `${head}\n…[中间省略 ${omitted} 字]…\n${tail}`, truncated: true, omittedChars: omitted };
}
