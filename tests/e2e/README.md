# 浏览器端到端测试

`npm run test:e2e` 构建后运行 Playwright Chromium。首次使用先执行 `npx playwright install chromium`（Linux 缺系统库时按 Playwright 提示安装）；CI 使用 `--with-deps`。

测试在系统临时目录生成测试密钥和独立数据库，通过真实 HTTP 调用 A 内核：前端 5174、后端 3101/3102、签名服务使用临时端口。不读写 `.local/instances`，也不复用用户已启动的服务。动画测试开启 reduced motion，只去掉节奏，状态转移仍来自真实快照。

共 14 条，针对 2026-10-08 重做后的验收控制台（[018](../../docs/decisions/018-frontend-redo.md)）：

`web.spec.ts`

1. 交付追踪：签名错块和错值被拒收，替换到 PASS；证据封存、第二实例复验 `reportConsistent true`、发布状态 `not_requested`；条码按 64 位摘要绘制。
2. 全部失败（`NO_ACCEPTABLE_DELIVERY`）与预算耗尽（`BUDGET_EXHAUSTED`）分别停止；刷新后恢复同一运行。
3. 任务登记：提交后跳转追踪；同一 requestId 原样重放复用 runId（`duplicate:true`），改参重放返回 409。
4. 提交响应丢失：重试使用相同 requestId，得到同一 runId，后端仍实际执行。
5. 证据标签：下载的原始字节与服务端一致、摘要等于 evidenceId；证据码只含 manifest 字段；点击 JSON Pointer 后，工程抽屉在原始证据中高亮对应字段。
6. 独立复验：第二实例重算被拒交付，排序随适用反证变化；修改余额的副本导入时被拒（`HTTP 422 · ARTIFACT_MISMATCH`）。
7. 手机布局无横向滚动；后端不可用时提示并禁止提交；Vite 拒绝读取工作区私有文件。
8. 轮询中断后恢复同一运行，不新建任务。
9. PI 直接执行：自然语言任务调用真实工具、采用通过的交付，刷新后恢复（模型为 TEST_TRANSPORT）。
10. PI 缺少条件时停止且无数据；补充条件后直接执行。

`graph.spec.ts`

11. 录制回放：单步、播放与暂停、详情面板、切换场景，全程没有 POST 请求。
12. 实时图：按游标增量读取，断线后重试，刷新后节点不重复。
13. 手机与 reduced motion：恶意标签保持惰性，不绘制粒子。

`guard.spec.ts`

14. Guard 真实硬规则拦截；导出的签名报告下载后内容一致，导入后复验为 REPRODUCED，并生成规则候选。

只验证已实现的前端。真实链上适配、合约以及真实钱包签名路径未实现或不在测试范围内，不能从这些测试推断已完成。PI 模型响应是 TEST_TRANSPORT，不能据此宣称真实模型联调通过。
