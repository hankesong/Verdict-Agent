# Verdict 前端设计说明（交接用）

2026-10-08。本文是前端最终版的设计依据，接手者按此实现；与 [018 决定](../../docs/decisions/018-frontend-redo.md)（九站点版本）冲突时，以本文为准，完成后补一条新的决定记录取代 018 的站点结构。修改前仍须遵守 [AGENTS.md](AGENTS.md) 与根目录 [AGENTS.md](../../AGENTS.md)。

## 1. 一句话

**先验收，再采用；证据交给别人自己重算。**界面只为这句话服务，其余能力留在后端 API，不上界面。

## 2. 设计思路

### 2.1 产品形态：一个主屏，两个方向

- **收件**：别人交付数据给你，你核验后决定是否采用（账户状态验收）。
- **寄件**：你要发出一笔交易，签名前先审查（钱包签名前审查，首版只支持 `native_transfer`）。
- 快递只是趣味性的外壳（流程的节奏、包裹、面单、盖章、条码），和真实物流无关。**所有标签、字段、状态一律用区块链与后端的专业术语**，不要发明"开箱验货"之类的拟物说法。

### 2.2 小而美的原则

1. 一屏一件事，一屏一个主按钮（黑底主按钮），其余全部是文字链接。
2. 默认值填好，打开即可提交；高级参数默认折叠；专业细节放进可展开项和工程视图。
3. 动效只有三种，每种都表达真实状态：**包裹前进**（状态推进）、**盖章**（给出结论）、**条码打印**（证据封存）。没有装饰性动画。开启 `prefers-reduced-motion` 时直接呈现终态。
4. 颜色只表达结论：绿 = PASS / 采用 / ALLOW，红 = FAIL / 拒收 / BLOCK，黄 = 无法判定 / 中断 / 未完成；其余一律中性色。陶土色只用于当前站点、焦点和品牌。
5. 文案节食：每个状态最多一句说明；不写营销话术。
6. 失败与停止和成功同等完整：结果卡写清原因码，以及调用方下一步该做什么。

### 2.3 不可违反的底线

- 页面只展示后端返回的结论，**浏览器里不验签、不重算摘要、不判定证明**。条码只是把 `evidenceHash` 的字节画出来。
- `verdict`、归属 `attributionStatus`、文件完整性 `artifactIntegrity`、运行状态、发布状态 `publication.status` 分开显示，互不合并；复验 COMPLETED 不等于数据 PASS。
- 来源标签（LIVE / FROZEN / FAULT_INJECTION / TEST_TRANSPORT）出现在相关条目上，不能省略。
- 没配置的能力显示"未配置"及原因，不做假数据、不做演示开关。演示程序由用户另行制作，前端不管。
- 所有动态文本先转义（`view.ts` 的 `escape`）。

## 3. 视觉语言

参考 Claude 官网的气质，只借风格，不用其标志、字体文件或素材。

| 项 | 规定 |
| --- | --- |
| 底色 | 象牙白 `#FAF9F5`；卡片纯白 `#FFFFFF`；次级底 `#F0EEE6` |
| 线 | 细线 `#E8E6DC`，强调线 `#D6D3C7`；不用投影（弹层除外） |
| 文字 | 主 `#141413`，次 `#3D3D3A`，弱 `#6B6A65`，提示 `#9C9A92` |
| 强调 | 陶土 `#D97757`（深 `#B85C3C`，浅 `#F6E4DC`）；牛皮纸 `#EAD6BD` / 描边 `#B98A5E` 只用于包裹 |
| 状态色 | ok `#4D7C5A` / `#E5EEE3`；bad `#B4493B` / `#F5E1DC`；warn `#9C6A1C` / `#F4E9D4` |
| 字体 | 标题衬线（`"Iowan Old Style","Sitka Text",Charter,Cambria,Georgia,"Noto Serif SC","Songti SC",serif`）；正文系统无衬线；技术字段等宽 |
| 圆角 | 卡片 14px，控件 8px，标签与状态胶囊 999px |
| 宽度 | 主内容单栏，最大约 760px 居中；工程视图打开时在宽屏占右侧 430px，窄屏改为浮层 |

