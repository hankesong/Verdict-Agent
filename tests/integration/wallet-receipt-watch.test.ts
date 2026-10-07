import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WalletReceiptWatchSchema,type WalletReceiptWatch} from '@verdict/protocol';
import {walletHarness,txHash,account} from './wallet-graph-harness.js';

type Fixture=Awaited<ReturnType<typeof walletHarness>>;
const path=(id:string)=>`/api/wallet/reviews/${id}/receipt/watch`;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:Fixture,id:string,predicate:(r:WalletReceiptWatch)=>boolean){
  for(let i=0;i<200;i++){
    const reply=await f.api(path(id));assert.equal(reply.code,200,JSON.stringify(reply.data));
    const r=WalletReceiptWatchSchema.parse(reply.data);if(predicate(r))return r;await pause(10);
  }
  throw Error('Receipt watch test deadline');
}
async function fixture(){
  const f=await walletHarness();
  Object.assign(f.h.config.wallet!.receiptTracking,{pollIntervalMs:100,maxAttempts:4,maxDurationMs:5000});
  return f;
}
async function pending(f:Fixture,hash=txHash){
  const r=await f.consumed();f.rpcState.missingTx=true;
  const result=await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash:hash});assert.equal(result.code,200);
  assert.equal(result.data.receiptReport.receiptStatus,'UNKNOWN');return r;
}

test('watch is explicit, only accepts consumed reported transactions and preserves existing DTOs',async()=>{
  const f=await fixture();try{
    const r=await f.create();assert.equal((await f.api(path(r.reviewId),{})).data.error,'WALLET_PERMIT_NOT_CONSUMED');
    await f.confirm(r);await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction});
    assert.equal((await f.api(path(r.reviewId),{})).data.error,'NO_BROADCAST_REPORT');
    f.rpcState.missingTx=true;await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});
    const before=f.rpcState.calls.length;
    await pause(130);assert.equal(f.rpcState.calls.length,before,'no background RPC without explicit watch');
    assert.equal((await f.api(path(r.reviewId))).data.error,'WALLET_RECEIPT_WATCH_NOT_FOUND');
    for(const input of [{txHash},{rpcUrl:'http://127.0.0.1:1'},{maxAttempts:999},{deadlineAt:Date.now()+999999}])assert.equal((await f.api(path(r.reviewId),input)).code,400);
    f.h.config.wallet!.receiptTracking.enabled=false;
    assert.equal((await f.api(path(r.reviewId),{})).data.error,'WALLET_RECEIPT_TRACKING_DISABLED');
    assert.equal((await f.api(path(randomUUID()),{})).code,404);
    assert.equal(f.rpcState.calls.length,before);
    assert.equal(f.h.app.wallet.get(r.reviewId).status,'CONSUMED');
  }finally{await f.close();}
});

test('watch retries a missing transaction, saves actual observation and keeps model/permit unchanged',async()=>{
  const f=await fixture();try{
    const r=await pending(f),modelCalls=f.reviewerState.requests;
    const replies=await Promise.all(Array.from({length:5},()=>f.api(path(r.reviewId),{})));
    for(const reply of replies){assert.equal(reply.code,202);assert.equal(reply.data.createdAt,replies[0].data.createdAt);assert.equal(reply.data.deadlineAt,replies[0].data.deadlineAt);}
    const waiting=await until(f,r.reviewId,w=>w.status==='WAITING');assert.equal(waiting.attempts,1);assert.equal(waiting.reason,'TX_NOT_FOUND');
    const db=f.h.app.engine.store.db,changes=db.prepare('SELECT total_changes() AS n').get();
    f.h.app.receiptWatches.get(r.reviewId);assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),changes);
    f.rpcState.missingTx=false;
    const done=await until(f,r.reviewId,w=>w.status==='COMPLETED');assert.equal(done.attempts,2);assert.equal(done.nextPollAt,null);assert.ok(done.finishedAt);
    const review=f.h.app.wallet.get(r.reviewId);assert.equal(review.receiptReport?.receiptStatus,'SUCCESS');assert.ok(review.evidenceRef);assert.equal(review.status,'CONSUMED');
    const calls=f.rpcState.calls.length;assert.deepEqual((await f.api(path(r.reviewId),{})).data,done);await pause(150);assert.equal(f.rpcState.calls.length,calls);
    assert.equal(f.reviewerState.requests,modelCalls);assert.ok(!f.rpcState.calls.some(c=>/send|sign/i.test(c.method)));
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,409);
  }finally{await f.close();}
});

