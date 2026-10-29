import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const template = readFileSync(fileURLToPath(new URL('./ui.html', import.meta.url)), 'utf8');

export function renderAdminPage(): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return template
    .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('<script>', `<script nonce="${nonce}">`);
}
