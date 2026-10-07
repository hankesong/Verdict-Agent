# Verdict 付款前端

TypeScript + Vite 页面直接消费 STAGING 的 HTTP API 与 `@verdict/protocol`。浏览器不持有私钥，不生成审查 verdict，不执行服务端验签或证明核验。当前整合范围见 [025](../../docs/decisions/025-staging-frontend-integration.md)。

## 运行

使用 Node 22.23.3，在仓库根目录：

```bash
npm ci --ignore-scripts
npm run dev:init
npm run dev:start
npm run web
```

默认打开 http://127.0.0.1:5173/#wallet。已有服务时只需运行网页。`VITE_PRIMARY_API` 与 `VITE_SECONDARY_API` 指定主、第二实例，默认为 3001 / 3002；地址不得包含认证信息。自定义前端端口需要匹配后端 CORS 配置。`npm run build` 构建网页与后端，`npm run web:preview` 预览构建产物。

## 页面与真实接口

- 付款工作台：新建付款、本机常用条件、付款记录；最近操作放在可折叠侧栏。条件按账户与网络隔离，原条件与本次交易独立提交，并列展示地址、金额、网络和费用等差异。
- 钱包连接：EIP-6963 发现与 EIP-1193 账户、网络、交易请求。要求 `wallet-review-v2` 会话，账户／链／provider 变化使旧审查与手写确认失效。
- 逐笔确认：每次签名前手写姓名，不识别、不保存、不上传笔迹。先 confirm，再 consume，成功后请求钱包签名；拒签、刷新和过期不复用旧许可。确认响应丢失时读取原记录核对，不重复确认。
- 受限合约操作：由 `supportedOperations` 控制入口，使用 viem 固定 ABI 编码 ERC-20 transfer / approve。是否放行由后端的配置、模拟、追踪和审查决定；不提供任意合约漏洞审计。
- 快递路线：后端钱包图事件逐条成卡，包裹沿实际连线移动，到站停留约 200ms。追加事件与重排保留当前运动位置；分页、缺口恢复不补造已执行步骤。刷新历史与减少动态效果设置直接定位，手机采用纵向路线。
- BOT 原生币回执：首次 broadcast 上报哈希，后续 receipt/recheck，每 3 秒检查一次，最多 12 次或 2 分钟。未知保持未知，回执、状态复查和证据分开显示。证据从后端下载，第二实例重新查询并复验。
- 旧账户验收、证据、服务、PI、Agent 活动和 Guard 工具保留在“审计工具”中，继续使用原接口。

本机付款条件是用户预填配置，不是服务端可信授权；付款历史目前使用浏览器索引，不是后端分页查询。条件、取消、异常和新建付款保留独立 review。外部文本转义后呈现。

## STAGING 后续接线

STAGING 后端已提供历史／actions、风险 override、代币与多链后验、持久回执跟踪以及 Agent 防御层授权／提议接口。本次迁移保留现有页面流程，以上新增接口尚未接到页面。前端仍只允许 ALLOWED 审查进入确认；合约提交与非 BOT 网络只展示交易哈希，未开启后验入口；本页查询不代表关闭页面后自动启动服务端跟踪。

参考 [钱包查询与操作接口](../../docs/28-staging钱包查询与操作接口.md)、[持久跟踪](../../docs/29-回执跟踪队列.md) 和 [Agent 防御层](../../docs/decisions/024-agent-defense-layer.md)。[故事核实记录](../../docs/28-friday-payment-readiness.md) 是迁移前的能力快照，不能覆盖后端后续交付。

## 本地体验

loopback 的 Vite 开发环境提供“体验流程”；`?experience=1#wallet` 使用仅存于内存的 UI_MOCK 样本，复用付款、手写与路线组件。来源标签可见，不连接钱包、不访问后端、不签名或广播、不写入真实历史或证据。刷新重置，退出返回真实模式；生产构建不启用入口。

## 验证

```bash
npm run typecheck
npx playwright install chromium
npx playwright test
npx playwright test --config playwright.wallet.config.ts
npx tsx --test tests/integration/wallet.test.ts
```

旧浏览器回归使用 3101 / 3102 / 5174；钱包专项使用 3122 / 5183，均使用隔离数据库。钱包后端真实运行，钱包、RPC 与模型为 TEST_TRANSPORT；浏览器测试不代表真实插件实签或公开网络交易完成。覆盖条件对照、手写声明、幂等恢复、失效、拒签、路线运动、模拟隔离、回执预算及移动端布局。结果见 [整合记录](../../docs/decisions/025-staging-frontend-integration.md)。

## 模型设置

侧栏「模型设置」或 `#settings` 仅配置审查 Agent。当前钱包付款由用户手动发起与签名，设置页不提供执行 Agent。API 地址、模型名称、兼容格式、API Key、请求超时和输出上限保存后立即供新任务使用，重启保留。密钥不回填、不写入浏览器存储；地址变化时重新输入密钥。当前正在执行或等待签名的任务会阻止配置切换。保存表示配置生效，不表示已调用模型验证连通。

后端需要本轮 `/api/settings/models` 接口；旧服务不支持时明确禁用保存。该入口沿用本地单用户部署边界，defense 模式不开放。详情及测试见 [027](../../docs/decisions/027-local-model-settings.md)。
