# web：验收控制台

TypeScript + Vite，直接消费 B 的 HTTP API 和 `@verdict/protocol` schema。浏览器里不验签、不重算摘要、不判定证明，也没有模拟通过开关或私钥；PI 模型只在服务端运行。设计依据见 [018 决定](../../docs/decisions/018-frontend-redo.md)。

## 本地运行

Node 22.23.3，在仓库根目录：

```bash
npm ci --ignore-scripts
npm run dev:init
npm run dev:start
npm run web
```

打开 http://127.0.0.1:5173 。默认后端为 3001，第二实例为 3002；如需改动，在启动或构建时设置 `VITE_PRIMARY_API`、`VITE_SECONDARY_API`（公开地址，不能带认证信息）。开发服务器只监听 127.0.0.1，并拒绝通过 `/@fs` 读取工作区的 `.local`、密钥、数据库和 `.git`。

## 结构

- `src/main.ts`：外壳。顶栏显示两个实例的连接状态和可信上下文；站点路线上的包裹会滑到当前站点；数字键 1–9 跳站，`` ` `` 开关工程抽屉。
- `src/drawer.ts`：工程抽屉，记录页面实际发出的请求和响应，并按 JSON Pointer 在原始证据包中高亮字段。
- `src/stations/`：九个站点。

| 站点 | 内容 | 主要接口 |
| --- | --- | --- |
| 01 任务登记 | TaskSpec 表单与请求预览；同一 requestId 原样重放与改参重放（409）；响应丢失时重试同一请求 | `POST /api/runs` |
| 02 交付追踪 | 场景一键运行；路线图上的包裹、核验盖章、拒收退回、证据条码与最新在上的事件轨迹；第二实例自动复验（仅限本页发起的运行） | `/api/runs`、`/api/evidence`、第二实例 `/api/evidence/import`、`/api/replays` |
| 03 证据封存 | manifest 标签、条码与证据码；逐项检查及证据位置；下载原始 bundle 与 manifest | `/api/evidence/:id`、`/bundle`、`/manifest` |
| 04 独立复验 | 第二实例或本机重算；历史证据开关前后的排序对照；篡改副本后导入被拒；命令行复验指引 | 第二实例 `/api/evidence/import`、`/api/replays`、`/api/selection` |
| 05 候选与观测 | 声明能力与实测指标分开展示；实时 RPC 观测；排序对照 | `/api/services`、`/api/observations`、`/api/selection` |
| 06 Agent 执行 | PI 自然语言任务、执行过程、绑定条件、运行结果与 Guard 决定 | `/api/agent/*`、`/api/guard/tasks/:id` |
| 07 动作轨迹 | 三个录制回放（不调用接口）与按游标增量读取的实时图 | `/api/agent/runs/:id/graph` |
| 08 外审与报告 | 受监任务时间线（硬规则拦截与模型拦截分开）、签名安全报告的导出、导入、复验与规则候选 | `/api/guard/*` |
| 09 钱包审查 | 浏览器钱包签名前审查；服务器不签名、不广播 | `/api/wallet/*` |

`src/graph/model.ts` 与 `src/wallet/provider.ts` 是业务逻辑，`tests/integration/` 也在使用，修改时需要一起跑集成测试。

## 验证

```bash
npx playwright install chromium
npm run test:e2e
```

14 条浏览器测试使用隔离的真实 A/B 服务和 SQLite（前端 5174，后端 3101/3102），覆盖范围见 [e2e 说明](../../tests/e2e/README.md)。

## 尚未实现

- 链上存证 adapter 和合约：发布状态如实显示 `not_requested`。
- 证据码只显示文本 URI，没有二维码。
- 篡改挑战中“修改后重新封签”的进阶关卡需要服务端接口，目前没有。
- 历史任务检索。
