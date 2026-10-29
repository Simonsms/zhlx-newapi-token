# 交付报告：Prompt 采集范围与大输入处理

日期：2026-10-29。基线：`f8ffcb6`。实现位置：本仓库。

## 1. 实际实现的采集规则

### 按协议识别，不再"有 text 字段就收集"

| 接口 | 规则 |
|---|---|
| `/v1/chat/completions`、`/v1/messages` | 只取 `messages` 最后一条；角色必须是 `user`；只接受 `type` 为 `text` 的块或纯字符串 |
| `/v1/responses` | `input` 为字符串时直接取；为数组时取最后一项，需 `type=message`（或无 `type` 但带 `role`）且 `role=user`，或直接是 `input_text` |
| `/v1/completions` | 取 `prompt`，范围标记 `completion_prompt`，不承诺区分人工指令与上下文 |

明确排除：

- 工具结果：`tool_result`、`function_call_output`、`computer_call_output`、`mcp_*_output` 等，以及 Chat 的 `role=tool/function`。
- 附件：`image_url`、`input_image`、`file`、`input_file`、`document`、`audio`、`input_audio`、`video_url`、`pdf` 等。
- 未知类型：即使带 `text` 字段也不采信，记 `unknown_content_only` 与类型名。

**不再历史回填**：最后一轮只有图片、附件或工具结果时，正文为空并记录原因，不向前寻找旧问题。

### 脱敏与节选

顺序固定为：协议识别 → 选择文本 → 脱敏 → 头尾节选。先脱敏再截断，避免切断私钥等结构导致规则失效。

新增脱敏规则：签名 URL（`X-Amz-Signature` 等）、Windows 与 Unix 本地绝对路径。

头尾节选：总量不超过 `CAPTURE_MAX_CHARS`，首尾各约一半，中间插入 `…[中间省略 N 字]…`，省略标记计入预算；不会切出孤立代理对；触发时节选范围标记为 `<scope>+excerpt` 且 `prompt_truncated=1`。

### 明确不支持

- 图片、PDF、音视频内容本身不下载、不解码、不 OCR。
- 文件 ID、签名 URL、完整本地路径不入库。
- 客户端重发的历史上下文、system/assistant 消息不作为正文。
- 不提供"真实人工提问次数"。

## 2. 改动文件与状态

| 文件 | 变更 |
|---|---|
| `src/extractor.ts` | 重写为协议化提取；新增内容概要；版本升至 `extract-v2` |
| `src/redact.ts` | 新增签名 URL、Unix/Windows 路径规则；新增 `excerptHeadTail`；版本升至 `redact-v2` |
| `src/proxy.ts` | 关闭采集时不做正文复制与 JSON 解析；实际字节计量；头尾节选；内容概要入库 |
| `src/config.ts` | 新增 `CAPTURE_MAX_TOTAL_BYTES` 下限调整 |
| `src/store/migrations.ts` | 迁移 v2：新增 `request_bytes`、`request_bytes_complete`、`content_summary` |
| `src/store/types.ts`、`store.ts` | 新字段映射；新增正文结果归并与字节统计查询 |
| `src/admin.ts` | `capture-quality` 返回正文结果分布、字节统计、提取版本分布 |
| `src/ui.html` | Botanical 视觉；正文结果分布卡；详情展示字节、版本、附件概要 |
| `test/extraction.test.ts` | 新增 19 项：A01、A02、A05–A08、A10 及节选边界 |
| `test/capture-policy.test.ts` | 新增 10 项：A03、A04、A05、A09、A11–A13 |
| `test/helpers.ts` | 支持 `/v1/messages`、可挂起的 SSE 上游、配置失败时清理 |
| `test/unit.test.ts`、`test/admin.test.ts` | 适配新返回值结构；登录路径回归 |

迁移：仅在 SQLite 上实际执行过（生产库版本 1→2）。PostgreSQL 迁移未实测，但使用同一 `ALTER TABLE ADD COLUMN` 语句；旧记录新列为 `NULL`。

回退：停止容器、恢复上一镜像即可；数据库新增列为可空，不影响旧代码读取。

