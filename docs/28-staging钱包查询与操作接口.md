# staging 钱包历史与操作接口

2026-10-07。在 `staging` 上增加两个只读接口，供近期任务侧栏与交易操作流程使用。创建、确认、风险继续、一次性消费及证据接口沿用[钱包后端 v2](27-钱包后端v2.md)。本次不修改网页。

## 最近审查记录

```http
GET /api/wallet/reviews?account=0x1111111111111111111111111111111111111111&chainId=0x3c8&limit=25
```

所有查询参数可选：

| 参数 | 格式与含义 |
| --- | --- |
| `account` | 20 字节地址，按交易发送方筛选，自动转小写 |
| `chainId` | 规范十六进制 quantity，例如 `0x3c8`，不接受 `0x03c8` |
| `status` | 持久化状态：QUEUED / REVIEWING / ALLOWED / BLOCKED / UNCERTAIN / CONSUMED / CANCELLED / INTERRUPTED / EXPIRED |
| `operation` | native_transfer / erc20_transfer / erc20_approve |
| `limit` | 十进制整数 1–100，默认 25 |
| `cursor` | 上页返回的 `nextCursor`，原样传递并保留相同筛选条件 |

返回 `WalletReviewPage`（`schemaVersion: wallet-review-page-v1`）：`reviews`、`hasMore`、`nextCursor`。末页 `hasMore=false`、`nextCursor=null`，空库返回空数组。按 `createdAt DESC, reviewId DESC` 排序，使用键集分页；插入更新的任务不会导致旧页重复。分页不是数据库快照，筛选涉及的状态在翻页期间变化时，记录可能离开或进入结果；刷新第一页面向最新数据。

摘要包括 `reviewId`、毫秒时间 `createdAt`、发送账户／网络、operation、`target`、`token`、最小单位十进制字符串 `amount`、持久化 `status/reason`、`reviewVerdict`、`userDecision`、`receiptStatus`、`postStateStatus`、`tokenOutcome` 和可为空的 `evidenceRef`。大整数不得转换为 JavaScript Number。原生币 `target` 为交易接收方、`token=null`；代币的 `target` 为实际 recipient／spender，`token` 为代币合约。

`receiptStatus` 为 NOT_REPORTED / UNKNOWN / SUCCESS / FAIL / REJECTED；`postStateStatus` 为 NOT_CHECKED / UNKNOWN / POST_STATE_RECHECKED。`tokenOutcome` 为 null 或 `{receiptEvent,stateComparison,scope}`，枚举沿用 `WalletTokenPostState`。回执成功与代币事件／状态差异必须分别呈现，不能把 `receiptStatus=SUCCESS` 当作审查或资产核对通过。

摘要省略原始 calldata、完整交易、会话 ID、确认 challenge、检查详情与事件。地址和金额仍属于本地私人任务数据；此接口沿用当前本地单用户实例的 Host／Origin 限制，`account` 是筛选条件，不是身份认证或多租户隔离。旧 v1 记录可列出，不能因此重新获得消费许可。

重复／未知查询参数、非法值和无效游标返回 400。游标包含筛选摘要，变更筛选后须清空游标；否则返回 `WALLET_CURSOR_FILTER_MISMATCH`。游标用于分页，不是授权凭据。

## 当前可进行的操作

```http
GET /api/wallet/reviews/:id/actions
```

返回 `WalletReviewActions`（`schemaVersion: wallet-actions-v1`）。不存在的审查返回 404；存在但失效的审查返回 200，并解释不可用原因。

| 字段 | 含义 |
| --- | --- |
| `evaluatedAt` | 本次计算时的服务端毫秒时间 |
| `status` | 已保存的审查状态，GET 不修改它 |
| `executionState` | 下表中的当前流程状态 |
| `reviewVerdict` | 原模型 ALLOW / BLOCK / UNCERTAIN，未出结论为 null |
| `userDecision` | NOT_CONFIRMED / CONFIRMED / CONTINUE_WITH_RISK；是记录，不自行授予许可 |
| `decisionEffective` | 已记录确认此刻是否可用于发起消费；过期、失效、消费中或已消费为 false |
| `validUntil` | 原许可截止毫秒时间，尚未产生则 null；已消费后仍是历史值 |
| `actions` | 当前有实际意义的操作 ID 列表，不是 HTTP URL |
| `reasonCodes` | 本地不可用原因，例如会话变化、过期、配置变化或操作进行中 |

