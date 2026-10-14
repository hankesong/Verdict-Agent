# BOT Chain 主网钱包与摘要存证部署准备

本文件只提供部署前准备和验收步骤。本轮没有部署合约、发送公共网络交易或购买资产。

## 数据边界

- 钱包数据验收链、钱包交易链、摘要存证链是三个独立字段／角色。现有账户状态验收规则继续以 Ethereum mainnet (`dataChainId=1`) 为目标；不能因 BOT 钱包网络而改成 `677`。
- 首版只允许锚定现有 `EvidenceBundle` 对应 `EvidenceManifest`：`schemaVersion=1.0.0`、`hashAlgorithm=keccak256-jcs`、`evidenceHash`。合约格式版本为 `verdict-evidence-manifest-v1`。合约只表示某个发布者提交过这段摘要，不证明内容真实、签名有效、规则通过或 Verdict 许可链上执行。
- 不锚定钱包观察包、原始交易、账单、提示词、账户状态明细或完整证据。完整材料留在私有链下存储，第二实例仍独立复验。
- 合约按 `(publisher, evidenceHash, formatVersion)` 去重。同一发布者重复调用会 revert；另一发布者对同一摘要有独立记录，不会覆盖。

## BOT 网络配置

代码按用户给出的参数配置：Chain ID `677` / `0x2a5`、RPC `https://rpc.botchain.ai`、浏览器 `https://scan.botchain.ai`、原生币 `BOT`。尝试对 RPC 调用只读 `eth_chainId` 并访问网站时，当前执行环境 TLS 握手失败；因此未能独立核实官方参数，上线前由维护者通过独立可信渠道再次确认。

钱包测试网历史配置保留 `968` / `0x3c8` / `tBOT`。`wallet-observation-v1/v2` 仍只表示 BOT 测试网；主网用网络中立的 `wallet-observation-v3`，并把原生符号从本地可信网络配置核对。RPC 缺少 `eth_chainId`、`eth_maxPriorityFeePerGas`、交易／回执查询、账户 nonce／余额、区块查询、`eth_call` 或 `eth_estimateGas` 等硬检查所需能力时应拒绝或保持未知，不得绕过。实现不调用公共 RPC `eth_getLogs`；交易回执直接包含事件日志时仍须核对地址、发布者、摘要、格式版本和成功状态。

在隔离的 `.local` 配置上，可选择：

```powershell
npm run wallet:configure-network -- .local/<instance>.json bot-mainnet
# 或保留旧测试网：
npm run wallet:configure-network -- .local/<instance>.json bot-testnet
```

脚本只写公开网络参数和环境变量名称，不读取／创建密钥。主网 RPC 环境变量应由运维按其秘密管理策略注入（公共 RPC URL 可用上述官方 URL）；避免在 URL 放认证参数。钱包交易仍由浏览器钱包逐次签名，后端不持有钱包私钥。

## 本地合约构建与部署前流程

Foundry 配置固定 solc `0.8.28`、optimizer 200 runs。先在隔离环境安装并核实 Foundry/solc 版本，然后：

```powershell
cd contracts/evidence-anchor
forge test -vvv
forge build --build-info
```

部署前须固定并审查源文件、编译器版本、optimizer 设置、creation/runtime bytecode 和 ABI。由维护者在目标网络部署后，记录部署地址、chain ID、部署交易哈希及编译元数据；再使用官方浏览器做源码验证，并独立比对验证后的 runtime bytecode 与本地构建产物。部署／源码验证本身不在本轮执行。

应用配置片段（均为占位值，不含秘密）：

```json
{
  "publicationAdapter": "anchor_client",
  "publicationOperatorTokenEnv": "VERDICT_ANCHOR_OPERATOR_TOKEN",
  "anchor": {
    "enabled": false,
    "chainId": "677",
    "rpcUrlEnv": "VERDICT_ANCHOR_RPC_URL",
    "contractAddress": "0x0000000000000000000000000000000000000000",
    "privateKeyEnv": "VERDICT_ANCHOR_PUBLISHER_PRIVATE_KEY",
    "maxGasLimit": 150000,
    "maxFeePerGasWei": "1000000000",
    "maxTotalFeeWei": "150000000000000",
    "confirmations": 12
  }
}
```

写入默认关闭；必须由运维显式启用。唯一操作路由 `POST /api/evidence/{evidenceId}/publish` 要求独立的 bearer token（环境变量名在 `publicationOperatorTokenEnv` 配置），比较采用定长常数时间检查，token 不可通过前端配置读取。轮询 `GET /api/evidence/{evidenceId}` 查看状态；普通客户端不能触发维护者 Gas 消耗。发布账户需准备 BOT Gas；不得将签名密钥放进前端、仓库、日志或错误消息。生产启用前还需专门决策密钥保管、余额上限、token 发放／撤销、交易 nonce 并发策略、监控与轮换。本轮没有解决维护者密钥托管，不应直接开放主网发布。

## 发布状态与恢复

状态只表达锚定生命周期，和验收 `verdict`、业务 run 状态及复验报告分开。`pending` 会持久化；签名原始交易先写入私有 DB，再广播。进程恢复时先查询实际交易／回执；确认查询失败时，只允许重播同一份已签名字节（相同 nonce/hash），不会重新签发造成重复交易。交易已确认后必须再验证 receipt 成功、目标合约、发布者、事件中的摘要和格式版本及配置确认数，才置 `confirmed`。终态失败须用新的显式 retry token 重试；确认交易失败回执后清除该失败交易的签名缓存，其他不确定错误保留原交易供幂等恢复。

## 上线前验收清单

1. 用本地 EVM 部署同一字节码，跑 Foundry 正常事件、发布者隔离及同发布者重复拒绝用例。
2. 用真实本地 RPC 验证成功回执、失败回执、错链、错合约、缺事件、摘要／版本／发布者不匹配、广播超时后相同交易恢复和进程重启。
3. 验证 RPC 所需方法和 fee 字段；尤其真实 BOT RPC 是否返回一致的 `eth_chainId`、`eth_maxPriorityFeePerGas`、`eth_estimateGas` 与 `eth_getTransactionReceipt`。缺失时必须安全失败。
4. 对照主网与测试网钱包配置、v1/v2/v3 历史证据；复跑钱包收款人／金额／费用／账户／网络／nonce／有效期／许可一次性消费和第二实例复验。
5. 用真实 `EvidenceBundle` 核对本地 manifest 摘要和链上 event；模拟锚定失败时，原业务验收结论必须不变。
6. 仅在源码验证、RPC 核实、维护者密钥／Gas 策略和操作授权另行完成后，才讨论主网部署或写入。

## 当前未验证／未实现

本机当前 Node `22.13.0` 低于仓库要求 `22.19+`；未发现本地 Anvil/Forge/solc，Vite/esbuild 与 Node test runner 均遇到 Windows `spawn EPERM`。BOT 公共端点 TLS 请求在当前环境失败。故本轮不宣称合约已编译、EVM 用例已通过、主网参数已独立核实或公网 RPC 方法可用。链上摘要模块源码与服务接线已准备，但真实本地链部署、真实回执恢复/故障注入和双网络 RPC 兼容验证仍是上线阻塞项。
