import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {encodeFunctionData, erc20Abi, keccak256, toHex} from 'viem';
import {WalletReviewSchema, type WalletReview, type CreateWalletReviewSchema} from '@verdict/protocol';
import {z} from 'zod';
import {digest} from '@verdict/core';
import {walletHarness,body,account,recipient,txHash} from './wallet-graph-harness.js';

const token='0x'+'3'.repeat(40),spender='0x'+'4'.repeat(40),runtime='0x60006000';
const word=(n:bigint)=>toHex(n,{size:32});
const topic=(address:string)=>'0x'+'0'.repeat(24)+address.slice(2);
const confirmation=(r:WalletReview)=>({transactionDigest:r.transactionDigest,account:r.transaction.from,chainId:r.transaction.chainId,confirmationNonce:r.confirmationNonce,walletSessionId:r.walletSessionId,walletSessionRevision:r.walletSessionRevision,handwritingAcknowledged:true});
export function tokenBody(approve=false,amount=100n):z.infer<typeof CreateWalletReviewSchema>{
  return {...body(),transaction:{chainId:'0x3c8',from:account,to:token,value:'0x0',data:encodeFunctionData({abi:erc20Abi,functionName:approve?'approve':'transfer',args:[(approve?spender:recipient) as `0x${string}`,amount]})},
    intent:{account,chainId:'0x3c8',recipient:token,maxValueWei:'0',maxTotalFeeWei:'1000000',operation:'contract_call',functionSelector:approve?'0x095ea7b3':'0xa9059cbb',contractAction:approve?{kind:'erc20_approve',spender,amount:amount.toString()}:{kind:'erc20_transfer',recipient,amount:amount.toString()}}};
}
async function tokenHarness(){
  const f=await walletHarness();
  f.h.config.wallet!.contractCalls.enabled=true;
  f.h.config.wallet!.networks[0].tokens=[{address:token,codeHash:keccak256(runtime),maxTransferAmount:'1000',maxApprovalAmount:'1000',approvedSpenders:[spender]}];
  const state={code:runtime,proxy:false,delta:100n,allowance:0n,returnFalse:false,extraLog:false,innerCall:false,simulationFailure:false};
  f.rpcState.handler=async(method,params)=>{
    if(method==='eth_getCode')return params[0]===token?state.code:'0x';
    if(method==='eth_getStorageAt')return word(state.proxy?1n:0n);
    if(method==='eth_estimateGas')return '0xc350';
    if(method==='eth_call'){
      const data=params[0].data as string;
      if(data.startsWith('0x70a08231'))return word(data.endsWith(account.slice(2))?1000n:200n);
      if(data.startsWith('0xdd62ed3e'))return word(state.allowance);
      return word(state.returnFalse?0n:1n);
    }
    if(method==='debug_traceCall')return {type:'CALL',from:account,to:token,value:'0x0',calls:state.innerCall?[{type:'DELEGATECALL'}]:[]};
    if(method==='eth_simulateV1'){
      const call=params[0].blockStateCalls[0].calls[0],approve=call.data.startsWith('0x095ea7b3'),amount=BigInt('0x'+call.data.slice(74));
      const log={address:token,topics:[keccak256(toHex(approve?'Approval(address,address,uint256)':'Transfer(address,address,uint256)')),topic(account),topic(approve?spender:recipient)],data:word(amount)};
      const first={status:state.simulationFailure?'0x0':'0x1',gasUsed:'0xc350',returnData:word(1n),logs:state.extraLog?[log,{...log,address:spender}]:[log]};
      const after=approve?[amount]:[1000n-state.delta,200n+state.delta];
      return [{calls:[first,...after.map(n=>({status:'0x1',gasUsed:'0x100',returnData:word(n),logs:[]}))]}];
    }
    return undefined;
  };
  return {...f,state};
}

