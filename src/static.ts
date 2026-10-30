import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendText } from './http-helpers.ts';
import type { Logger } from './logger.ts';

const DIST = fileURLToPath(new URL('../web/dist', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// 构建产物是同源静态文件，用 'self' 即可；不要再加 nonce——
// 一旦出现 nonce，浏览器会忽略 'self'，模块导入会被拦截。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export interface StaticAssets {
  available: boolean;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
}

function sendHtml(res: ServerResponse, html: string): void {
  const body = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/**
 * 托管 web/ 的构建产物。路径非法或文件不存在时返回 false，由调用方继续路由。
 * 构建产物缺席时给出明确提示，而不是静默 404 —— 便于排查漏构建。
 */
export function createStaticAssets(logger: Logger): StaticAssets {
  const indexPath = join(DIST, 'index.html');
  const available = existsSync(indexPath);
  if (!available) {
    logger.warn('admin_assets_missing', { dist: DIST, hint: '先运行 npm --prefix web run build' });
  }

  return {
    available,
    handle(req, res, pathname) {
      if (!available) {
        if (pathname === '/' || pathname === '') {
          sendText(res, 503, '管理界面未构建：请先运行 npm --prefix web run build', 'text/plain; charset=utf-8');
          return true;
        }
        return false;
      }

      const relative = pathname.replace(/^\/+/, '');
      if (relative === '' ) {
        sendHtml(res, readFileSync(indexPath, 'utf8'));
        return true;
      }

      const target = normalize(join(DIST, relative));
      // 防止 ../ 越界读取构建目录之外的文件。
      if (!target.startsWith(DIST + sep)) {
        sendText(res, 403, 'forbidden');
        return true;
      }

      if (existsSync(target) && statSync(target).isFile()) {
        const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
        if (type.startsWith('text/html')) {
          sendHtml(res, readFileSync(target, 'utf8'));
          return true;
        }
        const body = readFileSync(target);
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(body.byteLength),
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // 带 hash 的静态资源可长缓存。
          'cache-control': relative.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
        });
        res.end(body);
        return true;
      }

      // SPA 兜底：非资源路径交给入口页处理。
      if (!extname(pathname)) {
        sendHtml(res, readFileSync(indexPath, 'utf8'));
        return true;
      }
      return false;
    },
  };
}
