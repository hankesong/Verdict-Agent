# Agent 防御层 API

本轮把 Verdict 放在私人助理 Agent 与钱包／交易所执行适配器之间。Agent 可以读取材料并提出交易草稿，不能创建授权、改变授权条件、直接消费许可或用新 request ID 绕过额度。用户入口负责确认付款范围，执行入口负责签名／广播，链上回执继续由 Verdict 观察。

## 身份与部署

配置 `defense.principals`，每个主体有 `id`、`tenantId`、`role`、允许账户、环境变量中的 bearer token 和 `disabled` 状态。当前角色为：

| 角色 | 能力 |
| --- | --- |
| OWNER | 创建／改版／撤销自己的授权，创建钱包会话与付款任务，确认或取消自己任务的提议 |
| AGENT | 创建付款提议，读取自己任务的结果；材料和说明都是不可信声明 |
| EXECUTOR | 消费用户确认的提议，取得一次性执行凭证，提交交易哈希，跟踪回执 |

所有防御接口要求 `Authorization: Bearer <token>`。token 只从服务端环境读取，比较使用常量时间摘要；缺失、重复、格式不合或已禁用主体均拒绝。服务没有匿名回退。启用 `defense` 配置后，只开放 `/api/defense`，其它旧 API 整体拒绝，防止 Agent 绕过授权层或跨租户读取历史。防御服务内部仍复用 WalletReviews 的确定性检查。

示例配置：

```json
{
  "defense": {
    "maxProposalsPerTask": 100,
    "principals": [
      {"id":"owner","tenantId":"studio","role":"OWNER","accounts":["0x1111111111111111111111111111111111111111"],"tokenEnv":"VERDICT_OWNER_TOKEN"},
      {"id":"assistant","tenantId":"studio","role":"AGENT","accounts":[],"tokenEnv":"VERDICT_AGENT_TOKEN"},
      {"id":"wallet-adapter","tenantId":"studio","role":"EXECUTOR","accounts":[],"tokenEnv":"VERDICT_EXECUTOR_TOKEN"}
    ]
  }
}
```

真实 token 不进入配置文件、日志或版本库。每个启用主体的 token 必须为互不相同的 32–256 字符随机值（字母、数字、`.`、`_`、`~`、`-`）。配置主体及角色需要由管理员更新并重启，token 从环境按请求读取，不保存在数据库。账户归属采用管理员配置，不宣称已做钱包所有权验签。当前服务仍绑定 loopback，并保留 Host／Origin 检查；生产开放网络还需外部身份入口、TLS 终止、密钥管理和请求限流。OWNER token 不得提供给私人 Agent 或打包进网页。

## 用户授权和任务

```http
POST /api/defense/authorizations
Authorization: Bearer <owner-token>
```

请求包括 `clientRequestId`、`label`、`confirmed:true` 和 `policy`：账户、链、native／ERC-20 操作、token、recipient／spender、单笔／总金额上限、单笔／总费用上限、最大笔数、`validFrom` 和 `expiresAt`。所有金额为最小单位十进制字符串，时间为毫秒。服务端检查网络配置、已配置代币／额度和 spender 白名单，创建 `payment-authorization-v1`，版本 1 与摘要固定；真实代码及代理槽在 review 预执行阶段查询检查。

```http
POST /api/defense/authorizations/:id/revise
POST /api/defense/authorizations/:id/revoke
GET  /api/defense/authorizations/:id?version=1
GET  /api/defense/authorizations?limit=25&before=<id>
```

改版需要 `expectedVersion`，不可改变账户、网络、资产或操作类型；这些变化要创建新的授权。旧版本变为 SUPERSEDED，撤销变为 REVOKED。改版或撤销会取消尚未消费的提议并释放未使用预留；已经消费的许可保留交易回执查询权，预算记为 SPENT。

用户先建立钱包会话，再建立任务：

```http
POST /api/defense/sessions
POST /api/defense/tasks
```

任务绑定 `authorizationId`、版本和摘要、`agentId`、`executorId`、钱包会话版本、总额／费用／笔数预算、截止时间以及付款行。每个付款行有唯一 `paymentRef`、用户登记的 `invoiceDigest`、材料摘要数组和单笔额度。任务创建时检查会话、主体、授权有效期和所有上限。任务可由 OWNER 取消；取消会取消未消费提议。一个任务固定一份授权、一种资产和网络，多供应商／多网络以多个任务关联上层业务；各笔仍独立确认、消费和观察。

授权、任务、提议列表按 UUID 倒序做键集分页（`limit` 1–99，`before=nextCursor`），不表示时间顺序。任务详情返回其付款提议和未释放／已消费预算；旧钱包历史查询仍在未开启 defense 的兼容模式提供。

## Agent 提议

```http
POST /api/defense/proposals
Authorization: Bearer <agent-token>
```

Agent 只能提交 `taskId`、`paymentRef`、`invoiceDigest`、材料摘要、交易草稿和说明。说明标记为 `UNTRUSTED_AGENT_DECLARATION`，没有授权作用。服务端比较：

