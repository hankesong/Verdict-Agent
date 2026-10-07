# B 后端

已实现真实服务调用、A 包验收、有界替换、SQLite 原子采用、内容寻址证据、导入与第二实例复验、RPC 观测和独立发布状态。默认仅绑定 loopback。公开入口为 `start_server`、`Engine`、`load_server_config`；不会复制内核证明或验签逻辑。

```bash
npm run dev:init
npm run server -- --config .local/b-demo/local-one.json
# 另一个终端；仍需独立启动 demo 服务，或直接使用根目录 npm run dev:start
npm run server -- --config .local/b-demo/local-two.json
```

`src/config.ts` 加载可信策略；`store.ts` 负责 WAL SQLite、内容寻址及原子消费；`engine.ts` 编排真实核验、排序和发布队列；`index.ts` 提供 HTTP API；`main.ts` 提供进程入口。每个数据库只允许一个进程写入。请求在出网前登记，预算报价先保留；同 requestId 的相同请求返回相同 runId，变更内容或选择选项返回 409。进程异常中断后不自动重发未完成请求，而是 STOPPED/INTERRUPTED。

`publishForTest(evidenceId, retryOf?)` 是受信代码调用的队列故障测试边界：原子登记 attemptId、pending、failed；显式 retryOf 必须匹配上一失败尝试，重复重试不重复消费。无适配器时保持 not_requested。未接 C adapter、没有链上确认。

测试：`npm run test:b`；全流程与 API 见 [B 实现与复验](../../docs/13-B包实现与复验.md)。当前面向本地联调，未实现公众多租户认证、分页归档或跨机器分布式队列。

宿主工具接口（不直接供 PI 调用）：GET `/api/tools` 导出八个工具的参数 schema；POST `/api/tools/call` 严格分发到现有 Engine，不复制核验代码。完整参数及架构见 [工具与出海验收](../../docs/16-Agent工具与出海验收.md)。工具结果不是模型裁决；runId、HTTP 200、复验 COMPLETED 都不能代替验收 PASS。

可选 `rpcObservationOrigin` 来自操作者配置，附于 RPC 观测并进入分组，默认不输出。它不改变证据包和数据结论。Windows 可运行根目录 `npm run verify:local` 自动验证实际五进程与工具消费路径。

PI 可选模块：`agent-service.ts` 提供直接 PI 执行、任务绑定、执行会话和事件（旧草案 API 仅保留兼容）；`pi-runtime.ts` 绑定实际 PI 1.0.4／兼容模型接口；`agent-store.ts` 增量持久化。固定流程和 PI 共用 `engine.ts` 的单次调用／核验／预算／采用。未配置时 PI 明示不可用，固定流程不受影响。命令、接口、测试与真实模型联调状态见 [PI 说明](../../docs/15-PI接入与复验.md)。

模型超时采用首有效事件／流空闲／单请求总时间三层限制，MODEL_RESPONSE 仅保存计时元数据；180 秒任务预算仍可优先中断。配置与实际复验见 [超时适配](../../docs/18-模型超时适配与复验.md)。

## Guard

直接 PI 任务要求独立 `guard` 配置。外审边界、一次性执行许可、安全报告与规则维护命令见 [实现记录](../../docs/20-Verdict-Guard.md)。固定流程与历史草案接口不受此模块保护。

外部材料使用独立 `material-triage.ts` 分类，角色／引用关系／请求改变的行为与执行许可分离。`materialPolicy` 默认 required；隔离必需材料时 `STOPPED / MATERIAL_REQUIRED`，模型尚未执行；调用方明确选 optional 时才允许隔离后继续，模型故障仍停止。`GET /api/guard/tasks/:id` 的 `materialTriage` 和 AgentSnapshot 的 `materialHandling` 仅增量新增；旧快照可读。`npm run test:guard` 包括材料、并发、硬边界和第二实例测试。API 示例、真实模型结果与剩余误拦见 [修复与复测](../../docs/25-Guard材料误拦修复与复测.md)。

后续 [v2 复验](../../docs/26-Guard材料审查v2复验.md) 区分提示词版本和本地材料处置版本，判断“实际要求改变什么”，修复引用外的一致提醒误隔离。旧快照保持原结论，不能用新版提示词回写历史成绩；新材料规则仍不提供执行许可。

可选 `observability` 配置将新的 PI/Guard 事件投影到本地 Pi Observability，使用持久 outbox；只读状态及链接在 `/api/agent/runs/:id/observability`。见 [安装与边界](../../integrations/pi-observability/README.md)。

只读图接口 `/api/agent/runs/:id/graph?after=0` 输出独立持久化的脱敏阶段记录，支持增量游标及旧任务无记录状态；不依赖观测服务。详见 [活动图](../../docs/22-Agent活动图.md)。

钱包后端现有审查之外增加广播哈希核对、receipt 与历史状态观察，图 API `/api/wallet/reviews/:id/graph` 只输出脱敏事件。`wallet-observation.ts` 负责配置 RPC 的一致性检查；`wallet-evidence.ts` 单独保存本地观察包并独立重算，永不使用 A 的 Ethereum 证据目录／采用状态。见 [运行与 API](../../docs/24-钱包活动图与BOT测试网观察.md)。

钱包后端 v2 新增浏览器会话版本、逐次手写完成声明的绑定与一次性消费；配置后可审查固定代码哈希的 ERC-20 transfer/approve，并以真实 RPC 模拟核对效果。创建请求必须使用 `wallet-review-v2`，旧前端需要适配，当前未完成新网页签名流程。API、配置、错误边界与验证见 [钱包后端 v2](../../docs/27-钱包后端v2.md)。专项 `npm run test:wallet`；可选本地真实 EVM `npm run verify:wallet:evm`。

staging 增加 `/override`（仅模型拒绝／不确定且确定性检查完成）、完整 calldata 回报绑定、代币 receipt 事件及历史余额／allowance 观察、`wallet-observation-v2` 独立复验。硬规则仍不可覆盖，详见 [020](../../docs/decisions/020-staging-risk-and-token-receipts.md)。

`GET /api/wallet/reviews` 提供筛选与键集分页，`GET /api/wallet/reviews/:id/actions` 投影当前可用操作；两者不触发 RPC／模型或写入。`wallet-history.ts` 负责摘要与查询，`WalletReviews.actions` 复用本地会话／策略／摘要校验。`verify:wallet:evm` 现覆盖本地测试驱动发送后的真实 EVM 回执与第二实例复验，后端仍不广播。前端交接见 [28](../../docs/28-staging钱包查询与操作接口.md)。

`wallet-receipt-watch.ts` 保存独立回执跟踪队列；`POST /api/wallet/reviews/:id/receipt/watch` 显式启动，GET 查询，`/stop` 与 `/resume` 控制后续查询。复用原 recheck，不增加交易副作用，旧 DTO 不变。限额、重启恢复和前端接线见 [29](../../docs/29-回执跟踪队列.md)。

`payment-defense.ts` 提供防御层授权／任务／提议／一次性执行凭证；`defense-auth.ts` 分离 OWNER、AGENT、EXECUTOR。启用 `defense` 后旧钱包写接口关闭，执行适配器使用 `examples/consumer/src/defense.ts`；材料摘要、差异、预算和多链 finality 约束见 [30](../../docs/30-Agent防御层API.md)。
