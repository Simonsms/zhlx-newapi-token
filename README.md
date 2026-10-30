# zhlx-newapi-token

New API 前置采集代理、原生日志用量同步与管理员查询服务。第一阶段交付：Prompt 采集、用户与 Token 关联、管理员查询。离线分类属于第二阶段，本仓库尚未实现。

## 能力范围

- **透明转发**：客户端继续使用原 New API Key；代理保留原请求头、请求体和流式响应，SSE 逐块转发，不保存回答正文。
- **受控采集**：按协议识别角色与内容类型，只提取最后一条 user 的普通文本；工具结果与附件只记有限概要；长文本头尾节选；入队前完成脱敏；默认关闭。
- **全量用量同步**：从 New API 管理员日志接口或只读 SQLite 日志库增量同步消费/错误/退款事件，与是否采集到正文无关。
- **请求关联**：用 `X-Oneapi-Request-Id` 与原生日志 `request_id` 在同一部署内关联；本地请求 ID 区分并发请求。
- **人员归属口径可切换**：`IDENTITY_MODE=user` 适合一人一账号，`token` 适合共享账号按 Key 区分，`auto` 依据数据自动判定。
- **管理员查询**：日期/账号/凭证/模型/场景筛选、用量汇总与分组、采集质量、关联状态、单请求下钻；正文读取写审计。
- **二期场景分类**：离线批量打标（keyword 规则或 LLM），固定六类标签，保存分类器版本、置信度与待复核标记，展示覆盖率与分布。
- **双数据库**：SQLite（本地试用）或 PostgreSQL（生产推荐）。

验收对照见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。目标服务器实测结果与部署方案见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 快速开始（SQLite）

```bash
npm install
cp .env.example .env
# 编辑 .env：设置 UPSTREAM_URL、ADMIN_API_TOKEN 和 SESSION_SECRET
npm start
```

- 管理界面：`http://127.0.0.1:8080/admin`
- 健康检查：`http://127.0.0.1:8080/healthz`
- 推理入口：`http://127.0.0.1:8080/v1/...`，需在 New API 前面替换原域名。

启动前请把 `CAPTURE_ENABLED` 保持为 `false`，先验证转发与关联，再对试点凭证开启正文采集。

## 生产部署要点

1. **数据库**：`DATABASE_URL=postgres://user:pass@host:5432/db`，首次启动自动建表。
2. **入口流量**：把原 New API 域名解析/网关指向本服务；New API 推理端口只允许本服务访问，避免绕过采集入口。
3. **管理员令牌**：`ADMIN_API_TOKEN` 使用高强度随机值；HTTPS 部署设置 `SESSION_COOKIE_SECURE=true`。
4. **日志同步**：`NEWAPI_LOG_SYNC_ENABLED=true`，配置 `NEWAPI_BASE_URL` 与只读权限的 `NEWAPI_ADMIN_TOKEN`；部分版本需 `NEWAPI_ADMIN_USER_ID`。
5. **反向代理**：外层 NGINX 关闭缓冲（`proxy_buffering off`、`proxy_request_buffering off`），否则 SSE 会被聚合。`proxy_read_timeout` 按模型最长静默期设置。

也可用 Docker：

```bash
cp .env.compose.example .env
# 填写必填变量后
docker compose up -d --build
```

```nginx
location /v1/ {
    proxy_pass http://zhlx_newapi_token;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_next_upstream off;
    proxy_read_timeout 600s;
}
```