for(const outcome of ['FAIL','REJECTED','POST_STATE_UNKNOWN'] as const)test(`receipt watch preserves ${outcome} independently from observation progress`,async()=>{
  const f=await fixture();try{
    const r=await pending(f);f.rpcState.missingTx=false;
    if(outcome==='FAIL')f.rpcState.receiptPatch={status:'0x0'};
    if(outcome==='REJECTED')f.rpcState.txPatch={value:'0x65'};
    if(outcome==='POST_STATE_UNKNOWN')f.rpcState.postStateError=true;
    await f.api(path(r.reviewId),{});
    if(outcome==='POST_STATE_UNKNOWN'){
      await until(f,r.reviewId,w=>w.status==='WAITING');
      assert.equal(f.h.app.wallet.get(r.reviewId).receiptReport?.receiptStatus,'SUCCESS');
      assert.equal(f.h.app.wallet.get(r.reviewId).receiptReport?.postStateStatus,'UNKNOWN');
      f.rpcState.postStateError=false;
    }
    const done=await until(f,r.reviewId,w=>w.status===(outcome==='REJECTED'?'REJECTED':'COMPLETED'));
    assert.equal(f.h.app.wallet.get(r.reviewId).receiptReport?.receiptStatus,outcome==='POST_STATE_UNKNOWN'?'SUCCESS':outcome);
    const before=f.rpcState.calls.length;await f.api(path(r.reviewId)+'/resume',{});await pause(120);assert.equal(f.rpcState.calls.length,before);assert.equal(done.nextPollAt,null);
  }finally{await f.close();}
});

test('attempt exhaustion cannot be reset by repeated start, stop or resume; errors are bounded and redacted',async()=>{
  const f=await fixture();try{
    f.h.config.wallet!.receiptTracking.maxAttempts=2;const r=await pending(f);f.rpcState.errorMethod='eth_getTransactionByHash';
    await f.api(path(r.reviewId),{});const done=await until(f,r.reviewId,w=>w.status==='EXHAUSTED');
    assert.equal(done.attempts,2);assert.equal(done.reason,'WATCH_ATTEMPTS_EXHAUSTED');
    const before=f.rpcState.calls.length;
    for(const suffix of ['','/stop','/resume'])assert.deepEqual((await f.api(path(r.reviewId)+suffix,{})).data,done);
    await pause(220);assert.equal(f.rpcState.calls.length,before);
    assert.equal(f.h.app.wallet.get(r.reviewId).receiptReport?.receiptStatus,'UNKNOWN');
    assert.ok(!JSON.stringify(done).includes('SECRET_CANARY'));
  }finally{await f.close();}
});

test('stop and explicit resume preserve the original attempt and wall-clock budget',async()=>{
  const f=await fixture();try{
    f.h.config.wallet!.receiptTracking.pollIntervalMs=400;const r=await pending(f);
    const initial=(await f.api(path(r.reviewId),{})).data;
    await until(f,r.reviewId,w=>w.status==='WAITING');
    const stopped=(await f.api(path(r.reviewId)+'/stop',{})).data;assert.equal(stopped.status,'STOPPED');assert.equal(stopped.reason,'USER_STOPPED');
    const calls=f.rpcState.calls.length;await pause(430);assert.equal(f.rpcState.calls.length,calls);
    assert.deepEqual((await f.api(path(r.reviewId),{})).data,stopped);
    f.rpcState.missingTx=false;const resumed=(await f.api(path(r.reviewId)+'/resume',{})).data;
    assert.equal(resumed.deadlineAt,initial.deadlineAt);assert.equal(resumed.createdAt,initial.createdAt);assert.equal(resumed.attempts,1);
    assert.equal((await until(f,r.reviewId,w=>w.status==='COMPLETED')).attempts,2);
  }finally{await f.close();}
});

test('deadline exhaustion prevents later polls without pretending the transaction failed',async()=>{
  const f=await fixture();try{
    Object.assign(f.h.config.wallet!.receiptTracking,{maxDurationMs:150,pollIntervalMs:1000});
    const r=await pending(f);await f.api(path(r.reviewId),{});
    const done=await until(f,r.reviewId,w=>w.status==='EXHAUSTED');assert.equal(done.reason,'WATCH_DEADLINE_REACHED');assert.equal(done.attempts,1);
    assert.equal(f.h.app.wallet.get(r.reviewId).receiptReport?.receiptStatus,'UNKNOWN');
  }finally{await f.close();}
});

