export const EXTRACTION_VERSION = 'extract-v2';

export interface ContentSummary {
  attachment_count: number;
  attachment_types: string[];
  has_tool_result: boolean;
  has_unknown_content: boolean;
  unknown_types: string[];
  declared_bytes: number | null;
}

export interface ExtractionOk {
  ok: true;
  text: string;
  scope: string;
  summary: ContentSummary;
}

export interface ExtractionSkip {
  ok: false;
  reason: string;
  summary: ContentSummary;
}

export type ExtractionResult = ExtractionOk | ExtractionSkip;

type BlockKind = 'text' | 'attachment' | 'tool_result' | 'unknown';

const ATTACHMENT_TYPES = new Set([
  'image_url',
  'input_image',
  'image',
  'file',
  'input_file',
  'document',
  'audio',
  'input_audio',
  'video_url',
  'input_video',
  'pdf',
]);

const TOOL_RESULT_TYPES = new Set([
  'tool_result',
  'function_call_output',
  'computer_call_output',
  'computer_use_output',
  'mcp_call_output',
  'mcp_tool_result',
  'local_shell_call_output',
  'custom_tool_call_output',
]);

const TEXT_TYPES = new Set(['text', 'input_text']);

// 只有这些角色字段才代表"用户输入"；assistant/tool/system 一律不作为本期正文。
const USER_ROLES = new Set(['user']);

const MAX_LISTED_TYPES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptySummary(): ContentSummary {
  return {
    attachment_count: 0,
    attachment_types: [],
    has_tool_result: false,
    has_unknown_content: false,
    unknown_types: [],
    declared_bytes: null,
  };
}

function safeTypeName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  // 类型名只作白名单展示，限制长度并剔除控制字符，避免把任意字段值带进库。
  return value.replace(/[^\w.:-]/g, '').slice(0, 40) || 'unknown';
}

