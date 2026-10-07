import type { WalletReview, WalletIntent } from '@verdict/protocol';
import { decodeFunctionData, erc20Abi } from 'viem';
import { escape as e } from '../view';
import { formatUnits, reason } from './presentation';

export function actualPayment(r:WalletReview){
  if(r.intent.operation==='native_transfer')return {recipient:r.transaction.to,amount:formatUnits(r.transaction.value),operation:'原生币付款'};
  try{
    const call=decodeFunctionData({abi:erc20Abi,data:r.transaction.data as `0x${string}`});
    if(call.functionName==='transfer'||call.functionName==='approve')return {recipient:String(call.args[0]),amount:String(call.args[1]),operation:call.functionName==='approve'?'ERC-20 授权':'ERC-20 付款'};
  }catch{}
  return {recipient:'无法解析',amount:'无法解析',operation:'未识别调用'};
}
export function paymentComparison(r:WalletReview,symbol:string,network:(chain:string)=>string){
  const i=r.intent,t=r.transaction,actual=actualPayment(r),native=i.operation==='native_transfer';
  const expectedRecipient=native?i.recipient:i.contractAction.kind==='erc20_transfer'?i.contractAction.recipient:i.contractAction.spender;
  const expectedAmount=native?`≤ ${formatUnits(i.maxValueWei)} ${symbol}`:`${i.contractAction.amount} 最小单位`;
  const amountMatches=native?BigInt(t.value)<=BigInt(i.maxValueWei):actual.amount===i.contractAction.amount;
  const fee=r.preparedTransaction?BigInt(r.preparedTransaction.gas)*BigInt(r.preparedTransaction.maxFeePerGas):null;
  const rows:Array<{label:string;expected:string;actual:string;match:boolean|null}>= [
    {label:'发送账户',expected:i.account,actual:t.from,match:i.account===t.from},
    {label:native||i.contractAction.kind==='erc20_transfer'?'收款地址':'授权对象',expected:expectedRecipient,actual:actual.recipient,match:expectedRecipient.toLowerCase()===actual.recipient.toLowerCase()},
    {label:'金额 / 数量',expected:expectedAmount,actual:`${actual.amount} ${native?symbol:'最小单位'}`,match:amountMatches},
    {label:'网络',expected:network(i.chainId),actual:network(t.chainId),match:i.chainId===t.chainId},
    {label:'资产',expected:native?symbol:i.recipient,actual:native?symbol:t.to,match:native?true:i.recipient===t.to},
    {label:'最高网络费用',expected:`≤ ${formatUnits(i.maxTotalFeeWei)} ${symbol}`,actual:fee===null?'等待预执行':`${formatUnits(fee.toString())} ${symbol}`,match:fee===null?null:fee<=BigInt(i.maxTotalFeeWei)},
  ];
  if(native)rows.push({label:'调用数据',expected:'0x',actual:t.data,match:t.data==='0x'});
  else rows.push({label:'方法',expected:i.functionSelector,actual:t.data.slice(0,10),match:i.functionSelector===t.data.slice(0,10)});
  const mismatches=rows.filter(row=>row.match===false).length;
  return `<div class="payment-section-heading"><div><span class="product-eyebrow">PAYMENT SCOPE</span><h2>付款条件对照</h2></div><span class="scope-count ${mismatches?'mismatch':''}">${mismatches?`${mismatches} 项不一致`:'本次交易'}</span></div><div class="comparison-table" role="table" aria-label="付款条件与实际交易"><div class="comparison-row comparison-labels" role="row"><span role="columnheader">核对字段</span><span role="columnheader">本次付款条件</span><span role="columnheader">实际交易</span></div>${rows.map(row=>`<div class="comparison-row ${row.match===false?'mismatch':''}" role="row" data-field="${e(row.label)}"><span role="rowheader">${e(row.label)}<small>${row.match===false?'不一致':row.match===null?'待取得':'一致'}</small></span><div role="cell"><span class="comparison-mobile-label">付款条件</span><code>${e(row.expected)}</code></div><div role="cell"><span class="comparison-mobile-label">实际交易</span><code>${e(row.actual)}</code></div></div>`).join('')}</div>`;
}
export function paymentMilestones(r:WalletReview,hasHash:boolean){
  const index=hasHash?3:r.status==='ALLOWED'?2:r.status==='QUEUED'||r.status==='REVIEWING'?1:1;
  const stopped=['BLOCKED','UNCERTAIN','CANCELLED','INTERRUPTED','EXPIRED'].includes(r.status);
  return `<ol class="payment-milestones" aria-label="付款阶段">${['付款条件','签名前检查','逐笔确认','链上结果'].map((label,i)=>`<li class="${i===index?'current':''} ${i===index&&stopped?'stopped':''}" ${i===index?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}</span>${label}</li>`).join('')}</ol>`;
}
export function confirmationSummary(r:WalletReview,symbol:string,network:string){
  const actual=actualPayment(r);
  return `<div class="confirmation-summary"><span class="product-eyebrow">本次签名</span><strong>${e(actual.amount)} ${e(r.intent.operation==='native_transfer'?symbol:'最小单位')}</strong><dl><dt>${r.intent.operation==='contract_call'&&r.intent.contractAction.kind==='erc20_approve'?'授权对象':'收款地址'}</dt><dd>${e(actual.recipient)}</dd><dt>网络</dt><dd>${e(network)}</dd></dl></div>`;
}
export function observationSummary(r:WalletReview,hash:string|null){
  if(!hash)return '';
  const receipt=r.receiptReport,covered=r.intent.operation==='native_transfer'&&r.transaction.chainId==='0x3c8';
  const receiptLabel=receipt?.receiptStatus==='SUCCESS'?'执行成功':receipt?.receiptStatus==='FAIL'?'执行失败':receipt?.receiptStatus==='REJECTED'?'交易不匹配':covered?'等待链上结果':'未覆盖';
  const state=receipt?.postStateStatus==='POST_STATE_RECHECKED'?'已复查':receipt?.postStateStatus==='UNKNOWN'?'尚未核实':'未复查';
  return `<div class="observation-summary"><div class="payment-section-heading"><h2>链上结果</h2></div><dl><div><dt>回执观察</dt><dd>${receiptLabel}</dd></div><div><dt>状态复查</dt><dd>${state}</dd></div><div><dt>证据记录</dt><dd>${r.evidenceRef?'已保存':'未保存'}</dd></div></dl>${receipt?.error?`<p>${e(reason(receipt.error))}</p>`:''}</div>`;
}
export function intentRecipient(intent:WalletIntent){return intent.operation==='native_transfer'?intent.recipient:intent.contractAction.kind==='erc20_transfer'?intent.contractAction.recipient:intent.contractAction.spender;}