已有令牌在 `src/style.css` 的 `:root`，可沿用；其余与九站点有关的样式应删除。

## 4. 页面结构

```
顶栏：  [标识] Verdict    ( 收件 | 寄件 )            ● 主实例 ● 复验实例   [工程视图]
主区：  单栏流程（快递单 → 在途 → 结果卡）
浮层：  证据面单（从右侧滑出）      侧栏：工程视图（可开关）
```

- 路由：`#receive`（默认）、`#receive?run=<runId>`、`#send`。证据面单不占路由，可选支持 `&evidence=<id>`。
- 切换"收件 / 寄件"不丢失各自当前进度；只有点「重新填单」才回到空白快递单。
- 不再有：九站路线条、来源图例条、动作轨迹图、外审与报告页、候选与观测页。

## 5. 各页面文字描述

### 5.1 顶栏

- 左：原创标识（`public/verdict.svg`，陶土底、虚线印章加对勾）与衬线字 "Verdict"。
- 中：分段切换「收件 | 寄件」，当前项白底。
- 右：两个实例状态点。已连接为绿点，文字 `browser-one 已连接 :3001`；断开为红点并显示「重新连接」（`aria-label="重新连接后端"`）。最右是「工程视图」按钮，带快捷键提示 `` ` ``。
- 后端不可用时，主区顶部出现一条提示：`无法连接 <地址>。请先运行 npm run dev:init 和 npm run dev:start，再点击重新连接。` 此时提交按钮全部禁用。

### 5.2 收件 · 状态一：填快递单（已有实现：`src/receive.ts`）

- 眉标 `WAYBILL · 收件`；标题（衬线）「账户状态验收」；一句说明：「声明要核验的账户、区块与字段。交付不合格就换下一家，全部不合格就停止，不采用任何数据。」
- **一句话填单**：单行输入框加「填单」按钮。调用 `POST /api/agent/drafts`，轮询 `GET /api/agent/drafts/:id`，直到状态不再是 `GENERATING`，然后把 `proposal` 填进下方字段。被填的字段短暂高亮。填完后在输入框下方显示：「由 `<modelId>`（`<modelSource>`）填写，提交前请核对。」以及 `missing`（仍缺什么）和 `explanation`。**模型只填单，不发出任何请求。**`/api/agent/meta` 显示未配置时，输入框禁用，占位文字为「一句话填单未配置：需要服务端模型」。
- **面单字段**（左侧等宽字段名，右侧控件，行间用虚线分隔）：
  - `account`：输入框，默认填后端能力中的第一个账户。
  - `blockHash`：输入框，默认填可信检查点。
  - `fields`：胶囊多选 `balance` `nonce` `codeHash` `storageRoot`，默认前三项。
  - 折叠区「contextId、candidateIds 与 budget」：`contextId` 下拉；`policy` 只读（`<id> · requireSignature <bool> · <ruleVersion>`）；`candidateIds` 胶囊多选（附来源标签，默认全选）；`useHistoricalEvidence` 开关，默认开，说明「适用的已复验反证只影响顺序，每份新交付仍须核验」；`budget` 三个输入 `maxAttempts` `timeoutMs` `maxCostWei`。
- 主按钮「发起验收 →」，调用 `POST /api/runs`。
- **提交响应丢失时**：保留原请求，表单锁定，显示「重试同一请求」（在 fieldset 之外，否则会被一起禁用），并提示「上次提交未收到响应；重试使用相同 requestId，不会重复登记。」

### 5.3 收件 · 状态二：在途

- 快递单收起成一条**面单条**：`WAYBILL`、`runId`（缩写，悬停显示全文）、`account @ blockHash · fields`、运行状态徽章、文字链「重新填单」。
- **路线卡**（`src/track.ts`）：横向七个站点，每站上方中文名、下方等宽代码：
  `登记 POST /api/runs` → `排序 candidates` → `交付 signed-http` → `核验 verify_delivery` → `采用 accepted` → `封存 keccak256-jcs` → `复验 :3002`。
  - 一个牛皮纸包裹沿虚线移动到当前站点。
  - 每次交付时，包裹先到「交付」再到「核验」，并盖章 `FAIL · BLOCK_MISMATCH` 或 `PASS · VERIFIED`。「交付」站下方累计尝试胶囊：`#1 demo-wrong-block`（红）、`#2 …`。拒收后包裹退回「交付」，换下一家。
  - 停止时，「采用」站改名「停止」变红，盖章 `STOPPED · NO_ACCEPTABLE_DELIVERY` 或 `BUDGET_EXHAUSTED`，后续站点显示 `—`。
  - 卡片下方一行说明当前发生了什么，例如：`attempt 2 · demo-wrong-value · FAIL · FIELD_MISMATCH · 拒收`。
