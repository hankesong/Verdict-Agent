# 浏览器端到端测试

`npm run test:e2e` 构建后运行 Playwright Chromium。首次使用先执行 `npx playwright install chromium`（Linux 缺系统库时按 Playwright 提示安装）；CI 使用 `--with-deps`。

测试在系统临时目录生成测试密钥和独立数据库，通过真实 HTTP 调用 A 内核，前端 5174、后端 3101/3102、签名服务临时端口。不会读写 `.local/instances` 或复用用户已启动的服务。

已运行 7 条测试：

1. 签名错块／错值拒收，自动替换到 PASS；原证据字节下载一致；第二实例重验与适用证据排序对照。
2. 全失败明确 STOPPED，无事实卡；随后正常任务成功并可刷新恢复。
3. 模拟的是“提交响应丢失”，后端仍实际执行；重试使用相同 requestId/runId，不用 mock 替代核验。
4. 手机布局、后端连接失败以及 Vite 拒绝读取工作区私有文件。

5. 新请求立即清除上一笔已采用结果；轮询中断锁定新提交，重新连接恢复原任务。

上述原审计用例仅覆盖其对应视图；钱包 v2 使用下方独立专项，浏览器测试不能证明公开网络交易或真实插件实签完成。

新增 PI 浏览器路径：自然语言任务 → 直接 PI 工具循环 → 真实签名服务和 A 验收；含缺项停止、补充后重新执行与刷新恢复。模型响应是 TEST_TRANSPORT，实际执行的是 PI SDK 和真实后端；不能据此宣称真实模型联调通过。


## 钱包前端专项

`npx playwright test --config playwright.wallet.config.ts` 使用独立端口 3122 / 5183 和临时 SQLite，运行 20 条钱包付款路径。`start-wallet.mjs` 复用 STAGING 后端与既有 harness，仅在启动脚本内配置端口、CORS、RPC 和模型替身。默认 `playwright.config.ts` 排除此专项，避免混用实例。

覆盖 v2 会话与逐次手写、confirm / consume 顺序、丢失响应恢复、拒签、会话变化、ERC-20 固定 ABI 预审、本机付款条件与异常／取消历史、逐事件路线运动和缺口恢复、UI_MOCK 数据隔离，以及 UNKNOWN 回执重试预算。原生币回执通过真实服务端路径，RPC／模型／钱包为 TEST_TRANSPORT；代币后验与 STAGING 新增授权、持久跟踪页面尚未接线，不从这些测试推断已完成。

## 本地模型设置

`model-settings.spec.ts` 属于默认 Playwright 配置，覆盖常驻入口仅显示审查模型、保存审查配置不改动原有 PI 配置、保存并刷新恢复、密钥不回传／不写浏览器存储、地址变更要求新密钥、手机导航、服务不支持时禁用保存和失败不显示成功。模型调用仍使用隔离测试实例；保存设置自身不调用 LLM。