- 发送账户、网络、token、收款人／spender、native value、ERC-20 selector 和精确 ABI calldata。
- 单笔和任务总额、费用、笔数、授权生命周期。
- 付款行和材料摘要绑定、重复 invoice、重复 paymentRef、nonce 重放。
- 授权版本是否仍为 ACTIVE，钱包会话是否仍匹配。

有差异的提议保存为 `BLOCKED`，包含字段级 `differences`，不会调用模型、RPC、钱包或执行适配器。没有差异的提议才创建现有 `WalletReview`，状态为 `REVIEW_CREATED`。用户随后通过：

```http
POST /api/defense/proposals/:id/confirm
POST /api/defense/proposals/:id/override
```

每次仍需原有交易摘要、会话版本、challenge 和 `handwritingAcknowledged:true`；风险覆盖不会改写原 verdict。提议详情：

```http
GET /api/defense/proposals/:id
GET /api/defense/proposals/:id/audit
GET /api/defense/proposals?limit=25&before=<id>
```

历史中保留阻断、取消、授权改版、材料摘要和确认事件，异常草稿不会被正常付款覆盖。

## 一次性执行凭证

```http
POST /api/defense/proposals/:id/consume
Authorization: Bearer <executor-token>
```

请求只带现有 `preparedTransaction`。服务端重新检查任务、授权版本、钱包会话、链上 nonce／余额／合约状态和预执行结果。成功后返回 `execution-grant-v1`：提议、review、任务、执行主体、授权摘要、交易摘要、交易内容、有效期和一次性 grant ID。授权摘要变化、任务过期、会话变化、重复 nonce、额度用尽或 review 失败均不产生 grant。

执行适配器必须先把 `grantId` 写入自己的幂等存储，再在本地确认账户／网络后签名／广播，并在实际调用钱包前检查传入的 `expiresAt`。参考实现位于 `examples/consumer/src/defense.ts`：执行错误记录 UNKNOWN，不重复执行；交易哈希回报可安全重试。它是可测试的接入示例，持久化 claim/result 及真实钱包／交易所执行由集成方实现。

grant 是在线服务的消费记录，不是已部署到链上的智能合约许可，也不是可以脱离服务独立验签的凭证。必须把 Verdict 放在实际签名／执行入口；如果私人 Agent 本身持有私钥或能绕过执行适配器，服务无法阻止它直接交易。已消费额度、账单和 nonce 按保守原则保持占用，即使钱包拒绝签名、交易失败或结果未知也不自动退还；避免迟到交易与新付款一起发生。

```http
POST /api/defense/proposals/:id/broadcast
POST /api/defense/proposals/:id/receipt/watch
GET  /api/defense/proposals/:id/receipt/watch
POST /api/defense/proposals/:id/receipt/watch/stop
POST /api/defense/proposals/:id/receipt/watch/resume
POST /api/defense/proposals/:id/receipt/recheck
POST /api/defense/proposals/:id/receipt/finality
GET  /api/defense/proposals/:id/evidence
POST /api/defense/evidence/replay
```

回执检查逐项核对交易、回执、状态、代币事件和历史余额／allowance。配置 `receiptEnabled:true` 的非 BOT 网络使用 `wallet-observation-v3`；BOT 的既有 v1/v2 记录保持兼容。finality 是独立观察，不改变 review verdict、许可或已有证据；状态为 PENDING、CONFIRMATIONS_MET、REORG_DETECTED 或 UNKNOWN。

## 当前明确边界

本轮完成防御层的授权、任务、提议、差异、额度、身份、执行凭证、幂等、回执和多链观察基础。附件原文、OCR、PDF 恶意解析、邮箱／交易所正式 connector、浏览器插件 UI 和完整合约漏洞审计仍由上游材料系统、前端或后续适配工作负责。上游应先把材料登记成摘要，再由 OWNER 把摘要放入任务；Agent 提交的摘要不能替换任务中的摘要。

服务不持有私钥、不广播、不把模型输出当作授权、不把回执成功当作合约安全。当前合约防御仍是配置范围内的非代理 ERC-20 transfer／approve；Swap、permit、批量调用、税币／重基、复杂内部调用和通用静态漏洞审计保持 UNKNOWN 或未支持。

验证覆盖授权角色、跨租户访问、旧接口绕行、地址／金额／token calldata 替换、材料／invoice／requestId 替换、拆单和总预算、撤销竞态、任务过期、会话切换、disabled executor、nonce 重放、执行 adapter 幂等、旧钱包回归、非 BOT EVM v3 证据、finality 和 reorg。没有公开网络交易或真实交易所／插件接入。

本轮实测：Node 22.23.3 / npm 10.9.9 下类型检查通过，原内核／CLI 48/48、后端集成 197/197 通过，其中新增防御／多链用例 14 项。`verify-wallet-evm.ts` 经 OWNER 授权与确认、AGENT 提议、EXECUTOR 消费后，在本地 Anvil 完成 transfer 与 approve，分别从待出块跟踪到观察完成，第二实例复验均 MATCH。模型为 TEST_TRANSPORT；除本地 EVM 验证外，新增多链／重组故障用例使用显式 RPC 替身。
