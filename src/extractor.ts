export const EXTRACTION_VERSION = 'extract-v1';

export type ExtractionResult =
  | { ok: true; text: string; scope: string }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function lastUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message.role !== 'user') continue;
    const text = textFromContent(message.content).trim();
    if (text.length > 0) return text;
  }
  return '';
}

function responsesInput(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (!Array.isArray(input)) return '';
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item)) continue;
    const isUser = item.role === 'user';
    const isInputText = item.type === 'input_text' || item.type === 'text';
    if (!isUser && !isInputText) continue;
    const text = textFromContent(item.content).trim() || (typeof item.text === 'string' ? item.text.trim() : '');
    if (text.length > 0) return text;
  }
  return '';
}

function completionPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt.trim();
  if (!Array.isArray(prompt)) return '';
  const parts = prompt.filter((item): item is string => typeof item === 'string');
  return parts.join('\n').trim();
}

export function extractPrompt(pathname: string, body: unknown): ExtractionResult {
  if (!isRecord(body)) return { ok: false, reason: 'invalid_json' };

  if (pathname === '/v1/chat/completions' || pathname === '/v1/messages') {
    const text = lastUserMessage(body.messages);
    return text.length > 0
      ? { ok: true, text, scope: 'last_user_message' }
      : { ok: false, reason: 'no_user_text' };
  }

  if (pathname === '/v1/responses') {
    const text = responsesInput(body.input);
    return text.length > 0
      ? { ok: true, text, scope: 'responses_input' }
      : { ok: false, reason: 'no_user_text' };
  }

  if (pathname === '/v1/completions') {
    const text = completionPrompt(body.prompt);
    return text.length > 0
      ? { ok: true, text, scope: 'completion_prompt' }
      : { ok: false, reason: 'no_user_text' };
  }

  return { ok: false, reason: 'route_not_in_scope' };
}
