# 024：把 Verdict 定位为 Agent 执行防御层

2026-10-07。用户明确产品方向：私人助理 Agent 负责理解任务和提出操作；Verdict 位于钱包、交易所或其他链上执行服务之前，负责授权边界、确定性核对、签名前防误付和链上回执复验。

本轮在 `backend-staging-next` 上实现当前后端可完成的防御范围：

- `payment-authorization-v1`：OWNER 创建、改版、撤销；账户、链、资产、收款人／spender、金额／费用／笔数、有效期固定为摘要绑定的版本。
- `payment-task-v1`：绑定授权、Agent、EXECUTOR、钱包会话和付款行；任务总预算、材料／invoice 摘要、有效期和取消状态持久化。
- `payment-proposal-v1`：AGENT 提交不可信提议；服务端逐字段比较，阻断地址、金额、网络、资产、selector、材料、重复付款和总预算变化。通过后才创建已有 WalletReview。
- 防御身份与旧接口边界：OWNER／AGENT／EXECUTOR 分离，Bearer token 来源于环境；启用 defense 配置后 `/api/wallet` 旧写入口关闭。
- `execution-grant-v1` 与适配器示例：一次性消费、授权摘要、任务和交易绑定；nonce／预算预留防拆单与重放，适配器先 claim 再执行。
- 非 BOT 配置网络的 v3 证据和 finality/reorg 观察，保留 BOT v1/v2 兼容。

不把材料解释、钱包签名、交易所托管、任意合约漏洞审计伪装成后端完成；上游材料系统仍须把用户确认的材料摘要绑定进任务。详见 [30](../30-Agent防御层API.md)。

验证：类型检查通过；后端集成 197/197、原内核／CLI 48/48 通过。真实本地 Anvil 的 transfer／approve 均经过新的授权／提议／确认／消费链路，并完成回执跟踪及第二实例复验 MATCH。无公开链交易、真实付费模型调用、前端改动或 main 合并。