test('restart stops queued observation without RPC; explicit resume works after wallet disconnect',async()=>{
  const f=await fixture();try{
    f.h.config.wallet!.receiptTracking.pollIntervalMs=1000;const r=await pending(f);
    await f.api(path(r.reviewId),{});const waiting=await until(f,r.reviewId,w=>w.status==='WAITING');
    const before=f.rpcState.calls.length;await f.h.restart();await pause(120);assert.equal(f.rpcState.calls.length,before);
    const recovered=(await f.api(path(r.reviewId))).data;assert.equal(recovered.status,'STOPPED');assert.equal(recovered.reason,'RESTART_REQUIRES_RESUME');assert.equal(recovered.attempts,waiting.attempts);assert.equal(recovered.deadlineAt,waiting.deadlineAt);
    assert.equal(f.h.app.wallet.sessions.get(f.session.sessionId).connected,false);
    f.rpcState.missingTx=false;assert.equal((await f.api(path(r.reviewId)+'/resume',{})).code,202);
    assert.equal((await until(f,r.reviewId,w=>w.status==='COMPLETED')).attempts,2);
  }finally{await f.close();}
});

test('crash-state recovery retains spent attempts and never retries a RUNNING record implicitly',async()=>{
  const f=await fixture();try{
    const r=await pending(f);await f.api(path(r.reviewId),{});await until(f,r.reviewId,w=>w.status==='WAITING');await f.api(path(r.reviewId)+'/stop',{});
    const db=f.h.app.engine.store.db,row=db.prepare('SELECT body FROM wallet_receipt_watches WHERE review_id=?').get(r.reviewId) as {body:string};
    const saved=JSON.parse(row.body);saved.status='RUNNING';saved.nextPollAt=null;saved.finishedAt=null;
    db.prepare('UPDATE wallet_receipt_watches SET body=? WHERE review_id=?').run(JSON.stringify(saved),r.reviewId);
    const before=f.rpcState.calls.length;await f.h.restart();assert.equal(f.rpcState.calls.length,before);
    const recovered=(await f.api(path(r.reviewId))).data;assert.equal(recovered.status,'STOPPED');assert.equal(recovered.attempts,1);
  }finally{await f.close();}
});

test('queue capacity is bounded and disabled configuration stops existing work on resume',async()=>{
  const f=await fixture();try{
    Object.assign(f.h.config.wallet!.receiptTracking,{maxPending:1,pollIntervalMs:1000});
    const first=await pending(f),second=await pending(f,'0x'+'d'.repeat(64));
    await f.api(path(first.reviewId),{});await until(f,first.reviewId,w=>w.status==='WAITING');
    assert.equal((await f.api(path(second.reviewId),{})).data.error,'WALLET_RECEIPT_QUEUE_FULL');
    await f.api(path(first.reviewId)+'/stop',{});assert.equal((await f.api(path(second.reviewId),{})).code,202);
    await f.api(path(second.reviewId)+'/stop',{});f.h.config.wallet!.receiptTracking.enabled=false;
    assert.equal((await f.api(path(second.reviewId)+'/resume',{})).data.error,'WALLET_RECEIPT_TRACKING_DISABLED');
  }finally{await f.close();}
});

test('stopping an in-flight watch cannot resurrect it or duplicate a shared manual recheck',async()=>{
  const f=await fixture();let release=()=>{};try{
    const r=await pending(f);f.rpcState.missingTx=false;
    let entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    f.rpcState.handler=async method=>{if(method==='eth_getTransactionByHash'){entered();await gate;}return undefined;};
    await f.api(path(r.reviewId),{});await started;
    const before=f.rpcState.calls.filter(c=>c.method==='eth_getTransactionByHash').length;
    const manual=f.api(`/api/wallet/reviews/${r.reviewId}/receipt/recheck`,{});
    const stopped=await f.api(path(r.reviewId)+'/stop',{});assert.equal(stopped.data.status,'STOPPED');
    assert.equal((await f.api(path(r.reviewId)+'/resume',{})).data.error,'WALLET_WATCH_STOP_IN_PROGRESS');
    release();assert.equal((await manual).code,200);await pause(50);
    assert.equal((await f.api(path(r.reviewId))).data.status,'STOPPED');
    assert.equal(f.rpcState.calls.filter(c=>c.method==='eth_getTransactionByHash').length,before);
    assert.equal(f.h.app.wallet.get(r.reviewId).receiptReport?.receiptStatus,'SUCCESS');
    assert.equal((await f.api(path(r.reviewId)+'/resume',{})).data.status,'COMPLETED');
  }finally{release();await f.close();}
});