- 折叠区「全部事件」：最新在上的时间线。每条有时间（相对运行创建的 `T+x.xxs`，来自后端时间戳）、标题、徽章、等宽接口与模块、关键字段；交付条目下可展开逐项检查，每个检查的证据位置是可点击的 JSON Pointer。
- 动画只按快照中的真实状态转移顺序回放：节奏可以压缩，但不补造事件或耗时。
- **轮询中断时**：提示「查询中断，运行可能仍在后端执行。点击「继续查询同一运行」恢复，不会新建任务。」并显示该按钮；顶栏的重新连接也会恢复。

### 5.4 收件 · 状态三：结果卡

- **已采用**：眉标 `ACCEPTED`；衬线标题「已采用」；`SUCCEEDED` 徽章。键值表列出 `serviceId`、各字段值（`balance` 以 wei 表示）、`blockHash`；`evidenceHash` 条码逐条打印，旁边是完整哈希。最后一行写复验情况：「第二实例 `browser-two` 重算：reportConsistent true · CONTEXT_DIFFERENT · 发布 not_requested」。主按钮「查看证据」，文字链「重新填单」。
- **已停止**：眉标 `STOPPED`；标题「已停止，不采用任何数据」；徽章；等宽 `stopReason`；一句话「accepted = null。调用方应停止依赖本次查询；每份已核验交付的证据仍可复验。」列出每次尝试：`#i serviceId`、结论徽章、首个原因码、「证据」链接。主按钮「重新填单」。
- **复验规则**：本页面发起的运行，在采用后自动把证据导入第二实例并复验，「复验」站盖章 `REPORT CONSISTENT` 或 `REPORT MISMATCH`（以 `reportConsistent` 为准，`comparison` 只说明上下文是否相同）。通过链接或刷新打开的运行**不自动写入第二实例**，改为显示按钮「在第二实例复验」。

### 5.5 寄件 · 状态一：填快递单（未实现，参考 `src/wallet/provider.ts`）

- 眉标 `WAYBILL · 寄件`；标题「签名前审查」；说明：「先检查交易的实际参数并预执行；审查通过后才交给钱包签名。服务器不持私钥、不广播。」
- **配置状态条**（来自 `GET /api/wallet/meta`）：
  - `configured=false`：显示「未配置」以及 `meta.reason`，并说明需要服务端 RPC 与独立审查模型。字段与按钮全部禁用。
  - 已配置但未发现钱包：显示「未发现浏览器钱包（EIP-6963）」。
  - 已连接但网络未配置：显示「当前钱包网络未配置审查，已停止发送」。
- 字段：
  - `wallet`：下拉加「连接」「断开」；钱包名称当作不可信文本处理，不渲染钱包提供的图标或 HTML。
  - `from`、`chainId`：只读，来自已连接的钱包。
  - `to`：地址输入。
  - `value`：金额，带原生币符号。
  - `maxTotalFee`：最高总网络费。
  - `operation`：只读 `native_transfer`；首版不放行代币授权、合约调用与消息签名。
