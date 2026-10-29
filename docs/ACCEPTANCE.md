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
- [x] 不同部署的相同日志/请求不串（`test/unit.test.ts`、`test/association.test.ts`）
- [x] PostgreSQL 方言实测（`test/postgres.test.ts`）

## 任务三：受控 Prompt 采集与脱敏检索

- [x] 默认关闭；关闭时全链路无正文（`test/edge.test.ts`）
- [x] 仅提取最后一条 user 文本，system/assistant 不采（`test/unit.test.ts`、`test/proxy.test.ts`）
- [x] 凭证、邮箱、手机号、私钥等在持久化前脱敏（`test/unit.test.ts`）
- [x] 超过采集上限跳过正文但完整转发请求（`test/proxy.test.ts`）
- [x] 上游非 2xx 不采正文（`test/edge.test.ts`）
- [x] 正文队列满降级为 `dropped` 元数据（`test/edge.test.ts`）
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

- 真实 New API 实例的日志接口字段核验（尤其 `NEWAPI_SOURCE_KEY_MODE`）
- 真实账号/Key 分配与共享 Key 比例的现场确认
- 容量压测、脱敏准确率评测、删除演练
- 真实浏览器的管理界面交互测试（已做 HTML/脚本语法与 HTTP 冒烟）
- 第二阶段离线分类
