# HTTP 通知投递服务

业务系统提交已构造好的 HTTP 请求，服务持久化受理，再异步投递。技术栈为 **TypeScript + pnpm + Hono + BullMQ + Redis**。

**持久化受理、有限重试、允许重复。** 外部 2xx 表示送达，不代表供应商业务完成；响应丢失可能引起重发，业务去重需要供应商支持幂等。

- [设计与取舍](docs/DESIGN.md)：系统边界、投递语义、失败策略，以及选型和演进理由。
- [实现细节](docs/IMPLEMENTATION.md)：API/存储不变量、Worker 一致性和部署条件。
- [AI 使用说明](AI_USAGE.md)：我的判断、AI 提供的帮助和被纠正的初版建议。
- [验证记录](docs/VALIDATION.md)：故障测试、持久化验证、代码量和性能比较。

## 快速启动

需要 Docker 和 Docker Compose：

```sh
docker compose up --build -d --wait
```

启动 Redis、API、Worker 和模拟供应商，不需要数据库迁移。Redis 使用命名卷、AOF `always` 和 `noeviction`；宿主机端口只绑定到 127.0.0.1。

- [API 文档](http://127.0.0.1:3000/docs)
- [生成的 OpenAPI](http://127.0.0.1:3000/openapi.json)
- [就绪检查](http://127.0.0.1:3000/readyz)

运行端到端演示：

```sh
docker compose exec -T api env API_URL=http://127.0.0.1:3000 DEMO_TARGET_ORIGIN=http://mock:4000 node dist/scripts/demo.js
```

覆盖成功、503 后恢复、429 Retry-After、400 终止、响应丢失后的供应商幂等。每个场景也验证入口 key 重放。Compose 将退避缩短到 500 ms / 2 s，便于观察。

```sh
docker compose logs --tail=50 api worker
docker compose down
```

`down` 保留数据卷；需要保留任务时不要使用 `down -v`。

## 本地开发与验证

需要 Node.js 24 和 pnpm 10.34.5，支持 nvm 的环境先执行 `nvm use`。

```sh
pnpm install --frozen-lockfile
pnpm db:up
cp .env.example .env
pnpm check
pnpm format:check
pnpm test:e2e
```

测试使用真实 Redis 和独立随机队列，只清理自己的队列，不运行 FLUSHDB。默认地址 `redis://127.0.0.1:56379`，可通过 `TEST_REDIS_URL` 覆盖；需具备 BullMQ 操作和只读 CONFIG GET / INFO 权限，持久化设置与示例保持一致。存储不可用时测试失败，不静默跳过。

`pnpm test:e2e` 自动构建并启动独立的 API、Worker、Redis 和模拟供应商，通过真实 HTTP 验证投递行为。测试会杀死和重启自己的容器，使用随机端口和专用数据卷，结束后清理，不影响演示栈。报告和容器日志写入 `artifacts/e2e/`；Docker 不可用时测试失败。

三个终端分别运行：

```sh
pnpm dev:api
pnpm dev:worker
pnpm dev:mock
```

随后执行 `pnpm demo`。若完整 Compose 已占用端口，先 `docker compose stop api worker mock`，保留 Redis。

本地完整 Compose 栈还支持以下验证：

```sh
# 100 条 1 KiB 请求，真实调用本地 API 和模拟供应商；保留生成的通知
pnpm benchmark

# 会停止 Worker 并 SIGKILL 本项目 Redis，再恢复服务；仅用于演示栈
pnpm exec tsx scripts/check-restart.ts
```

GitHub Actions 配置类型检查、单元/集成测试、E2E、构建和格式检查，并保存 E2E 报告与日志；远程执行结果以实际 CI 为准。

## 业务接口

| 接口                         | 行为                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `POST /v1/notifications`     | 首次持久化返回 202；相同 caller/key/content 返回原 job 和 200；内容冲突返回 409 |
| `GET /v1/notifications/{id}` | 查询自己的状态、尝试预算和失败摘要，不返回目标凭证                              |

入口身份来自 Bearer Token。入口幂等键与供应商的业务幂等 Header 是两套协议。

下面的 URL 用于 Compose；在主机运行 Worker 时改为 `.env.example` 许可的 `http://127.0.0.1:4000`。

```sh
curl -i http://127.0.0.1:3000/v1/notifications \
  -H 'Authorization: Bearer demo-token-change-me' \
  -H 'Idempotency-Key: order-123:inventory-adjustment' \
  -H 'Content-Type: application/json' \
  --data '{"url":"http://mock:4000/success","method":"POST","headers":{"Content-Type":"application/json","Idempotency-Key":"order-123:inventory-adjustment"},"body":"{\"orderId\":\"order-123\",\"delta\":-1}"}'

curl http://127.0.0.1:3000/v1/notifications/REPLACE_WITH_ID \
  -H 'Authorization: Bearer demo-token-change-me'
```

请求和响应 Schema 生成 OpenAPI；`/docs` 使用 CDN 的 Swagger UI，没有外网时仍可读取 `/openapi.json`。

## 实现与运行边界

```text
src/api/          Hono 路由、契约、鉴权、状态查询
src/queue.ts      BullMQ 入队、幂等冲突检查、公开状态映射
src/worker/       注册 BullMQ Worker、HTTP 投递和失败策略
src/domain.ts     请求与投递结果类型
src/target.ts     目标许可及连接时 DNS/IP 检查
redis.conf        持久化与禁止淘汰配置
scripts/          模拟供应商、演示、性能及重启验证
tests/            真实 Redis/HTTP 集成测试与进程故障夹具
```

不再自写领取 SQL、轮询调度、租约回收和并发集合。BullMQ 保存唯一任务状态并负责调度，应用只决定哪些 HTTP 结果需要重试。

主要配置见 [.env.example](.env.example)。调用方 Token、精确 origin 和网络限制应在 API/Worker 保持一致。尝试预算、有效期与退避参数随任务保存。生产禁止私网放行开关，并要求目标 HTTPS；Redis 需要受保护的网络、ACL/TLS 和数据卷，演示配置不能直接用于公网部署。

第一版不自动删除历史 job，以保留查询与入口幂等。内存/磁盘会增长，满载时拒绝受理而不淘汰旧任务。未来需要明确归档和幂等窗口；当前没有完整逐次审计、自动重放、严格顺序、动态签名、业务响应解析和管理后台。

旧 PostgreSQL 原型的数据卷保留，但没有自动迁入新存储；详见[旧原型切换说明](docs/IMPLEMENTATION.md#旧原型切换)。提交仓库为 [Tsukumi233/rc_tsukumi](https://github.com/Tsukumi233/rc_tsukumi)。
