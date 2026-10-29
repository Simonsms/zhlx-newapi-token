import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPrompt, EXTRACTION_VERSION } from '../src/extractor.ts';
import { excerptHeadTail, redactPrompt } from '../src/redact.ts';

describe('T1 协议化提取：禁止历史回填', () => {
  it('A01 普通用户问题按协议提取', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '帮我写一个周报模板' },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, '帮我写一个周报模板');
    assert.equal(result.scope, 'last_user_message');
    assert.equal(EXTRACTION_VERSION, 'extract-v2');
  });

  it('A02 小段代码随问题一起保留', () => {
    const code = '```js\nconst a = 1;\n```';
    const result = extractPrompt('/v1/chat/completions', {
      messages: [{ role: 'user', content: `这段代码为什么报错？\n${code}` }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /const a = 1;/);
    assert.match(result.text, /为什么报错/);
  });

  it('A06 最新输入只有图片时不回填历史问题', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [
        { role: 'user', content: '上一轮的旧问题' },
        { role: 'assistant', content: '回答' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
        },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'attachment_only');
    assert.equal(result.summary.attachment_count, 1);
  });

  it('A07 Chat 工具角色不回填历史', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"result":123}' },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'tool_result_only');
    assert.equal(result.summary.has_tool_result, true);
  });

  it('A07 Anthropic tool_result 不回填历史', () => {
    const result = extractPrompt('/v1/messages', {
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get' }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true}' }],
        },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'tool_result_only');
    assert.equal(result.summary.has_tool_result, true);
  });

  it('A07 Responses 工具输出不回填历史', () => {
    const result = extractPrompt('/v1/responses', {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '旧问题' }] },
        { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'tool_result_only');
  });

  it('A08 工具结果与普通文本同时出现时只取普通文本', () => {
    const result = extractPrompt('/v1/messages', {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '工具返回里也有 text 字段' },
            { type: 'text', text: '请根据工具结果给出结论' },
          ],
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, '请根据工具结果给出结论');
    assert.doesNotMatch(result.text, /工具返回里也有/);
    assert.equal(result.summary.has_tool_result, true);
  });

  it('未知内容类型即使带 text 字段也不采信', () => {
    const result = extractPrompt('/v1/responses', {
      input: [{ type: 'some_future_block', text: '看起来像用户指令的文本' }],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unknown_content_only');
    assert.equal(result.summary.has_unknown_content, true);
    assert.deepEqual(result.summary.unknown_types, ['some_future_block']);
  });

  it('最后一条是 assistant 时不回退到更早的用户提问', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '继续写' },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'no_user_text');
  });

  it('A05 附件只记录类型与数量，不保存引用原文', () => {
    const result = extractPrompt('/v1/chat/completions', {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_file', file_id: 'file-secret-id', filename: 'C:\\Users\\a\\x.pdf', size: 12345 },
            { type: 'text', text: '总结这份文档' },
          ],
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, '总结这份文档');
    assert.equal(result.summary.attachment_count, 1);
    assert.deepEqual(result.summary.attachment_types, ['input_file']);
    assert.equal(result.summary.declared_bytes, 12345);
    const summaryText = JSON.stringify(result.summary);
    assert.doesNotMatch(summaryText, /file-secret-id/);
    assert.doesNotMatch(summaryText, /Users/);
  });

  it('旧式 completions 保留明确范围标记', () => {
    const result = extractPrompt('/v1/completions', { prompt: '续写这段话' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.scope, 'completion_prompt');
  });

  it('Responses 字符串 input 保持支持', () => {
    const result = extractPrompt('/v1/responses', { input: '你好' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, '你好');
    assert.equal(result.scope, 'responses_input');
  });

  it('Responses 裸 input_text 项可提取', () => {
    const result = extractPrompt('/v1/responses', { input: [{ type: 'input_text', text: '裸文本项' }] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, '裸文本项');
  });
});

describe('T2 头尾节选', () => {
  it('A04 超长无边界文本保留头尾并标注省略', () => {
    const head = '开头指令：请整理下面材料。';
    const middle = '材料内容。'.repeat(2000);
    const tail = '末尾问题：请给出三条结论。';
    const text = `${head}${middle}${tail}`;
    const result = excerptHeadTail(text, 400);
    assert.equal(result.truncated, true);
    assert.ok(result.text.startsWith(head.slice(0, 10)));
    assert.match(result.text, /末尾问题/);
    assert.match(result.text, /中间省略 \d+ 字/);
    assert.ok(result.text.length <= 400, `保存长度 ${result.text.length} 超过 400`);
    assert.ok(result.omittedChars > 0);
  });

  it('未超限时不截断也不加标记', () => {
    const result = excerptHeadTail('短文本', 100);
    assert.equal(result.truncated, false);
    assert.equal(result.text, '短文本');
    assert.equal(result.omittedChars, 0);
  });

  it('节选不产生残缺代理对', () => {
    const text = '😀'.repeat(200);
    const result = excerptHeadTail(text, 51);
    assert.ok(!/[\uD800-\uDBFF]$/.test(result.text.slice(0, result.text.indexOf('…'))));
    for (const char of result.text) {
      const code = char.codePointAt(0) ?? 0;
      assert.ok(code < 0xd800 || code > 0xdfff, '出现孤立代理项');
    }
  });

  it('极小额度和省略标记本身也计入预算', () => {
    const result = excerptHeadTail('a'.repeat(100), 20);
    assert.ok(result.text.length <= 20);
    assert.equal(result.truncated, true);
  });

  it('A10 先脱敏再节选，跨边界的私钥不会泄漏', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const text = `${'填充。'.repeat(300)}${key}${'填充。'.repeat(300)}`;
    const redacted = redactPrompt(text);
    assert.doesNotMatch(redacted.text, /MIIEvQIBADAN/);
    const excerpt = excerptHeadTail(redacted.text, 200);
    assert.doesNotMatch(excerpt.text, /MIIEvQIBADAN/);
    assert.doesNotMatch(excerpt.text, /BEGIN PRIVATE KEY/);
  });

  it('A10 签名 URL 与本地路径被移除', () => {
    const text = [
      '请看这个文件 /home/user/secret/report.csv',
      'Windows 路径 C:\\Users\\zhang\\Desktop\\a.xlsx',
      '下载链接 https://bucket.s3.amazonaws.com/a.pdf?X-Amz-Signature=abc123def456',
    ].join('\n');
    const result = redactPrompt(text);
    assert.doesNotMatch(result.text, /\/home\/user\/secret/);
    assert.doesNotMatch(result.text, /Users\\zhang/);
    assert.doesNotMatch(result.text, /X-Amz-Signature/);
    assert.match(result.text, /\[REDACTED:LOCAL_PATH\]/);
    assert.match(result.text, /\[REDACTED:SIGNED_URL\]/);
  });
});