- 主按钮「提交审查 →」。不提供"一句话填单"，后端没有对应能力。

### 5.6 寄件 · 状态二：在途

- 面单条：`WAYBILL`、`reviewId`、`to · value`、状态徽章；审查进行中时显示「取消审查」。
- 路线七站：`意图锁定 inputDigest` → `规则 policy` → `预执行 eth_call` → `审查 reviewer` → `许可 permit` → `签名 eth_sendTransaction` → `回执 receipt`。
  - 数据来源：`WalletReview.checks` 中 id 为 `policy`（`HARD_RULE`）与 `preflight`（`RPC_OBSERVATION`）的条目；`reviewer.verdict`（ALLOW / BLOCK / UNCERTAIN）；`status`。
  - 审查站盖章 `ALLOW` 或 `BLOCK · <reason>`。
  - `ALLOWED` 之后，「许可」站显示「正在消费一次性许可并请求钱包签名」。拿到 `txHash` 后，签名站转绿；接着调用 `POST /api/wallet/reviews/:id/broadcast {txHash}`，回执站按 `receiptReport.receiptStatus` 着色。
  - 用户在钱包中拒绝或钱包报错时，签名站转红，并说明许可已被消费，需要重新审查。
  - `BLOCKED`、`UNCERTAIN`、`EXPIRED`、`CANCELLED`、`INTERRUPTED`：在审查站停住，后续站点显示 `—`。
- 「全部事件」折叠区：列出 `checks`（原因与 `facts`）、`events`、审查模型 `modelId · source`、请求次数。

### 5.7 寄件 · 状态三：结果卡

- **已签名**：标题「已交给钱包签名」。列出 `txHash`、`receiptStatus`；有 `postState` 时列出发送方与接收方余额变化以及 nonce 变化。说明：「服务端未广播；回执来自 RPC 观察，不是最终性保证。」
- **审查未通过**：标题「审查未通过」，写出 `reason` 与未通过的检查。
- **无法判断**：标题「无法判断，未放行」。

### 5.8 证据面单（浮层，从右侧滑出；未实现）

- 打开方式：任何带 `data-sheet="<evidenceId>"` 的按钮。关闭方式：右上角 ×、Esc、点击遮罩。窄屏下全宽。
- 内容从上到下：
  1. 眉标 `EVIDENCE · keccak256-jcs`；完整 `evidenceHash`（等宽）；条码；徽章 `artifactIntegrity`、`publication.status`。
  2. 键值：`schemaVersion` `hashAlgorithm` `contextId` `serviceId` `provenance`。
  3. 证据码：`verdict:ev?v=<schemaVersion>&alg=<hashAlgorithm>&h=<evidenceHash>`，带「复制」。说明：「证据码只说明这是哪份材料、怎么核对，不携带 verdict、可信上下文或查询账户。」
  4. 结论三格：verdict / dataVerdict / attribution，以及 `reasonCodes`。
  5. 逐项检查：按 admission / attribution / data 分组，可展开查看要求、实际、原因码，以及证据位置（JSON Pointer 按钮，点击后在工程视图中高亮原文）。
  6. 动作：
     - 「在第二实例重算」：先导入再复验。结果显示一枚章（`REPORT CONSISTENT` 等）、原报告与重算结果对照、`artifactIntegrity`、`comparison`。另起一行显示开关历史证据前后的排序是否变化（用第二实例的 `POST /api/selection` 分别查一次）。
     - 「改一个字节试试」：胶囊单选要改的字段（余额 / nonce / 交付区块 / 签名 / 原报告结论），把改过的**浏览器内副本**连同原 manifest 导入第二实例。显示服务端的真实结果，例如章 `HTTP 422 · ARTIFACT_MISMATCH` 和一句解释。改完再重新封签的进阶关卡没有后端接口，不要在页面里模拟。
     - 文字链「下载原始证据」「下载 manifest」（使用原始字节，不由页面重组）；折叠区「命令行复验」给出 `npm run verify -- <id>.bundle.json --manifest <id>.manifest.json --context trusted-context.json --json` 以及退出码含义（0 一致且 PASS、2 一致且 FAIL、3 未知或上下文不同、4 完整性或报告不符、1 用法错误）。

