import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import { extractPrompt, EXTRACTION_VERSION } from './extractor.ts';
import type { Logger } from './logger.ts';
import { REDACTION_VERSION, redactPrompt } from './redact.ts';
import type { ProxyWriter } from './store/writer.ts';
import type { CaptureStatus, ProxyRequestInsert, TransportOutcome } from './store/types.ts';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STRIPPED_REQUEST_HEADERS = new Set(['host', 'x-oneapi-request-id', 'x-proxy-request-id']);

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

export interface ProxyDeps {
  config: Config;
  writer: ProxyWriter;
  logger: Logger;
}

export function createProxyHandler(deps: ProxyDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, writer, logger } = deps;

  return (req, res) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://internal');
    const pathname = parsedUrl.pathname;
    const proxyRequestId = randomUUID();
    const startedAt = Date.now();
    const receivedAt = new Date(startedAt).toISOString();

    const captureRoute = config.captureRoutes.has(pathname) && req.method === 'POST';
    const contentType = req.headers['content-type'];
    const contentEncoding = req.headers['content-encoding'];
    const teeEligible =
      captureRoute && isJsonContentType(contentType) && (!contentEncoding || contentEncoding === 'identity');

    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let overLimit = false;
    let bodyComplete = false;
    let newapiRequestId: string | null = null;
    let httpStatus: number | null = null;
    let outcome: TransportOutcome = 'no_response';
    let finalized = false;
    let responseStarted = false;
    let pausedForDrain = false;

    let upstreamResponse: http.IncomingMessage | null = null;

    const upstreamBase = config.upstreamUrl;
    const basePath = upstreamBase.pathname.replace(/\/$/, '');
    const target = new URL(
      `${upstreamBase.origin}${basePath}${req.url ?? '/'}`,
    );

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(name) || STRIPPED_REQUEST_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    headers.host = upstreamBase.host;

    const transport = upstreamBase.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request(target, { method: req.method, headers });

    const finalize = (): void => {
      if (finalized) return;
      finalized = true;

      let captureStatus: CaptureStatus;
      let skipReason: string | null = null;
      let promptText: string | null = null;
      let promptScope: string | null = null;
      let promptChars: number | null = null;
      let promptTruncated = 0;
      let extractionVersion: string | null = null;
      let redactionVersion: string | null = null;
      let model: string | null = null;
      let isStream: number | null = null;

      let parsedBody: unknown = null;
      let parsedOk = false;
      if (teeEligible && !overLimit && bodyComplete) {
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          parsedOk = true;
        } catch {
          parsedOk = false;
        }
      }
      if (parsedOk && typeof parsedBody === 'object' && parsedBody !== null) {
        const record = parsedBody as Record<string, unknown>;
        if (typeof record.model === 'string') model = record.model.slice(0, 200);
        if (record.stream === true) isStream = 1;
      }
      if (isStream === null) {
        const accept = firstHeader(req.headers.accept);
        if (accept && accept.includes('text/event-stream')) isStream = 1;
      }

      if (!config.captureEnabled) {
        captureStatus = 'disabled';
      } else if (!captureRoute) {
        captureStatus = 'skipped';
        skipReason = 'route_not_in_scope';
      } else if (!isJsonContentType(contentType)) {
        captureStatus = 'skipped';
        skipReason = 'unsupported_content_type';
      } else if (contentEncoding && contentEncoding !== 'identity') {
        captureStatus = 'skipped';
        skipReason = 'unsupported_content_encoding';
      } else if (!bodyComplete) {
        captureStatus = 'skipped';
        skipReason = 'incomplete_request_body';
      } else if (overLimit) {
        captureStatus = 'skipped';
        skipReason = 'over_limit';
      } else if (httpStatus === null) {
        captureStatus = 'skipped';
        skipReason = 'no_upstream_response';
      } else if (httpStatus < 200 || httpStatus >= 300) {
        captureStatus = 'skipped';
        skipReason = 'upstream_status';
      } else if (!parsedOk) {
        captureStatus = 'skipped';
        skipReason = 'invalid_json';
      } else {
        const extracted = extractPrompt(pathname, parsedBody);
        if (!extracted.ok) {
          captureStatus = 'skipped';
          skipReason = extracted.reason;
        } else {
          try {
            const redacted = redactPrompt(extracted.text);
            const truncated = redacted.text.length > config.captureMaxChars;
            promptText = truncated ? redacted.text.slice(0, config.captureMaxChars) : redacted.text;
            promptChars = promptText.length;
            promptTruncated = truncated ? 1 : 0;
            promptScope = extracted.scope;
            extractionVersion = EXTRACTION_VERSION;
            redactionVersion = REDACTION_VERSION;
            captureStatus = 'captured';
          } catch (error) {
            captureStatus = 'skipped';
            skipReason = 'redaction_failed';
            logger.error('prompt_redaction_failed', { error: (error as Error).message });
          }
        }
      }

      const row: ProxyRequestInsert = {
        proxy_request_id: proxyRequestId,
        deployment_id: config.deploymentId,
        newapi_request_id: newapiRequestId,
        received_at: receivedAt,
        method: req.method ?? 'UNKNOWN',
        path: pathname.slice(0, 300),
        http_status: httpStatus,
        transport_outcome: outcome,
        capture_status: captureStatus,
        skip_reason: skipReason,
        prompt_text: promptText,
        prompt_scope: promptScope,
        prompt_chars: promptChars,
        prompt_truncated: promptTruncated,
        extraction_version: extractionVersion,
        redaction_version: redactionVersion,
        model,
        is_stream: isStream,
        duration_ms: Date.now() - startedAt,
      };

      writer.enqueue(row, promptText !== null);
    };

    const markOutcome = (next: TransportOutcome): void => {
      if (outcome !== 'no_response') return;
      outcome = next;
    };

    req.on('data', (chunk: Buffer) => {
      if (teeEligible && !overLimit) {
        if (capturedBytes + chunk.length > config.captureMaxBytes) {
          overLimit = true;
          chunks.length = 0;
        } else {
          chunks.push(chunk);
          capturedBytes += chunk.length;
        }
      }
      if (pausedForDrain) return;
      try {
        if (!upstreamReq.write(chunk)) {
          pausedForDrain = true;
          req.pause();
          upstreamReq.once('drain', () => {
            pausedForDrain = false;
            req.resume();
          });
        }
      } catch {
        markOutcome('proxy_error');
        upstreamReq.destroy();
      }
    });

    req.on('end', () => {
      bodyComplete = true;
      try {
        upstreamReq.end();
      } catch {
        markOutcome('proxy_error');
      }
    });

    req.on('aborted', () => {
      markOutcome('client_cancel');
      upstreamReq.destroy();
      finalize();
    });

    req.on('error', () => {
      markOutcome('proxy_error');
      upstreamReq.destroy();
      finalize();
    });

    if (config.upstreamIdleTimeoutMs > 0) {
      upstreamReq.setTimeout(config.upstreamIdleTimeoutMs, () => {
        markOutcome('timeout');
        upstreamReq.destroy();
        if (!responseStarted && !res.headersSent) {
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'upstream_timeout', proxy_request_id: proxyRequestId }));
        } else {
          res.destroy();
        }
        finalize();
      });
    }

    upstreamReq.on('response', (upstreamRes) => {
      upstreamResponse = upstreamRes;
      responseStarted = true;
      httpStatus = upstreamRes.statusCode ?? null;
      newapiRequestId = firstHeader(upstreamRes.headers['x-oneapi-request-id']);
      if (newapiRequestId) newapiRequestId = newapiRequestId.slice(0, 200);

      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(name)) continue;
        responseHeaders[name] = value;
      }
      responseHeaders['x-proxy-request-id'] = proxyRequestId;

      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      res.flushHeaders();
      upstreamRes.pipe(res);

      if (config.upstreamIdleTimeoutMs > 0) {
        upstreamRes.setTimeout(config.upstreamIdleTimeoutMs, () => {
          markOutcome('timeout');
          upstreamRes.destroy();
          if (!res.writableEnded) res.destroy();
          finalize();
        });
      }

      upstreamRes.on('end', () => {
        if (outcome === 'no_response') outcome = 'completed';
        finalize();
      });

      upstreamRes.on('aborted', () => {
        markOutcome('upstream_error');
        if (!res.writableEnded) res.destroy();
        finalize();
      });

      upstreamRes.on('error', () => {
        markOutcome('upstream_error');
        if (!res.writableEnded) res.destroy();
        finalize();
      });
    });

    upstreamReq.on('error', (error) => {
      if (outcome === 'timeout' || outcome === 'client_cancel') {
        finalize();
        return;
      }
      markOutcome('upstream_error');
      logger.warn('upstream_request_failed', {
        proxy_request_id: proxyRequestId,
        error: error.message,
      });
      if (!responseStarted && !res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_unavailable', proxy_request_id: proxyRequestId }));
      } else if (!res.writableEnded) {
        res.destroy();
      }
      finalize();
    });

    res.on('close', () => {
      if (res.writableFinished) return;
      markOutcome('client_cancel');
      if (upstreamResponse) upstreamResponse.destroy();
      upstreamReq.destroy();
      finalize();
    });
  };
}
