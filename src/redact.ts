export const REDACTION_VERSION = 'redact-v1';

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