### 5.9 工程视图（侧栏或浮层，已有实现：`src/drawer.ts`）

- 默认关闭；宽屏（≥1360px）按用户上次的选择恢复，窄屏总是关闭。
- 「接口流水」：页面发出的每个请求，显示状态码、方法、端口加路径、耗时，可展开看请求体和响应（截断到 4000 字符）。
- 「证据原文」：原始 bundle 的 JSON。点击 JSON Pointer 后高亮对应字段并滚动到位；找不到时如实提示，不补造位置。

## 6. 组件清单

`Topbar`、`ModeSwitch`、`Waybill`（快递单与字段行）、`LabelStrip`（面单条）、`Track`（站点、包裹、印章，已有 `src/track.ts`）、`ResultCard`、`EventLog`（最新在上的时间线）、`Checks`（带 JSON Pointer，已有 `view.ts`）、`Barcode`（已有 `view.ts`）、`EvidenceSheet`、`Drawer`（已有）。所有状态都由这些组件组合出来，不为单个页面单独写样式。

## 7. 代码现状（2026-10-08）

- 可复用：`src/api.ts`（请求、请求日志钩子、schema）、`src/state.ts`（连接状态、sleep、reduced motion）、`src/view.ts`（转义、徽章、检查项、条码）、`src/drawer.ts`、`src/track.ts`、`src/receive.ts`（收件三态已写好，未联调）。
- 业务逻辑，**不要删**：`src/graph/model.ts`（界面不再使用，但 `tests/integration/graph-projection.test.ts` 依赖它）、`src/wallet/provider.ts`（寄件要用，`tests/integration/wallet.test.ts` 也依赖它）。
- 需要重写：`src/main.ts` 仍引用已删除的 `stations/*`，**当前网页构建失败**；`src/style.css` 仍是九站点版本，需要按第 3 节精简重写。
- 未写：`src/send.ts`（寄件三态）、`src/sheet.ts`（证据面单）。
- `apps/web/package.json` 中的 `react`、`react-dom`、`@xyflow/react` 已不再被引用；是否移除由维护锁文件的 B 决定。
- 与本工作无关但会让 CI 失败：根目录 `tsc -b` 卡在 `examples/consumer/src/index.ts` 引用不存在的 `./wallet-cast.js`（工作区原有的未提交改动）。

## 8. 测试与验收

- 删除 `tests/e2e/graph.spec.ts` 和 `tests/e2e/guard.spec.ts`（对应页面已砍）；按新结构重写 `tests/e2e/web.spec.ts`，大约 9 条：
  1. 收件替换到采用，含自动复验。
  2. 全部失败与预算耗尽分别停止。
  3. 刷新后恢复同一运行。
  4. 提交响应丢失后用同一 requestId 重试。
  5. 一句话填单（测试替身草案）后提交并采用。
  6. 证据面单：原始字节下载一致，JSON Pointer 能定位。
  7. 第二实例复验与篡改副本被拒。
  8. 轮询中断后恢复。
  9. 手机布局、后端不可用、私有文件 403。
  
  另加一条寄件"未配置或未发现钱包"的如实显示。测试统一开启 reduced motion。
- 验收标准：
  - 首次打开 5 秒内看懂要做什么，3 次点击内得到第一个结果。
  - 390px 宽的手机上没有横向滚动，键盘可以走完整个流程。
  - 控制台无报错。
  - 所有结论都来自后端字段。
- 完成后更新 `apps/web/README.md`、`tests/e2e/README.md`、根 README 的前端段落，并新增一条决定记录取代 018 的站点结构。
