# 存证发布适配器

状态：首版接口已实现，真实链路验证待完成。

只接受现有 `EvidenceManifest.evidenceHash`，格式版本固定为 `verdict-evidence-manifest-v1`。`signAnchorTransaction` 在服务器本地签名；调用方必须先持久化 `rawTransaction` 再广播。`verifyAnchorReceipt` 核对 RPC chain ID、成功 receipt、目标合约、发布者、摘要、格式版本事件和确认数；只检查 receipt 自带 logs，不调用 `eth_getLogs`。

网络写入须由调用方显式启用；本模块不向前端提供签名秘密。RPC 只允许无认证参数的 HTTPS 或 loopback HTTP。错误／未知不能解释为成功。

当前 Node test runner 在本 Windows 环境遇到 `spawn EPERM`，本地 EVM 工具也未安装；类型检查可以独立运行，但没有真实链成功声明。部署和剩余限制见 [BOT 主网存证准备](../../docs/31-BOT主网存证部署准备.md)。