function declaredSize(block: Record<string, unknown>): number | null {
  for (const key of ['bytes', 'size', 'file_size', 'content_length', 'length'] as const) {
    const value = block[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  const file = block.file;
  if (isRecord(file)) {
    for (const key of ['bytes', 'size', 'file_size'] as const) {
      const value = file[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
  }
  return null;
}

function noteType(list: string[], value: unknown): void {
  const name = safeTypeName(value);
  if (!list.includes(name) && list.length < MAX_LISTED_TYPES) list.push(name);
}

interface CollectedText {
  parts: string[];
  summary: ContentSummary;
}

function collectBlocks(blocks: unknown, protocol: 'chat' | 'responses'): CollectedText {
  const summary = emptySummary();
  const parts: string[] = [];
  if (typeof blocks === 'string') {
    if (blocks.trim().length > 0) parts.push(blocks);
    return { parts, summary };
  }
  if (!Array.isArray(blocks)) return { parts, summary };

  for (const block of blocks) {
    if (typeof block === 'string') {
      if (block.trim().length > 0) parts.push(block);
      continue;
    }
    if (!isRecord(block)) {
      summary.has_unknown_content = true;
      noteType(summary.unknown_types, 'non_object');
      continue;
    }
    const type = safeTypeName(block.type);
    const size = declaredSize(block);
    if (size !== null) {
      summary.declared_bytes = summary.declared_bytes === null
        ? size
        : Math.max(summary.declared_bytes, size);
    }

    let kind: BlockKind;
    if (TOOL_RESULT_TYPES.has(type)) kind = 'tool_result';
    else if (ATTACHMENT_TYPES.has(type)) kind = 'attachment';
    else if (TEXT_TYPES.has(type)) kind = 'text';
    else if (protocol === 'chat' && type === 'text') kind = 'text';
    else kind = 'unknown';

    // 未经明确允许的类型即使带 text 字段也不采信，避免把未知结构当用户指令。
    if (kind === 'text') {
      if (typeof block.text === 'string' && block.text.trim().length > 0) parts.push(block.text);
      continue;
    }
    if (kind === 'attachment') {
      summary.attachment_count += 1;
      noteType(summary.attachment_types, type);
      continue;
    }
    if (kind === 'tool_result') {
      summary.has_tool_result = true;
      continue;
    }
    summary.has_unknown_content = true;
    noteType(summary.unknown_types, type);
  }
  return { parts, summary };
}

function mergeSummary(target: ContentSummary, source: ContentSummary): void {
  target.attachment_count += source.attachment_count;
  target.has_tool_result = target.has_tool_result || source.has_tool_result;
  target.has_unknown_content = target.has_unknown_content || source.has_unknown_content;
  if (source.declared_bytes !== null) {
    target.declared_bytes = target.declared_bytes === null
      ? source.declared_bytes
      : Math.max(target.declared_bytes, source.declared_bytes);
  }
  for (const type of source.attachment_types) noteType(target.attachment_types, type);
  for (const type of source.unknown_types) noteType(target.unknown_types, type);
}

function skipReason(summary: ContentSummary): string {
  if (summary.has_tool_result) return 'tool_result_only';
  if (summary.attachment_count > 0) return 'attachment_only';
  if (summary.has_unknown_content) return 'unknown_content_only';
  return 'no_user_text';
}

function lastItem(items: unknown): Record<string, unknown> | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const item = items[items.length - 1];
  return isRecord(item) ? item : null;
}

function extractChatLike(body: Record<string, unknown>): ExtractionResult {
  const message = lastItem(body.messages);
  if (!message) {
    return { ok: false, reason: 'no_user_text', summary: emptySummary() };
  }
  const role = safeTypeName(message.role);
  const collected = collectBlocks(message.content, 'chat');
  if (!USER_ROLES.has(role)) {
    if (role === 'tool' || role === 'function') {
      collected.summary.has_tool_result = true;
      return { ok: false, reason: 'tool_result_only', summary: collected.summary };
    }
    // 最后一条是 assistant/system 时属于续写或系统消息，不回退到更早的用户提问。
    return { ok: false, reason: 'no_user_text', summary: collected.summary };
  }
  const text = collected.parts.join('\n').trim();
  if (text.length === 0) {
    return { ok: false, reason: skipReason(collected.summary), summary: collected.summary };
  }
  return { ok: true, text, scope: 'last_user_message', summary: collected.summary };
}

function extractResponses(body: Record<string, unknown>): ExtractionResult {
  const input = body.input;
  if (typeof input === 'string') {
    const text = input.trim();
    return text.length > 0
      ? { ok: true, text, scope: 'responses_input', summary: emptySummary() }
      : { ok: false, reason: 'no_user_text', summary: emptySummary() };
  }
  const item = lastItem(input);
  if (!item) {
    return { ok: false, reason: 'no_user_text', summary: emptySummary() };
  }

  const itemType = safeTypeName(item.type);
  const summary = emptySummary();
  if (TOOL_RESULT_TYPES.has(itemType)) {
    summary.has_tool_result = true;
    const size = declaredSize(item);
    if (size !== null) summary.declared_bytes = size;
    return { ok: false, reason: 'tool_result_only', summary };
  }
  if (ATTACHMENT_TYPES.has(itemType)) {
    summary.attachment_count += 1;
    noteType(summary.attachment_types, itemType);
    const size = declaredSize(item);
    if (size !== null) summary.declared_bytes = size;
    return { ok: false, reason: 'attachment_only', summary };
  }

  // Responses 的普通消息可能带 type=message 与 role，也可能只给 role，
  // 也可能直接是 input_text。只有缺少 type 但带 role/content 时按消息处理。
  const hasRole = item.role !== undefined;
  const isMessage = itemType === 'message' || (item.type === undefined && hasRole);
  const isBareText = TEXT_TYPES.has(itemType);
  if (!isMessage && !isBareText) {
    summary.has_unknown_content = true;
    noteType(summary.unknown_types, itemType);
    return { ok: false, reason: 'unknown_content_only', summary };
  }

  const role = item.role === undefined ? 'user' : safeTypeName(item.role);
  if (!USER_ROLES.has(role)) {
    if (role === 'tool' || role === 'function') {
      summary.has_tool_result = true;
      return { ok: false, reason: 'tool_result_only', summary };
    }
    return { ok: false, reason: 'no_user_text', summary };
  }

  const collected = collectBlocks(item.content ?? (isBareText ? [item] : item), 'responses');
  mergeSummary(summary, collected.summary);
  const text = collected.parts.join('\n').trim();
  if (text.length === 0) {
    return { ok: false, reason: skipReason(summary), summary };
  }
  return { ok: true, text, scope: 'responses_input', summary };
}

function completionPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt.trim();
  if (!Array.isArray(prompt)) return '';
  const parts = prompt.filter((item): item is string => typeof item === 'string');
  return parts.join('\n').trim();
}

export function extractPrompt(pathname: string, body: unknown): ExtractionResult {
  if (!isRecord(body)) return { ok: false, reason: 'invalid_json', summary: emptySummary() };

  if (pathname === '/v1/chat/completions' || pathname === '/v1/messages') {
    return extractChatLike(body);
  }

  if (pathname === '/v1/responses') {
    return extractResponses(body);
  }

  if (pathname === '/v1/completions') {
    const text = completionPrompt(body.prompt);
    return text.length > 0
      ? { ok: true, text, scope: 'completion_prompt', summary: emptySummary() }
      : { ok: false, reason: 'no_user_text', summary: emptySummary() };
  }

  return { ok: false, reason: 'route_not_in_scope', summary: emptySummary() };
}