test('watching an already saved receipt performs no additional RPC',async()=>{
  const f=await fixture();try{
    const r=await f.consumed();await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});
    const before=f.rpcState.calls.length;
    assert.equal((await f.api(path(r.reviewId),{})).data.status,'COMPLETED');await pause(120);assert.equal(f.rpcState.calls.length,before);
    assert.equal((await f.api(`/api/wallet/sessions/${f.session.sessionId}`,{account,chainId:'0x3c8',providerId:'test-wallet',connected:false,revision:1})).code,200);
    assert.equal((await f.api(path(r.reviewId))).data.status,'COMPLETED');
  }finally{await f.close();}
});

test('restart reconciles a stored observation even when the last reserved attempt reached its limit',async()=>{
  const f=await fixture();try{
    const r=await pending(f);await f.api(path(r.reviewId),{});await until(f,r.reviewId,w=>w.status==='WAITING');await f.api(path(r.reviewId)+'/stop',{});
    f.rpcState.missingTx=false;await f.api(`/api/wallet/reviews/${r.reviewId}/receipt/recheck`,{});
    const db=f.h.app.engine.store.db,row=db.prepare('SELECT body FROM wallet_receipt_watches WHERE review_id=?').get(r.reviewId) as {body:string};
    const saved=JSON.parse(row.body);saved.status='RUNNING';saved.attempts=saved.maxAttempts;saved.deadlineAt=Date.now()-1;saved.nextPollAt=null;saved.finishedAt=null;
    db.prepare('UPDATE wallet_receipt_watches SET body=? WHERE review_id=?').run(JSON.stringify(saved),r.reviewId);
    const before=f.rpcState.calls.length;await f.h.restart();assert.equal(f.rpcState.calls.length,before);
    assert.equal((await f.api(path(r.reviewId))).data.status,'COMPLETED');
  }finally{await f.close();}
});

test('queue respects configured worker concurrency while several jobs are ready',async()=>{
  const f=await fixture();let release=()=>{};try{
    f.h.config.wallet!.rpcTimeoutMs=1000;f.h.config.wallet!.receiptTracking.concurrency=1;
    const reviews=[];for(const digit of ['a','b','c'])reviews.push(await pending(f,'0x'+digit.repeat(64)));
    let entered!:()=>void,active=0,peak=0;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    f.rpcState.handler=async method=>{
      if(method==='eth_getTransactionByHash'){active++;peak=Math.max(peak,active);entered();await gate;active--;return null;}return undefined;
    };
    await Promise.all(reviews.map(r=>f.api(path(r.reviewId),{})));await started;await pause(40);
    const states=await Promise.all(reviews.map(async r=>(await f.api(path(r.reviewId))).data));
    assert.equal(states.filter(r=>r.status==='RUNNING').length,1);assert.equal(states.filter(r=>r.status==='QUEUED').length,2);assert.equal(peak,1);
    await Promise.all(reviews.map(r=>f.api(path(r.reviewId)+'/stop',{})));release();await pause(30);assert.equal(peak,1);
  }finally{release();await f.close();}
});

test('risk override stays attributed when background receipt tracking completes',async()=>{
  const f=await fixture();try{
    f.reviewerState.verdict='BLOCK';const r=await f.create();
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/override`,{transactionDigest:r.transactionDigest,account:r.transaction.from,chainId:r.transaction.chainId,confirmationNonce:r.confirmationNonce,walletSessionId:r.walletSessionId,walletSessionRevision:r.walletSessionRevision,handwritingAcknowledged:true,acknowledgement:'CONTINUE_WITH_RISK'})).code,200);
    assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,200);
    f.rpcState.missingReceipt=true;await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});
    await f.api(path(r.reviewId),{});await until(f,r.reviewId,w=>w.status==='WAITING');f.rpcState.missingReceipt=false;
    await until(f,r.reviewId,w=>w.status==='COMPLETED');const final=f.h.app.wallet.get(r.reviewId);
    assert.equal(final.reviewer.verdict,'BLOCK');assert.equal(final.userOverride?.reasonCode,'PI_BLOCK');assert.equal(final.status,'CONSUMED');
  }finally{await f.close();}
});
