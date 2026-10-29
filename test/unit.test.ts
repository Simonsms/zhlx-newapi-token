import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPrompt } from '../src/extractor.ts';
import { redactPrompt } from '../src/redact.ts';
import { mapRawLog } from '../src/newapi-client.ts';

describe('Prompt 提取', () => {
  it('只取 Chat Completions 最后一条 user 文本', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'second');
    assert.equal(result.scope, 'last_user_message');
  });

  it('支持 Responses input 结构', () => {
    const result = extractPrompt('/v1/responses', {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello responses' }] },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'hello responses');
    assert.equal(result.scope, 'responses_input');
  });

  it('支持 legacy completions 字符串 prompt', () => {
    const result = extractPrompt('/v1/completions', { prompt: 'legacy prompt' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'legacy prompt');
    assert.equal(result.scope, 'completion_prompt');
  });

  it('无用户文本时返回明确原因', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [{ role: 'system', content: 'only system' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'no_user_text');
  });

  it('未知接口不提取正文', () => {
    const result = extractPrompt('/v1/embeddings', { input: 'text' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'route_not_in_scope');
  });
});

describe('脱敏', () => {
  it('移除凭证、邮箱、手机号与私钥', () => {
    const input = [
      '联系 user@example.com 或 13812345678',
      'Authorization: Bearer abcdefghijklmnop',
      'token sk-abcdefghijklmnopqrstuv',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const result = redactPrompt(input);
    assert.doesNotMatch(result.text, /user@example\.com/);
    assert.doesNotMatch(result.text, /13812345678/);
    assert.doesNotMatch(result.text, /abcdefghijklmnop/);
    assert.doesNotMatch(result.text, /MIIEvQIBADAN/);
    assert.match(result.text, /\[REDACTED:EMAIL\]/);
    assert.match(result.text, /\[REDACTED:CN_PHONE\]/);
    assert.ok(result.redactions >= 4);
  });

  it('普通业务文本不被误改', () => {
    const input = '请把这份季度报告整理成三条要点，并给出待办。';
    const result = redactPrompt(input);
    assert.equal(result.text, input);
    assert.equal(result.redactions, 0);
  });
});

describe('原生日志映射', () => {
  const base = {
    id: 9,
    created_at: 1_700_000_000,
    type: 2,
    request_id: 'gw-1',
    model_name: 'gpt-4o-mini',
    prompt_tokens: 10,
    completion_tokens: 20,
    quota: 30,
    user_id: 1,
    token_id: 2,
  };

  it('正常用量标为 reported，并生成稳定复合键', () => {
    const first = mapRawLog(base, 'dep', 'composite');
    const second = mapRawLog({ ...base }, 'dep', 'composite');
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.usage_source, 'reported');
    assert.equal(first.source_key, second.source_key);
    assert.equal(first.created_at, new Date(1_700_000_000_000).toISOString());
    assert.equal(first.newapi_request_id, 'gw-1');
  });

  it('本地估算标记为 estimated', () => {
    const item = mapRawLog(
      { ...base, other: JSON.stringify({ admin_info: { local_count_tokens: true } }) },
      'dep',
      'composite',
    );
    assert.equal(item?.usage_source, 'estimated');
  });

  it('缺失 Token 标记为 missing 并保留 null', () => {
    const item = mapRawLog({ ...base, prompt_tokens: null, completion_tokens: null }, 'dep', 'composite');
    assert.equal(item?.usage_source, 'missing');
    assert.equal(item?.prompt_tokens, null);
    assert.equal(item?.completion_tokens, null);
  });

  it('不同部署的同一条日志不共享去重键', () => {
    const a = mapRawLog(base, 'dep-a', 'composite');
    const b = mapRawLog(base, 'dep-b', 'composite');
    assert.notEqual(a?.source_key, b?.source_key);
  });

  it('原始日志中的额外敏感字段不落库', () => {
    const item = mapRawLog({ ...base, secret_content: 'leak me', other: '{"a":1}' }, 'dep', 'composite');
    assert.ok(item);
    assert.doesNotMatch(item.raw, /leak me/);
  });
});