## 3. A01–A14 验证证据

| 编号 | 结果 | 证据 |
|---|---|---|
| A01 | 通过 | `extraction.test.ts`「A01 普通用户问题按协议提取」 |
| A02 | 通过 | `extraction.test.ts`「A02 小段代码随问题一起保留」 |
| A03 | 通过 | `capture-policy.test.ts`「A03 工具材料后的独立任务文字」 |
| A04 | 通过 | `capture-policy.test.ts`「A04 长文本在代理层被头尾节选」 |
| A05 | 通过 | `capture-policy.test.ts`「A05 只有附件时无正文」、`extraction.test.ts` 附件概要 |
| A06 | 通过 | `extraction.test.ts`「A06 最新输入只有图片时不回填历史问题」 |
| A07 | 通过 | `extraction.test.ts` 三条：Chat 工具角色 / Anthropic tool_result / Responses 工具输出 |
| A08 | 通过 | `extraction.test.ts`「A08 工具结果与普通文本同时出现」 |
| A09 | 通过 | `capture-policy.test.ts` 三条：字节计量、超限继续计量、并发预算耗尽与回收 |
| A10 | 通过 | `extraction.test.ts`「A10 先脱敏再节选」「A10 签名 URL 与本地路径被移除」 |
| A11 | 通过 | `capture-policy.test.ts`「A11 关闭时无正文、无解析」「A11 开启采集后上游 401」 |
| A12 | 通过（本地） | `capture-policy.test.ts`「A12 上游未结束前客户端即可读到第一段」；**生产环境未演练** |
| A13 | 通过 | `capture-policy.test.ts`“A13 无正文请求仍计入原生用量总量” |
| A14 | 部分 | 历史 `extract-v1` 记录生产已验证不被重写；鉴权与队列满/写库故障沿用既有测试（`admin.test.ts`、`edge.test.ts`）；**生产故障演练未做** |

完整测试：`npm run typecheck` 通过，`npm test` 75 项全部通过。

## 4. 管理界面合成样例

已用本地合成数据（7 条请求覆盖全部结果类型）截图验收：

- 全量原生用量与正文子集分开显示。
- 「正文结果分布」：已采集文本 1、已截断节选 1、仅元数据 2、资源受限 1、解析或脱敏失败 1、采集关闭 1、已过期 0。
- 请求体计量：合计 14.9 MiB、最大 9,437,184 B、完整 7 条、未读完 0 条。
- 提取版本分布：`extract-v2` 6 条、`none` 1 条。
- 列表标签区分：已采集文本 / 已截断 / 仅元数据 / 资源受限 / 采集故障 / 采集关闭，并保留原始 `skip_reason`。
- 详情显示：提取版本、截断标记、请求体字节与完整标记、附件类型与声明大小。

## 5. 字节计量与资源边界

- 计量来自收到的每个数据块，不读 `Content-Length`，超限后继续累加。
- 关闭采集时仍计量，但不复制、不解析正文。
- 解析完成后立即释放缓冲引用；预算在 `finalize`（含取消、失败路径）释放。
- **配置的 256 MiB 只是采集缓冲预算，不是进程 RSS 上限**；完整解析还会产生 Buffer、字符串与 JSON 对象。未做 RSS 压测。
- 未把 Token 换算当作内存或覆盖率实测。

## 6. 尚未验证

1. **生产 A12**：真实客户端在 SSE 首段到达即读取的行为未在生产演练。
2. **生产 A14**：队列满、写库故障、分析库断开未在生产演练。
3. **PostgreSQL 迁移**：仅 SQLite 实测。
4. **真实覆盖率**：上线后需按 `request_bytes` 与 `resource limited` 比例重新评估，之前的“约七成超限”是 Token 换算估算。
5. **业务确认**：正文采集用途、告知与保留期仍需使用方确认。

阶段结论：**功能行为**已实现并通过本地测试；**本地验证**通过（75 项）；**生产验证**仅完成一次真实请求（`extract-v2` 采集、脱敏、字节计量、日志关联均正确），流式与故障场景尚未在生产验证。
