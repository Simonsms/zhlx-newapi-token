# 第一阶段验收清单

对应 [PHASE-1-TASKS.md](PHASE-1-TASKS.md)。每项均已由自动化测试或本地实测覆盖；生产环境仍需按实际部署复核。

## 任务一：原 Key 透传与请求状态查询

- [x] 原 Key 透传到 New API，不在采集表或日志中出现明文（`test/proxy.test.ts`）
- [x] 读取 `X-Oneapi-Request-Id`；无该响应头记 `no_gateway_id`（`test/proxy.test.ts`）
- [x] SSE 逐块转发、`[DONE]` 正常结束（`test/proxy.test.ts`）
- [x] 客户端取消传播到上游，终态记 `client_cancel`（`test/association.test.ts`）
- [x] 上游不可达返回 502 且不阻断代理进程（`test/proxy.test.ts`）
- [x] 未认证/非管理员查询被拒（`test/admin.test.ts`）
- [x] 分析写库失败只计数，不影响转发（`test/edge.test.ts`）

## 任务二：原生日志同步与用量报表

- [x] 增量同步消费、错误、退款日志；重叠回补不重复写入（`test/sync.test.ts`）
- [x] 分页超过单页容量时继续拉取（`test/sync.test.ts`）
- [x] 同步失败保留水位、记录错误，恢复后继续（`test/sync.test.ts`）
- [x] 估算标记 `estimated`、缺失标记 `missing` 且保持 null（`test/sync.test.ts`）
- [x] `quota` 标注为网关额度，不当作供应商成本（UI 与 README）
- [x] 按天/用户/模型分组与筛选（`test/sync.test.ts`）
- [x] 共享账号时按凭证归属，一人一账号时按账号归属（`test/identity.test.ts`）
- [x] 只读直读 New API SQLite 日志库，兼容 v0.13 的 `channel_id` 字段（`test/identity.test.ts`）
- [x] 不同部署的相同日志/请求不串（`test/unit.test.ts`、`test/association.test.ts`）
- [x] PostgreSQL 方言实测（`test/postgres.test.ts`）

## 任务三：受控 Prompt 采集与脱敏检索

- [x] 默认关闭；关闭时全链路无正文（`test/edge.test.ts`）
- [x] 按协议识别角色与内容类型，只取最后一条 user 的普通文本（`test/extraction.test.ts`）
- [x] 最新输入只有图片／附件／工具结果时不回填历史问题（`test/extraction.test.ts`）
- [x] 工具结果内的 text 不与普通用户文本混采（`test/extraction.test.ts`）
- [x] 未知内容类型即使带 text 字段也不采信（`test/extraction.test.ts`）
- [x] 凭证、邮箱、手机号、私钥、签名 URL、本地路径在持久化前脱敏（`test/extraction.test.ts`）
- [x] 长文本按头尾节选，省略标记计入预算且不切出残缺字符（`test/extraction.test.ts`）
- [x] 超过采集上限跳过正文但完整转发请求（`test/proxy.test.ts`、`test/capture-policy.test.ts`）
- [x] 记录实际观察请求体字节与读取完整标记（`test/capture-policy.test.ts`）
- [x] 上游非 2xx 不采正文（`test/edge.test.ts`、`test/capture-policy.test.ts`）
- [x] 正文队列满降级为 `dropped` 元数据（`test/edge.test.ts`）
- [x] 并发采集预算耗尽后推理继续，预算可回收（`test/capture-policy.test.ts`）
- [x] 保留期到期置空正文并标记 `expired`（`test/edge.test.ts`）
- [x] 非管理员不能读详情且不写审计；授权读取写审计（`test/admin.test.ts`）

## 任务四：逐请求关联与联合查询

- [x] 网关请求 ID + 部署 ID 关联；并发请求按本地 ID 区分（`test/sync.test.ts`）
- [x] 一次请求多条源日志逐条保存、按类型汇总（`test/sync.test.ts`）
- [x] `pending → unmatched` 超窗状态转换（`test/association.test.ts`）
- [x] 未匹配/缺失用量保留状态，不填零（`test/sync.test.ts`）
- [x] 全量用量与有正文子集分开统计（`test/sync.test.ts`）
- [x] 采集质量、跳过原因、关联计数可查询（`test/admin.test.ts`、`test/edge.test.ts`）

## 尚未执行

- 生产环境 SSE 首段即时到达与取消链路演练（本地已测）
- 生产环境队列满、写库故障、分析库断开的故障演练
- PostgreSQL 迁移实测（本地仅 SQLite）
- 内网一人一账号环境的接入验证（`IDENTITY_MODE=user`）
- 容量压测、脱敏准确率评测、删除演练
- 真实浏览器的管理界面交互测试（已做 HTML/脚本语法、HTTP 冒烟与合成样例视觉验收）
- 第二阶段离线分类
