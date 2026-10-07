# 020：staging 推进风险覆盖与代币回执复验

2026-10-07。用户要求保留 `feat/wallet-review-v2` 不再修改，另建 `staging` 推进后端。staging 从 `origin/main@e70531e` 建立，并复制 v2 当前未提交内容作为基础；本轮不修改或提交原 v2 工作树，后续并行工作也不自动复制到 staging。

## 本次新增

- 模型在确定性 `policy` 与 `preflight` 均完成后给出 `PI_BLOCK`／`PI_UNCERTAIN`，用户可通过独立 `/override` 明确选择 `CONTINUE_WITH_RISK`。硬规则失败、预执行未知或没有完整依据的任务不能覆盖。
- 风险覆盖会绑定交易摘要、会话版本、确认 nonce 和原审查原因；用户手写确认声明、覆盖记录与原模型 verdict 分开保存。消费和回执阶段继续复查，状态／会话变化会使覆盖授权失效，已记录的用户选择保留供审计。
- Agent Graph 新增 `wallet.user.overridden`／`USER_CONFIRMATION` 阶段；原 `BLOCK`／`UNCERTAIN` 不改写为 `ALLOW`。
- 合约交易回执支持固定配置的 ERC-20 transfer／approve：检查实际 calldata、交易、receipt status／日志、代码和实际历史区块的 allowance／余额；生成 `wallet-observation-v2`，独立复验重新调用 RPC。范围差异标为 `receiptEvent`／`stateComparison`，不把区块前后差额宣称为单笔因果证明。
- 代币观察不复用原生币 `wallet-observation-v1` 证据。代币交易的 receipt 与复验不修改 A 包 verdict，也不提供完整合约漏洞审计。

## 边界

服务端不签名、不广播。硬规则、未知数据、代码／代理变化、额外事件、内部调用和 RPC 不可用继续停止或返回未知。允许用户继续只代表用户明确承担当前提示风险，不代表服务端将该交易标成安全或审查通过。