| `executionState` | 前端对应流程 |
| --- | --- |
| REVIEWING | 等待结果，可取消 |
| AWAITING_CONFIRMATION | 展示交易与审查结果，完成本次手写后 confirm |
| AWAITING_RISK_CONFIRMATION | 展示原风险与用户继续选择，完成手写后 override |
| READY_TO_CONSUME | 确认已绑定；先调用 consume，成功后才请求钱包签名 |
| PERMIT_CONSUMED | 一次性许可已领取；不表示已签名、已广播或已到账 |
| EXPIRED | 创建新审查并重新确认 |
| CANCELLED / INTERRUPTED | 已取消／服务重启导致中断；创建新审查 |
| STOPPED | 硬规则失败、缺少预执行依据等，不提供风险覆盖 |
| UNAVAILABLE | 当前会话、摘要、配置或并发状态不允许继续，查看 reasonCodes |

操作 ID 对应：

| ID | 请求 |
| --- | --- |
| confirm | `POST /api/wallet/reviews/:id/confirm`，沿用 v2 确认字段 |
| override | `POST /api/wallet/reviews/:id/override`，确认字段加 `acknowledgement: CONTINUE_WITH_RISK` |
| consume | `POST /api/wallet/reviews/:id/consume`，`{transaction: preparedTransaction}` |
| cancel | `POST /api/wallet/reviews/:id/cancel`，`{}` |
| report | `POST /api/wallet/reviews/:id/broadcast`，`{txHash}`；这是上报钱包交易哈希，后端不会广播 |
| recheck_receipt | `POST /api/wallet/reviews/:id/receipt/recheck`，`{}` |

两条 GET 均不调用 RPC／模型，不写数据库或事件。操作列表根据已保存事实、当前会话版本、TTL、确认摘要、当前本地策略及进行中的消费／回执工作计算；不探测链上状态或 RPC 连通性，不保证随后 POST 成功。实际消费仍重新校验并执行 RPC 复查。每次编辑条件、切换账户／网络／provider、恢复页面或提交失败后重新获取详情和 actions；任何旧页面状态都不能跳过逐次确认与 consume。

模型 BLOCK／UNCERTAIN 可以在有完整确定性依据时提供 override；原 verdict 始终保留。被取消／失效后仍保存的风险选择不等于可继续。许可已消费后，断开钱包和原 TTL 到期不妨碍补查已经发出的交易。只有 BOT 配置网络支持本轮 receipt 路径；已有永久 REJECTED 或已存证据的任务不会提示无效重查，回执未知或后状态缺失时才提供重查。相同 POST 的幂等语义保持不变，动作列表省略无实际新效果的重复操作。

## 本地验证与边界

新增集成测试覆盖同毫秒记录、分页途中插入、筛选／游标冲突、旧记录、摘要隐私、确认与覆盖生命周期、会话／过期／配置变化、并发消费和回执、读取无副作用，以及回执成功但代币事件／状态异常的摘要。

Node 22.23.3 / npm 10.9.9 下 `npm run typecheck` 通过；`npm run test:all` 中原内核／CLI **48/48**、后端集成 **167/167** 通过（包含本轮新增 8 个查询／操作测试，以及原代币测试新增断言）。`npm run verify:wallet:evm` 通过。现有网页只随共享协议参与构建；没有声称 v2 插件流程已通过浏览器测试。

`npm run verify:wallet:evm` 使用独立 loopback Anvil 和本仓库测试代币。安装方式见 [27](27-钱包后端v2.md)。脚本先验证预执行和许可消费不改链上状态，再由测试驱动通过本地账户 impersonation 发送 transfer 与 approve；后端观察真实 EVM 回执、日志和历史状态，并把证据交给第二个独立数据库／HTTP 实例重新查询同一节点复验。实例位于同一测试进程，不构成独立主体背书。

实测 transfer `1000,0 → 900,100`，approve `0 → 100`；两笔回执 SUCCESS，代币事件和状态 MATCH，独立实例复验 MATCH，复验不会生成许可。RPC 执行来源为 LOCAL_ANVIL_EVM，通过测试 HTTP relay 连接；模型与 harness 来源字段仍为 TEST_TRANSPORT。后端广播次数为 0，本地测试驱动发送 2 笔。没有公开网络交易、浏览器插件实签、真实付费模型调用或完整合约漏洞审计。
