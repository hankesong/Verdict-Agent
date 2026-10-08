# SSH 单实例用户部署

部署拓扑：Nginx 提供 HTTPS 与站点口令；静态页面走同源 `/backend/one`、`/backend/two` 代理；两个后端使用独立 SQLite 与证据目录，三个签名服务使用标注为冻结样本／故障注入的数据。钱包操作仍由用户手动发起并在钱包中签名。没有执行付款的 Agent，没有链上发布。

## 版本与目录

使用 Node 22.23.3 / npm 10.9.9。应用根目录 `/opt/verdict-agent`，每个 Git 提交放入 `releases/<commit>`；`current` 指向当前版本。配置、生成的演示签名密钥、用户填写的模型 Key 和运行记录放入 `shared`，不随 Git 发布。不要上传开发机的数据库、钱包私钥或历史证据。

```sh
npm ci --ignore-scripts
VITE_PRIMARY_API=/backend/one VITE_SECONDARY_API=/backend/two npm run build
node scripts/deploy/prepare.mjs /opt/verdict-agent <hostname> /opt/node-v22.23.3-linux-x64/bin/node
```

`prepare.mjs` 从当前 release 执行，由专用 `verdict` 用户运行。首次生成五个配置、三个演示签名密钥与 systemd / Nginx 文件；已有私有配置不覆盖。默认 BOT 测试网，原生币额度沿用已确认的本地上限；模型初始未配置。可以只在云端模型设置页填写审查 Key，或由操作者显式部署审查配置到 `shared/config/one.json` 和凭据环境到 `shared/one.env`。第二实例只需 RPC 观察，无须执行／审查模型密钥。

## 启用

1. 创建 `verdict` 系统用户；代码只读，`shared` 由该用户拥有且权限 0700。Nginx 只读取 `current/apps/web/dist`。
2. 为 hostname 配置 HTTP ACME challenge，使用现有 ACME 账户取得证书。
3. 在 `/opt/verdict-agent/access.htpasswd` 设置操作者站点口令（root:www-data、0640），不提交或打印口令。
4. 审阅后安装 `generated/verdict-*.service` 至 systemd，安装 `generated/verdict-nginx.conf` 为独立虚拟站点配置；先运行 `nginx -t` 再 reload。
5. 原子切换 `current` 后重启这五个服务。后端仅监听 127.0.0.1:3131/3132，签名服务监听 14401–14403，不公开端口。

网关在转发前拒绝其他 Origin，并统一后端 Host/Origin 为已配置的 loopback 值；站点口令保护页面、设置和所有业务接口。此模式为同一操作者的私有演示环境，不提供多租户隔离，也不移除 defense 模式自身的访问限制。模型 Key 保存成功不等于已实际调用验证；云端填写的 Key 位于云主机磁盘。

## 验收与回滚

验证匿名访问 401、错误 Origin 403、有效站点凭据能读取两个不同 instanceId、模型设置不返回 Key、首页没有 loopback API 地址，以及错区块／错值拒收、证据下载与第二实例独立复验。钱包上线冒烟只读取配置，不代替用户签名或发起真实付款。

记录 Git 提交和前一 `current` 目标。回滚时切回前一 release 并重启五个服务；在更改 schema 前先正常停止服务并备份 `shared`。服务与证据在 `shared` 中持久化，代码回滚不得清空数据。

## 扫码登录

`verdict-qr-auth` 在 loopback 3130 提供登录令牌兑换和会话校验，Nginx 保留账号密码登录，同时接受安全会话 Cookie。`/login` 为公开兑换页；二维码令牌放在 URL fragment，页面读取后立即清除，POST 兑换成功进入 `/#wallet`。正常 API 和文件仍需要有效会话或原账号密码。

由操作者通过 SSH 在私有目录签发，输出必须保存到私有文件，不能写入公开日志或 Git：

```sh
node scripts/deploy/qr-auth.mjs issue /opt/verdict-agent/shared/qr-access.json https://verdict.ksrnyx.top 24 > /private/path/issued.json
node scripts/deploy/qr-auth.mjs revoke /opt/verdict-agent/shared/qr-access.json GRANT_ID
```

令牌默认 24 小时有效，可在有效期内重复扫码；浏览器会话最长 8 小时且不超过令牌期限。服务端只保存登录令牌摘要，签发的会话使用 Secure / HttpOnly / SameSite=Strict Cookie；撤销 grant 会同时使关联会话失效。持码者具备同一站点账号的访问权限，二维码应作为私有登录凭据交付，不放进仓库或公共目录。令牌中没有站点密码、模型 Key 或钱包密钥。

验证命令：`node --test scripts/deploy/qr-auth.test.mjs`。升级时安装第六个 systemd 单元 `verdict-qr-auth.service`，先启动，再 `nginx -t` 和 reload；原 Basic 登录保持可用。签发／撤销只影响站点会话，不授予钱包签名权限。
