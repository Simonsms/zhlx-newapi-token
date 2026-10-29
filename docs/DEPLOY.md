# 实测环境部署说明

本文件记录 2026-10-29 对目标服务器的只读核查结果，以及据此确定的适配方式。核查期间未修改服务器任何配置或数据。

## 实测环境事实

| 项 | 实测值 |
|---|---|
| 主机 | `VM-0-7-ubuntu`，43.162.111.70，Ubuntu / 内核 6.8 |
| New API 部署 | Docker Compose 项目 `new-api`，容器名 `new-api` |
| 镜像 | `calciumion/new-api:latest`，构建时间 2026-04-24，版本标签 `v0.13.0` |
| 端口 | `50085:3000`（宿主机 50085 → 容器 3000） |
| 数据 | `/home/ubuntu/new-api/data/one-api.db`（SQLite，约 78 MB） |
| 日志文件 | `/home/ubuntu/new-api/logs`（`oneapi-*.log`） |
| compose 文件 | `/home/ubuntu/new-api/docker-compose.yml` |
| 入口 | 宿主机 nginx 监听 80，默认站点未反向代理到 50085；对外入口未进一步确认 |
| 服务器运行时 | Node v20.20.0、npm 10.8.2、Docker 27.5.1、Compose v2.32.4 |

### 与研究基线的差异

1. 实测版本 v0.13.0 早于研究基线提交，日志表字段为 `channel_id`（而非新版的 `channel`），本实现已同时兼容两者。
2. 该部署管理员 `access_token` 为空，无法通过 `/api/log/` HTTP 接口导出日志；因此新增了只读 SQLite 日志源。
3. 日志类型实有 `1`（管理）、`2`（消费，71761 条）、`4`（系统/充值），没有 `5`（错误）与 `6`（退款）记录，因此错误事件数为 0 属正常。

### 账号与凭证分配

- 测试环境：**所有人共用 `admin` 账号**（user_id=1），靠 `token_name`（真实姓名）区分人员。共 29 个有消费的凭证。
- 内网环境：**一人一账号**，`user_id` 即人员。

因此本服务不写死归属口径，而由 `IDENTITY_MODE` 控制：

| 值 | 行为 | 适用 |
|---|---|---|
| `auto`（默认） | 区间内只有一个账号且存在多个凭证时按凭证，否则按账号 | 两种环境通用 |
| `user` | 始终按 `user_id` 汇总 | 内网一人一账号 |
| `token` | 始终按 `token_id` 汇总 | 测试环境共享账号 |

`auto` 的判定只依赖数据：测试环境会自动落到凭证口径，内网会自动落到账号口径。

## 真实数据核对

用生产 `one-api.db` 的只读快照跑完整同步（写入本地内存库，未触碰服务器）：

| 指标 | 结果 |
|---|---|
| 同步条数 | 71,761 / 71,761，跳过 0 |
| 耗时 | 9.8 秒（单进程、SQLite 全量回填） |
| 消费事件 | 71,761 |
| 输入 Token | 7,051,379,807 |
| 输出 Token | 42,384,170 |
| 网关额度 | 81,025,647,315 |
| 判定口径 | `token`（1 个账号 / 29 个凭证） |
| 用量来源 | reported 71,601，estimated 160 |

按凭证的额度汇总与 `tokens.used_quota` 逐人完全一致，例如陈华鸿 56,250,633,876、赵祥 2,229,594,602、陈星辉 6,004,448,638，可作为去重与汇总口径正确的交叉证据。

## 部署方案

服务器 Node 为 20，低于本项目要求的 24（依赖原生 TypeScript 执行与 `node:sqlite`），因此用 Docker 部署。

推荐把本服务与 `new-api` 放进同一个 Compose 项目网络，并只读挂载 New API 数据目录：

