# 025：钱包付款前端合入 STAGING

2026-10-07。用户要求将现有前端接入 STAGING 工作分支，沿用“前端由本工作线负责、后端由另一工作线负责”的分工。

## 整合方式

来源为 `Verdict-Agent-wallet-v2` 的 `feat/wallet-review-v2` 未提交前端，目标为 `Verdict-Agent-staging` 的 `staging@7a6d896`。整合开始时目标工作树干净；共享网页文件与来源提交基线一致，无内容冲突。只迁移网页、前端测试和相关文档，不合并来源的后端或协议修改。

首页改为付款工作台，包含本机常用条件、付款记录、条件与实际交易对照、逐次手写确认、钱包签名以及逐事件快递路线。旧审计、Graph、Guard 页面收进审计工具，原功能保留。模拟体验仍只在本地开发模式启用，并标为 UI_MOCK。

网页依赖补入已有版本的 viem，仅更新锁文件中 web workspace 的声明。钱包浏览器测试使用独立端口 3122 / 5183，并复用 STAGING 的真实后端与原有测试 harness；未修改后端 harness。`tests/integration/wallet.test.ts` 测的是前端 GuardedWallet，随适配器升级为 v2 会话、手写声明、confirm、consume 顺序与失效检查，不保留 v1 自动发送入口。

## 接线范围

已接现有钱包 v2 会话、创建与轮询审查、confirm、consume、cancel、graph，以及 BOT 原生币 broadcast、receipt/recheck、证据下载与第二实例复验。手写笔迹不保存或上传，未知结果不改写成失败。

本次是现有前端迁移，不扩大页面操作范围。STAGING 新增的服务端历史／actions、风险 override、代币与多链后验、持久 receipt watch、Agent 防御层授权／提议 API 尚未接到页面。页面记录与付款条件仍明确为本机；回执跟踪仍为本页有界查询。上述 API 在后端已存在，不能写成后端尚未实现，也不把尚未接通的能力写成完整网页流程。

## 验证

在 STAGING 上使用 Node 22.23.3 完成验证：

- `npm run typecheck` 通过，包含后端与前端构建；补入钱包 Playwright 配置后，`npx tsc -p tsconfig.check.json` 再次通过。
- `npx playwright test --config playwright.wallet.config.ts`：20 / 20 通过。
- `npx playwright test`：旧审计、Graph、Guard 共 11 / 11 通过。
- `npx tsx --test tests/integration/wallet.test.ts`：前端适配器 5 / 5 通过。
- 桌面与 390px 移动端截图已核对，`git diff --check` 与新增文档链接检查通过。
- 迁移前后逐文件摘要比对确认 `apps/server`、`packages/protocol` 均未修改；后端测试目录仅同步前端适配器的 `wallet.test.ts`。

测试钱包、RPC 与模型为 TEST_TRANSPORT，不涉及公开网络交易或真实插件实签。构建保留依赖自身的注释／`use client` 提示，不影响完成。
