import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';

export const SESSION_COOKIE = 'zhlx_admin_session';

interface SessionPayload {
  sub: 'admin';
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export class AdminAuth {
  private readonly config: Config;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(config: Config) {
    this.config = config;
  }

  private get enabled(): boolean {
    return this.config.adminToken !== null && this.config.sessionSecret.length > 0;
  }

  checkToken(token: string): boolean {
    if (!this.config.adminToken) return false;
    return safeEqual(token, this.config.adminToken);
  }

  registerFailure(ip: string): void {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt < now) {
      this.failures.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return;
    }
    entry.count += 1;
  }

  isRateLimited(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= 10;
  }

  createSessionCookie(): string {
    const payload: SessionPayload = {
      sub: 'admin',
      exp: Date.now() + this.config.sessionTtlMs,
    };
    const encoded = base64url(JSON.stringify(payload));
    const signature = sign(encoded, this.config.sessionSecret);
    const secure = this.config.sessionCookieSecure ? '; Secure' : '';
    const cookie = `${SESSION_COOKIE}=${encoded}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}${secure}`;
    return cookie;
  }

  clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  parseCookies(header: string | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    if (!header) return result;
    for (const pair of header.split(';')) {
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name) result[name] = decodeURIComponent(value);
    }
    return result;
  }

  isAuthenticated(req: IncomingMessage): boolean {
    if (!this.enabled) return false;
    const cookies = this.parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return false;
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return false;
    const encoded = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (!safeEqual(signature, sign(encoded, this.config.sessionSecret))) return false;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
      return payload.sub === 'admin' && typeof payload.exp === 'number' && payload.exp > Date.now();
    } catch {
      return false;
    }
  }

  get configured(): boolean {
    return this.enabled;
  }
}

export function clientIp(req: IncomingMessage, trustProxyHeaders = false): string {
  if (trustProxyHeaders) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]?.trim() ?? 'unknown';
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8',
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 16 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return { ok: false, reason: 'body_too_large' };
    chunks.push(buffer);
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

export function parseIsoRange(
  url: URL,
  defaultHours = 24,
  maxDays = 366,
): { ok: true; from: Date; to: Date } | { ok: false; reason: string } {
  const toRaw = url.searchParams.get('to');
  const fromRaw = url.searchParams.get('from');
  const now = new Date();
  const to = toRaw ? new Date(toRaw) : now;
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - defaultHours * 3_600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, reason: 'invalid_time_range' };
  }
  if (from.getTime() >= to.getTime()) {
    return { ok: false, reason: 'from_must_be_before_to' };
  }
  if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
    return { ok: false, reason: 'range_too_large' };
  }
  return { ok: true, from, to };
}

export function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}