```yaml
services:
  zhlx-newapi-token:
    build: /home/ubuntu/zhlx-newapi-token
    container_name: zhlx-newapi-token
    restart: unless-stopped
    ports:
      - "50086:8080"
    volumes:
      - ./zhlx-data:/app/data
      # 只读挂载 New API 日志库，供 SQLite 直读同步
      - /home/ubuntu/new-api/data:/newapi-data:ro
    environment:
      PORT: "8080"
      HOST: "0.0.0.0"
      DEPLOYMENT_ID: prod-43.162.111.70
      DATABASE_URL: file:/app/data/zhlx.db
      UPSTREAM_URL: http://new-api:3000
      ADMIN_API_TOKEN: ${ADMIN_API_TOKEN:?set ADMIN_API_TOKEN}
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET}
      CAPTURE_ENABLED: "false"
      NEWAPI_LOG_SYNC_ENABLED: "true"
      NEWAPI_SQLITE_PATH: /newapi-data/one-api.db
      IDENTITY_MODE: auto
    networks:
      - new-api_default

networks:
  new-api_default:
    external: true
```

启动前先把 `CAPTURE_ENABLED` 保持 `false`，只验证转发、同步与关联；确认无误后再考虑开启正文采集。

`DATABASE_URL` 若改用 PostgreSQL，按主 README 配置即可；SQLite 适合当前约 7 万条日志的规模，若持续增长到千万级建议迁移。

## 实际部署记录（2026-10-29）

已在目标服务器部署，**未改动 New API 现有容器与配置**，也**未切换任何流量**。

| 项 | 值 |
|---|---|
| 代码目录 | `/home/ubuntu/zhlx-newapi-token` |
| Compose 文件 | `docker-compose.standalone.yml` |
| 镜像 | `zhlx-newapi-token:0.1.0` |
| 容器 | `zhlx-newapi-token`，`restart: unless-stopped` |
| 端口 | 宿主机 `50086` → 容器 `8080` |
| 网络 | 加入 `new-api_default`，上游为 `http://new-api:3000` |
| 本服务数据库 | `/home/ubuntu/zhlx-newapi-token/data/zhlx.db`（SQLite） |
| 凭据 | 同目录 `.env`（权限 600），含随机生成的 `ADMIN_API_TOKEN` 与 `SESSION_SECRET` |
| 正文采集 | 关闭 |
| 日志同步 | 开启，只读挂载 `/home/ubuntu/new-api/data` |

常用运维命令：

```bash
cd ~/zhlx-newapi-token
sudo docker compose -f docker-compose.standalone.yml ps
sudo docker logs --tail 50 zhlx-newapi-token
sudo docker compose -f docker-compose.standalone.yml restart
grep ^ADMIN_API_TOKEN .env        # 登录管理页所需令牌
```

首次启动遇到并已修复的问题：Docker 自动创建的 `./data` 目录属主为 root，容器以 `node`（uid 1000）运行导致建库失败。现已在宿主机执行 `chown -R 1000:1000 data`。若重建目录，需重复该步骤。

### 部署后验证结果

| 检查 | 结果 |
|---|---|
| `GET /healthz` | 200，`capture_enabled:false`，队列为空 |
| `GET /admin` | 200 |
| 未认证访问 `/admin/api/overview` | 401 |
| 经代理访问 `/v1/models` | 401（透传 New API 鉴权结果，链路通） |
| 首次全量同步 | 71,763 条，包含历史 7 个月数据 |
| 归属口径 | 自动判定为 `token`（1 个账号 / 29 个凭证） |

与源库直查对比时出现 1~2 条差额，原因是源库持续有新请求写入，而同步只覆盖到「当前时间 − 30 秒安全滞后」的窗口；下一轮 5 分钟同步会自动追平。这是预期行为，不是丢数据。

## 仍未确认

- 对外域名与 TLS 入口：宿主机 nginx 默认站点未指向 50085，需确认客户端实际访问路径后再替换入口。
- 是否存在绕过代理直连 50085 的路径（如安全组直接放通 50085）。
- 正文采集的用途、告知与保留期，需由使用方确定后才能开启 `CAPTURE_ENABLED`。
- 该部署没有错误日志（type 5），如需错误率指标须先在 New API 开启错误日志记录。
