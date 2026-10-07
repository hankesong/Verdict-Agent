import type { AgentGraphEvent } from "@verdict/protocol";
import { escape as e } from "../view";
export const reasons: Record<string,string> = {
  SPENDER_NOT_CONFIGURED:'授权对象未在允许范围内',TOKEN_NOT_CONFIGURED:'代币未在允许范围内',UNLIMITED_APPROVAL:'无限授权不在允许范围内',APPROVAL_RESET_REQUIRED:'请先撤销现有授权',TOKEN_APPROVAL_LIMIT:'授权数量超过上限',TOKEN_TRANSFER_LIMIT:'转账数量超过上限',TOKEN_CODE_CHANGED:'合约代码与已审查版本不符',PROXY_OR_UPGRADE_AUTHORITY_NOT_SUPPORTED:'代理或可升级合约暂未覆盖',TOKEN_BALANCE_INSUFFICIENT:'代币余额不足',TOKEN_DELTA_MISMATCH:'模拟资产变化不匹配',ALLOWANCE_MISMATCH:'模拟授权额度不匹配',TOKEN_RETURN_NOT_TRUE:'代币返回结果不符合要求',UNEXAMINED_INTERNAL_CALL:'包含未覆盖的内部调用',UNEXPECTED_TOKEN_EFFECT:'模拟出现额外资产事件',CONTRACT_SIMULATION_FAILED:'合约模拟执行失败',INTENT_CALL_MISMATCH:'合约参数与操作意图不一致',TOKEN_CALL_WITH_NATIVE_VALUE:'代币操作夹带原生币',FUNCTION_NOT_SUPPORTED:'调用函数暂未覆盖',TARGET_NOT_CONTRACT:'目标地址不是合约',

  TX_NOT_FOUND:"交易尚未被节点检索到",REPORT_INTERRUPTED:"上次观察已中断",RPC_TIMEOUT:"节点查询超时",RPC_OBSERVATION_UNAVAILABLE:"暂未取得链上观察",CONTRACT_CALL_PREFLIGHT:"合约预执行检查",
  PI_ALLOW:"本次检查通过", PI_BLOCK:"审查发现风险", PI_UNCERTAIN:"审查无法确定", PENDING:"等待审查", REVIEW_STARTED:"正在审查",
  RECIPIENT_CHANGED:"收款地址与请求不一致", VALUE_LIMIT:"金额超过单笔上限", FEE_LIMIT:"网络费用超过上限", FEE_POLICY_LIMIT:"费用上限超出允许范围",
  INSUFFICIENT_BALANCE:"余额不足以支付金额与费用", ACCOUNT_CHANGED:"发送账户已变化", CHAIN_OUT_OF_SCOPE:"当前网络不在审查范围内",
  TOKEN_APPROVAL_NOT_SUPPORTED:"代币授权尚未覆盖", CONTRACT_CALL_NOT_SUPPORTED:"合约调用尚未覆盖", CONTRACT_OR_DELEGATED_ACCOUNT_NOT_SUPPORTED:"合约或委托账户尚未覆盖",
  ZERO_RECIPIENT:"收款地址为零地址", PREFLIGHT_EXPIRED:"审查已过期，请重新审查", STATE_CHANGED_REVIEW_AGAIN:"链上状态已变化，请重新审查",
  RPC_METHOD_FAILED:"节点查询失败", RPC_CHAIN_MISMATCH:"节点网络不一致", BLOCK_CHANGED:"参考区块已变化", PENDING_NONCE_CHANGED:"有待确认交易，请稍后重试",
  UNEXPECTED_EXECUTION:"预执行结果超出当前支持范围", REVIEW_CANCELLED_OR_TIMEOUT:"审查超时或已取消", USER_CANCELLED:"已取消审查",
  RESTART_REQUIRES_NEW_REVIEW:"服务已重启，请重新审查", PERMIT_CONSUMED_ONCE:"已确认执行许可", EXPLICIT_SCOPE_MATCH:"交易参数匹配", NATIVE_TRANSFER_PREFLIGHT:"原生币转账预执行通过",
  UNVERIFIED_WALLET_REPORT:"钱包已报告，等待节点核对",CONSUMED:"执行许可已消费",BROADCAST:"交易已广播",POST_STATE_RECHECKED:"执行后状态已核对",RECEIPT_FAILED:"交易执行失败",UNKNOWN:"未知",UNVERIFIABLE:"不可复验",CANCELLED:"已取消",INTERRUPTED:"已中断",WAITING_SIGNATURE:"等待签名",
  WAITING_FOR_WALLET:"等待用户确认", PASSED:"检查通过", OBSERVED:"已读取链上状态", LOCKED:"交易参数已固定", ALLOW:"复核通过", BLOCK:"审查发现风险", UNCERTAIN:"无法确定", SAVED:"记录已保存", RECEIPT_CONFIRMED:"链上回执已核对", RECEIPT_NOT_FOUND:"尚未查到交易回执", REPORT_PENDING:"等待回执",
};
export const reason = (code: string) => reasons[code] ?? code;
export const statuses: Record<string,string> = {QUEUED:"等待审查",REVIEWING:"正在审查",ALLOWED:"等待签名",BLOCKED:"发现风险",UNCERTAIN:"未能核实",CONSUMED:"许可已使用",CANCELLED:"已取消",INTERRUPTED:"已中断",EXPIRED:"已过期",SUCCESS:"交易已确认",FAIL:"交易执行失败",REJECTED:"交易不匹配",UNKNOWN:"等待链上结果"};
export function formatUnits(value: string) { const n = BigInt(value), sign = n < 0n ? "−" : "", x = n < 0n ? -n : n; const f=(x%10n**18n).toString().padStart(18,"0").replace(/0+$/,""); return `${sign}${x/10n**18n}${f?"."+f:""}`; }
export function parseUnits(value: string) { if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value))throw Error("请输入有效金额，最多 18 位小数");const [whole,fraction=""]=value.split(".");const n=BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,"0"));if(n>=2n**256n)throw Error("金额超出范围");return n; }
export const stages: Record<string,string> = {TRANSACTION_INTENT:"交易已登记",BALANCE_OBSERVATION:"余额检查",NONCE_OBSERVATION:"交易序号检查",HARD_RULE:"交易规则检查",RPC_PREFLIGHT:"链上预执行",PI_REVIEW:"Agent 复核",PERMIT:"执行许可",BROADCAST:"交易已提交",RECEIPT:"链上回执核对",POST_STATE:"执行后状态核对",EVIDENCE:"证据已保存",EVIDENCE_REPLAY:"证据复验"};
export function graphRows(events:AgentGraphEvent[]) { return [...events].reverse().map(event=>`<li class="journey-event" data-event-id="${e(event.eventId)}"><time>${e(new Date(event.at).toLocaleTimeString("zh-CN",{hour12:false}))}</time><span class="event-point ${["BLOCK","FAIL","UNCERTAIN","UNKNOWN"].includes(event.status)?"warning":""}"></span><div><div class="event-title"><strong>${e(stages[event.stage??""]??"审查记录")}</strong><span>${e(event.source??"")}</span></div><p>${e(reason(event.reasonCode??event.status))}</p><details><summary>查看依据</summary><dl><dt>序号</dt><dd>${event.sequence}</dd><dt>状态</dt><dd>${e(event.status)}</dd>${event.eventType?`<dt>事件</dt><dd>${e(event.eventType)}</dd>`:""}${event.blockNumber?`<dt>区块</dt><dd>${BigInt(event.blockNumber).toString()}</dd>`:""}${event.resultDigest?`<dt>记录摘要</dt><dd>${e(event.resultDigest)}</dd>`:""}</dl></details></div></li>`).join(""); }
