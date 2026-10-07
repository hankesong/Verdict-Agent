# material-triage-v2 保留样本

在 v2 提示词冻结后自编的 8 对合成文本，沿用仓库许可证。没有复制其他公开基准内容；不是独立盲测或生产分布。

包含混合中英文、否定后的例外、合法候选提醒、HTML、条件注入、伪角色和 JSON 里的历史命令。URL 为不可达示例，账户来自本地公开冻结夹具。样本结果不用于修改同版提示词。

`VERDICT_DATASET_DIR=fixtures/redteam/material-triage-v2 node --import tsx scripts/dev/redteam-material-triage.ts check` 可校验哈希。真实复测需显式加载本地模型环境后使用 live；查看 docs/26-Guard材料审查v2复验.md。