## 关键配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:3000` | New API 地址 |
| `DATABASE_URL` | `file:./data/zhlx.db` | SQLite 或 PostgreSQL 连接串 |
| `ADMIN_API_TOKEN` | 空 | 未设置时管理接口返回 503，代理仍可用 |
| `CAPTURE_ENABLED` | `false` | 正文采集总开关 |
| `CAPTURE_ROUTES` | 四类文本接口 | 采集范围，逗号分隔 |
| `CAPTURE_MAX_BYTES` | 262144 | 请求体采集上限，超限只记元数据 |
| `CAPTURE_MAX_CHARS` | 8000 | 保存文本字符上限；超出时头尾各留一半并标注省略 |
| `CAPTURE_MAX_TOTAL_BYTES` | 268435456 | 在途采集缓冲总预算，超出只记元数据 |
| `PROMPT_RETENTION_DAYS` | 30 | 正文保留期，到期置空并标记 `expired` |
| `QUEUE_MAX_CONTENT` | 500 | 正文队列容量，满时丢弃正文并计数 |
| `NEWAPI_LOG_SYNC_ENABLED` | `false` | 原生日志同步开关 |
| `NEWAPI_SQLITE_PATH` | 空 | 同机部署时直读 New API 的 SQLite 日志库，设置后优先于 HTTP 接口 |
| `NEWAPI_SOURCE_KEY_MODE` | `composite` | 去重键策略；仅确认日志 id 稳定时才用 `id` |
| `IDENTITY_MODE` | `auto` | 人员归属：`user` 一人一账号、`token` 共享账号按 Key、`auto` 自动判定 |
| `ASSOCIATION_PENDING_WINDOW_MS` | 300000 | 超过该窗口仍无日志则标为 `unmatched` |
| `CLASSIFIER_MODE` | `off` | 二期分类：`off`/`keyword`/`llm` |
| `EXCLUDE_TOKEN_IDS` | 空 | 分类服务等专用凭证，分组统计时排除 |

完整列表见 [.env.example](.env.example)。

## 数据口径

- `usage_event`：原生日志镜像，按稳定源事件键去重，保存 `log_type`、`user_id`、`token_id`、模型、Token、quota 与 `usage_source`。
- `proxy_request`：代理入口请求，保存本地/网关请求 ID、传输终态、采集状态、脱敏文本与提取版本。
- `sync_state`：同步水位、上次成功、最近错误与累计事件数。
- `admin_audit`：管理员读取请求详情的审计记录。

正文结果：`captured` 且未截断为「已采集文本」，截断为「已截断节选」，`skipped` 中附件/工具/无文本为「仅元数据」，超限与预算不足为「资源受限」，解析或脱敏失败为「采集故障」。

展示规则：调用数按原生消费事件统计；Token 缺失记为 null 并计入 `missing_events`，不按零处理；quota 是网关结算额度，不是供应商现金成本；有 Prompt 的子集单独展示，不参与全量总量；关联状态区分 `matched`/`pending`/`unmatched`/`no_gateway_id`。

人员归属：`ACTIVE_USERS` 按账号计，`ACTIVE_TOKENS` 按凭证计。共享一个账号时账号数恒为 1，应看凭证维度；一人一账号时两者接近。管理页会显示当前生效口径与区间内的账号数、凭证数。

## 安全边界

- 不保存明文 API Key、Authorization、Cookie；采集副本在首次持久化前去除凭证与常见敏感实体。
- 正文与元数据使用不同队列预算；队列满、脱敏失败或库不可用时只跳过正文并计数，不影响推理。
- 管理接口要求签名会话 Cookie；正文读取与查询写审计；管理页面下发 nonce CSP。
- 本方案不承诺进程崩溃时正文零丢失；原生日志也不是原子财务账本。

## 验证

```bash
npm run typecheck
npm test
```

- 75 项测试覆盖：转发与 SSE、取消传播、协议化提取、工具/附件排除、头尾节选、脱敏边界、实际字节计量、并发预算、采集开关、队列满降级、写库失败计数、日志同步去重、估算/缺失标记、跨部署隔离、关联状态、管理员认证与越权、PostgreSQL 方言、SQLite 直读与人员归属口径。
- PostgreSQL 用例默认跳过，设置 `TEST_POSTGRES_URL` 后启用。
- 已用临时 PostgreSQL 16 实例实测迁移、去重、分组与详情查询。

## 尚未覆盖

- 真实 New API 部署版本、日志后端与账号/Key 分配：已完成一次只读核查（v0.13.0 + SQLite + 共享 admin 账号），详见 [docs/DEPLOY.md](docs/DEPLOY.md)；内网一人一账号环境尚未接入验证。
- 未运行真实流量的容量压测、脱敏准确率评测与删除演练。
- 第二阶段离线分类、标签版本与场景统计不在本仓库范围。