test('v2 requires an explicit session and a fresh confirmation; no old client or fake ink bypass',async()=>{
  const f=await walletHarness();try{
    const old={...body()} as Record<string,unknown>;delete old.schemaVersion;delete old.walletSessionId;delete old.walletSessionRevision;
    assert.equal((await f.rawApi('/api/wallet/reviews',old)).code,400);
    const r=await f.create();assert.equal(r.schemaVersion,'wallet-review-v2');assert.equal(r.status,'ALLOWED');
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).data.error,'WALLET_CONFIRMATION_REQUIRED');
    const path=`/api/wallet/reviews/${r.reviewId}/confirm`;
    assert.equal((await f.api(path,{...confirmation(r),handwritingAcknowledged:false})).code,400);
    assert.equal((await f.api(path,{...confirmation(r),name:'PRIVATE_NAME',ink:'PRIVATE_INK'})).code,400);
    for(const patch of [{account:recipient},{chainId:'0x1'},{transactionDigest:'0x'+'9'.repeat(64)},{confirmationNonce:randomUUID()},{walletSessionRevision:2},{walletSessionId:randomUUID()}]){
      assert.equal((await f.api(path,{...confirmation(r),...patch})).code,409);
    }
    await f.confirm(r);
    assert.equal((await f.api(path,confirmation(r))).data.error,'WALLET_ALREADY_CONFIRMED');
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:{...r.preparedTransaction,value:'0x65'}})).data.error,'WALLET_TRANSACTION_CHANGED');
    const consumed=await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction});assert.equal(consumed.code,200);
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
    const second=await f.create();assert.equal((await f.api(`/api/wallet/reviews/${second.reviewId}/confirm`,confirmation(r))).code,409);
    const rows=f.h.app.engine.store.db.prepare('SELECT body FROM wallet_reviews').all();assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));
    assert.ok(!f.rpcState.calls.some(c=>/send|sign/.test(c.method)));
  }finally{await f.close();}
});
test('model BLOCK can be continued only through an explicit risk override and remains attributed',async()=>{
  const f=await walletHarness();try{
    f.reviewerState.verdict='BLOCK';const r=await f.create();assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'PI_BLOCK');
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/confirm`,confirmation(r))).code,409);
    const override={...confirmation(r),acknowledgement:'CONTINUE_WITH_RISK' as const};
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/override`,override)).code,200);
    assert.equal(f.h.app.wallet.get(r.reviewId).userOverride?.reasonCode,'PI_BLOCK');
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,200);
    const after=f.h.app.wallet.get(r.reviewId);assert.equal(after.status,'CONSUMED');assert.equal(after.reviewer.verdict,'BLOCK');
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
    const broadcast=await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});assert.equal(broadcast.code,200);
    assert.ok((await f.graph(r.reviewId)).events.some(e=>e.eventType==='wallet.user.overridden'&&e.status==='WAITING_SIGNATURE'));
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/override`,{...override,name:'NAME'})).code,400);
  }finally{await f.close();}
});
test('hard boundary BLOCK, preflight uncertainty, altered parameters and missing confirmation cannot be overridden',async()=>{
  const f=await walletHarness();try{
    const changed=body();changed.transaction.to=recipient;changed.intent.recipient='0x'+'9'.repeat(40);
    const hard=await f.create(changed);assert.equal(hard.status,'BLOCKED');assert.equal(hard.reason,'RECIPIENT_CHANGED');
    assert.equal((await f.api(`/api/wallet/reviews/${hard.reviewId}/override`,{...confirmation(hard),transactionDigest:'0x'+'1'.repeat(64),acknowledgement:'CONTINUE_WITH_RISK'})).code,409);
    f.reviewerState.verdict='UNCERTAIN';const unknown=await f.create();assert.equal(unknown.status,'UNCERTAIN');assert.equal(unknown.reason,'PI_UNCERTAIN');
    const invalid={...confirmation(unknown),acknowledgement:'CONTINUE_WITH_RISK' as const};assert.equal((await f.api(`/api/wallet/reviews/${unknown.reviewId}/override`,invalid)).code,200);
    assert.equal((await f.api(`/api/wallet/reviews/${unknown.reviewId}/consume`,{transaction:{...unknown.preparedTransaction,value:'0x65'}})).code,409);
    f.rpcState.errorMethod='eth_call';const noProof=await f.create();assert.equal(noProof.reviewer.verdict,null);
    assert.equal((await f.api(`/api/wallet/reviews/${noProof.reviewId}/override`,{...confirmation(noProof),transactionDigest:'0x'+'1'.repeat(64),acknowledgement:'CONTINUE_WITH_RISK'})).code,409);
  }finally{await f.close();}
});
function receiptFixture(f:Awaited<ReturnType<typeof tokenHarness>>,r:WalletReview,options:{failed?:boolean;eventWrong?:boolean;stateDifferent?:boolean}={}){
  const approve=r.intent.operation==='contract_call'&&r.intent.contractAction.kind==='erc20_approve';
  f.rpcState.txPatch={...r.preparedTransaction,input:r.preparedTransaction!.data};
  f.rpcState.receiptPatch={to:token,gasUsed:'0xc350',status:options.failed?'0x0':'0x1',logs:options.failed?[]:[{address:options.eventWrong?spender:token,topics:[keccak256(toHex(approve?'Approval(address,address,uint256)':'Transfer(address,address,uint256)')),topic(account),topic(approve?spender:recipient)],data:word(100n),removed:false}]};
  const previous=f.rpcState.handler;
  f.rpcState.handler=async(method,params)=>{
    if(method==='eth_call'&&params.at(-1)==='0x11'){
      const data=params[0].data as string;
      if(data.startsWith('0xdd62ed3e'))return word(options.failed?0n:100n);
      if(data.startsWith('0x70a08231'))return word(data.endsWith(account.slice(2))?(options.failed?1000n:900n):(options.failed?200n:options.stateDifferent?333n:300n));
    }
    return previous?.(method,params);
  };
}
for(const approve of [false,true])test(`token ${approve?'approval':'transfer'} receipt exports v2 observations and independently replays without restoring permission`,async()=>{
  const f=await tokenHarness(),g=await tokenHarness();try{
    const r=await f.create(tokenBody(approve));await f.confirm(r);assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,200);
    receiptFixture(f,r);receiptFixture(g,r);
    const reported=await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});assert.equal(reported.code,200,JSON.stringify(reported.data));
    assert.equal(reported.data.receiptReport.receiptStatus,'SUCCESS');assert.equal(reported.data.tokenPostState.receiptEvent,'MATCH');assert.equal(reported.data.tokenPostState.stateComparison,'MATCH');
    const packet=(await f.api('/api/wallet/evidence/'+reported.data.evidenceRef)).data;assert.equal(packet.body.version,'wallet-observation-v2');
    const replay=(await g.api('/api/wallet/evidence/replay',{packet})).data;assert.equal(replay.status,'MATCH',JSON.stringify(replay));assert.equal(replay.reviewAndPermit,'NOT_REPLAYED');
    const tampered=structuredClone(packet);tampered.body.tokenPostState.after.values[0]='999';
    assert.equal((await g.api('/api/wallet/evidence/replay',{packet:tampered})).data.integrity,'MISMATCH');
    tampered.evidenceRef=digest(tampered.body);assert.equal((await g.api('/api/wallet/evidence/replay',{packet:tampered})).data.status,'MISMATCH');
    g.h.config.wallet!.networks[0].tokens=[];assert.equal((await g.api('/api/wallet/evidence/replay',{packet})).data.status,'MISMATCH');
  }finally{await f.close();await g.close();}
});
for(const variant of ['failed','eventWrong','stateDifferent','historyUnavailable'] as const)test(`token receipt ${variant} remains separate from receipt success and preflight ALLOW`,async()=>{
  const f=await tokenHarness();try{
    const r=await f.create(tokenBody());await f.confirm(r);assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,200);
    receiptFixture(f,r,{[variant]:true});if(variant==='historyUnavailable')f.rpcState.errorMethod='eth_call';
    const reported=await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});assert.equal(reported.code,200,JSON.stringify(reported.data));const done=reported.data;
    assert.equal(done.reviewer.verdict,'ALLOW');
    if(variant==='failed'){assert.equal(done.receiptReport.receiptStatus,'FAIL');assert.equal(done.tokenPostState.stateComparison,'NOT_EXECUTED');}
    else if(variant==='historyUnavailable'){assert.equal(done.receiptReport.receiptStatus,'SUCCESS');assert.equal(done.receiptReport.postStateStatus,'UNKNOWN');assert.equal(done.tokenPostState,undefined);assert.equal(done.evidenceRef,undefined);}
    else{assert.equal(done.receiptReport.receiptStatus,'SUCCESS');assert.equal(done.tokenPostState[variant==='eventWrong'?'receiptEvent':'stateComparison'],variant==='eventWrong'?'MISMATCH':'DIFFERENT');}
  }finally{await f.close();}
});
test('user override cannot survive cancel, session changes, expiry or recheck failure',async()=>{
  for(const mode of ['cancel','session','expiry','nonce','restart']){
    const f=await walletHarness();try{
      f.reviewerState.verdict='UNCERTAIN';const r=await f.create();const path=`/api/wallet/reviews/${r.reviewId}`;
      const payload={...confirmation(r),acknowledgement:'CONTINUE_WITH_RISK'};assert.equal((await f.api(path+'/override',payload)).code,200);
      assert.equal((await f.api(path+'/override',payload)).code,409);
      if(mode==='cancel')await f.api(path+'/cancel',{});
      if(mode==='session')await f.api(`/api/wallet/sessions/${f.session.sessionId}`,{account,chainId:'0x3c8',providerId:'another',revision:1,connected:true});
      if(mode==='expiry'){const stored=f.h.app.wallet.get(r.reviewId);stored.expiresAt=Date.now()-1;f.h.app.engine.store.db.prepare('UPDATE wallet_reviews SET body=? WHERE id=?').run(JSON.stringify(stored),r.reviewId);}
      if(mode==='nonce')f.rpcState.handler=async m=>m==='eth_getTransactionCount'?'0x2':undefined;
      if(mode==='restart')await f.h.restart();
      assert.equal((await f.api(path+'/consume',{transaction:r.preparedTransaction})).code,409);
      assert.equal((await f.api(path+'/override',payload)).code,409);
      assert.ok(!(await f.graph(r.reviewId)).events.some(e=>e.status==='CONSUMED'));
    }finally{await f.close();}
  }
});
test('known insufficient native balance is a specific hard failure before gas simulation',async()=>{
  const f=await walletHarness();try{
    f.rpcState.handler=async(method,params)=>method==='eth_getBalance'&&params[0]===account?'0x0':undefined;
    const r=await f.create();assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'INSUFFICIENT_BALANCE');
    assert.ok(!f.rpcState.calls.some(c=>c.method==='eth_estimateGas'||c.method==='eth_call'));
    assert.equal(f.reviewerState.requests,0);
  }finally{await f.close();}
});
for(const patch of [{account:recipient},{chainId:'0x1'},{providerId:'another-wallet'},{connected:false}])test(`session changes invalidate approved and confirmed transactions: ${Object.keys(patch)[0]}`,async()=>{
  const f=await walletHarness();try{
    const r=await f.create();await f.confirm(r);
    const response=await f.api(`/api/wallet/sessions/${f.session.sessionId}`,{account,chainId:'0x3c8',providerId:'test-wallet',connected:true,revision:1,...patch});
    assert.equal(response.code,200);assert.equal(response.data.revision,2);
    assert.equal(f.h.app.wallet.get(r.reviewId).status,'CANCELLED');
    assert.equal(f.h.app.wallet.get(r.reviewId).userConfirmationDigest,undefined);
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
    assert.equal((await f.api('/api/wallet/reviews',body())).code,409);
  }finally{await f.close();}
});
test('changing a session during review cannot resurrect a cancelled review or reach the model',async()=>{
  const f=await walletHarness();try{
    f.rpcState.delayMethod='eth_getBalance';f.rpcState.delayMs=80;
    const start=await f.api('/api/wallet/reviews',body());
    await f.api(`/api/wallet/sessions/${f.session.sessionId}`,{account,chainId:'0x3c8',providerId:'test-wallet',connected:false,revision:1});
    await new Promise(r=>setTimeout(r,120));
    assert.equal(f.h.app.wallet.get(start.data.reviewId).status,'CANCELLED');assert.equal(f.reviewerState.requests,0);
  }finally{await f.close();}
});
test('disconnect racing with permit recheck prevents one-use consumption',async()=>{
  const f=await walletHarness();try{
    const r=await f.create();await f.confirm(r);
    f.rpcState.delayMethod='eth_getBalance';f.rpcState.delayMs=80;
    const consume=f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction});
    await new Promise(resolve=>setTimeout(resolve,20));
    await f.api(`/api/wallet/sessions/${f.session.sessionId}`,{account,chainId:'0x3c8',providerId:'test-wallet',connected:false,revision:1});
    assert.equal((await consume).code,409);
    assert.equal(f.h.app.wallet.get(r.reviewId).status,'CANCELLED');
    assert.ok(!(await f.graph(r.reviewId)).events.some(e=>e.status==='CONSUMED'));
  }finally{await f.close();}
});
test('expiration, restart, and state changes invalidate confirmation without recording a broadcast',async()=>{
  const f=await walletHarness();try{
    const r=await f.create();await f.confirm(r);
    f.h.app.engine.store.db.prepare('UPDATE wallet_reviews SET body=? WHERE id=?').run(JSON.stringify({...f.h.app.wallet.get(r.reviewId),expiresAt:Date.now()-1}),r.reviewId);
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
    const s=await f.create();await f.confirm(s);
    f.rpcState.handler=async(m)=>m==='eth_getTransactionCount'?'0x2':undefined;
    assert.equal((await f.api(`/api/wallet/reviews/${s.reviewId}/consume`,{transaction:s.preparedTransaction})).code,409);
    assert.equal(f.h.app.wallet.get(s.reviewId).userConfirmedAt,undefined);
    f.rpcState.handler=null;const t=await f.create();await f.confirm(t);await f.h.restart();
    assert.equal((await f.api(`/api/wallet/reviews/${t.reviewId}/consume`,{transaction:t.preparedTransaction})).code,409);
    assert.equal(f.h.app.wallet.get(t.reviewId).status,'INTERRUPTED');
  }finally{await f.close();}
});
for(const approve of [false,true])test(`configured ERC-20 ${approve?'approval':'transfer'} binds parameters and verifies simulated effects before confirming`,async()=>{
  const f=await tokenHarness();try{
    const r=await f.create(tokenBody(approve));assert.equal(r.status,'ALLOWED',r.reason);
    const facts=r.checks.find(c=>c.id==='preflight')!.facts;assert.equal(facts.operation,approve?'erc20_approve':'erc20_transfer');assert.equal(facts.after,approve?'100':'900,300');
    assert.equal(facts.codeHash,keccak256(runtime));assert.equal(r.preparedTransaction!.gas,'0xc350');
    await f.confirm(r);assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,200);
    assert.equal(f.rpcState.calls.filter(c=>c.method==='eth_simulateV1').length,2);
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash:'0x'+'a'.repeat(64)})).data.error,'BROADCAST_TRANSACTION_MISMATCH');
    assert.ok(!f.rpcState.calls.some(c=>/send|sign/.test(c.method)));
  }finally{await f.close();}
});
for(const [name,patch,reason] of [
  ['proxy',{proxy:true},'PROXY_OR_UPGRADE_AUTHORITY_NOT_SUPPORTED'],
  ['changed code',{code:'0x60016000'},'TOKEN_CODE_CHANGED'],
  ['wrong asset delta',{delta:99n},'TOKEN_DELTA_MISMATCH'],
  ['false ERC-20 return',{returnFalse:true},'TOKEN_RETURN_NOT_TRUE'],
  ['foreign event',{extraLog:true},'UNEXPECTED_TOKEN_EFFECT'],
  ['delegatecall',{innerCall:true},'UNEXAMINED_INTERNAL_CALL'],
  ['simulation revert',{simulationFailure:true},'CONTRACT_SIMULATION_FAILED'],
] as const)test(`contract ${name} remains uncertain before model authorization`,async()=>{
  const f=await tokenHarness();try{Object.assign(f.state,patch);const r=await f.create(tokenBody());assert.equal(r.status,'UNCERTAIN',r.reason);assert.equal(r.reason,reason);assert.equal(f.reviewerState.requests,0);assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/confirm`,{...confirmation(r),transactionDigest:'0x'+'1'.repeat(64)})).code,409);}finally{await f.close();}
});
test('missing simulation/trace support, high-risk allowance and intent changes never turn into ALLOW',async()=>{
  const f=await tokenHarness();try{
    for(const method of ['eth_simulateV1','debug_traceCall','eth_getStorageAt']){f.rpcState.errorMethod=method;assert.equal((await f.create(tokenBody())).status,'UNCERTAIN');}f.rpcState.errorMethod='';
    assert.equal((await f.create(tokenBody(true,2n**256n-1n))).reason,'UNLIMITED_APPROVAL');
    f.state.allowance=1n;assert.equal((await f.create(tokenBody(true))).reason,'APPROVAL_RESET_REQUIRED');
    const mismatch=tokenBody();mismatch.transaction.data=tokenBody(false,101n).transaction.data;assert.equal((await f.create(mismatch)).reason,'INTENT_CALL_MISMATCH');
    const trailing=tokenBody();trailing.transaction.data+='00';assert.equal((await f.create(trailing)).reason,'INTENT_CALL_MISMATCH');
    f.h.config.wallet!.networks[0].tokens=[];assert.equal((await f.create(tokenBody())).reason,'TOKEN_NOT_CONFIGURED');
    assert.equal(f.reviewerState.requests,0);
  }finally{await f.close();}
});
test('contract state changing after confirmation is rechecked before permit consumption',async()=>{
  const f=await tokenHarness();try{
    const r=await f.create(tokenBody());assert.equal(r.status,'ALLOWED');await f.confirm(r);
    f.state.delta=99n;
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
    assert.equal(f.h.app.wallet.get(r.reviewId).reason,'TOKEN_DELTA_MISMATCH');assert.equal(f.h.app.wallet.get(r.reviewId).userConfirmedAt,undefined);
  }finally{await f.close();}
});
test('configured runtime changing after confirmation cannot reach permit consumption',async()=>{
  const f=await tokenHarness();try{
    const r=await f.create(tokenBody());await f.confirm(r);f.state.code='0x60016000';
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
    assert.equal(f.h.app.wallet.get(r.reviewId).reason,'TOKEN_CODE_CHANGED');
    assert.equal(f.h.app.wallet.get(r.reviewId).userConfirmationDigest,undefined);
  }finally{await f.close();}
});
