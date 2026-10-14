# 最小证据摘要合约

状态：最小 Solidity 合约及 Foundry 测试源码已建立；本环境未安装 Forge/solc，尚未编译运行。

`src/EvidenceAnchor.sol` 按 `(publisher, evidenceHash, formatVersion)` 记录并发出 `EvidenceAnchored`。同发布者重复三元组 revert，不同发布者隔离；仅接收非零摘要与 1–40 字节格式版本。合约不检查证据内容、Verdict 核验结果或许可。

`test/EvidenceAnchor.t.sol` 覆盖事件、发布者隔离和重复拒绝。Foundry 配置固定 Solidity 0.8.28、optimizer 200 runs。anchor-client 中有最小 ABI；正式发布前须与经审查的本地构建产物比对。此次没有编译、部署或源码验证。详细操作与剩余限制见 [部署准备](../../docs/31-BOT主网存证部署准备.md)。
