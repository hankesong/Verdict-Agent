import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WalletReviewActionsSchema,WalletReviewPageSchema,type WalletReview} from '@verdict/protocol';
import {walletHarness,body,account,recipient,txHash} from './wallet-graph-harness.js';

type Fixture=Awaited<ReturnType<typeof walletHarness>>;
const actions=async(f:Fixture,id:string)=>{
  const reply=await f.api(`/api/wallet/reviews/${id}/actions`);assert.equal(reply.code,200);
  return WalletReviewActionsSchema.parse(reply.data);
};
const page=async(f:Fixture,query='')=>{
  const reply=await f.api('/api/wallet/reviews?'+query);assert.equal(reply.code,200,JSON.stringify(reply.data));
  return WalletReviewPageSchema.parse(reply.data);
};
const save=(f:Fixture,r:WalletReview)=>f.h.app.engine.store.db.prepare('UPDATE wallet_reviews SET body=? WHERE id=?').run(JSON.stringify(r),r.reviewId);
const confirmation=(r:WalletReview)=>({transactionDigest:r.transactionDigest,account:r.transaction.from,chainId:r.transaction.chainId,confirmationNonce:r.confirmationNonce,walletSessionId:r.walletSessionId,walletSessionRevision:r.walletSessionRevision,handwritingAcknowledged:true});

test('history uses stable keyset ordering with timestamp ties, inserts and bound filters',async()=>{
  const f=await walletHarness();try{
    assert.deepEqual(await page(f),{schemaVersion:'wallet-review-page-v1',reviews:[],hasMore:false,nextCursor:null});
    const rows=[];
    for(let i=0;i<4;i++){const r=await f.create();r.createdAt=1000;save(f,r);rows.push(r);}
    const expected=rows.map(r=>r.reviewId).sort().reverse();
    const first=await page(f,`account=${account}&chainId=0x3c8&status=ALLOWED&operation=native_transfer&limit=2`);
    assert.deepEqual(first.reviews.map(r=>r.reviewId),expected.slice(0,2));assert.equal(first.hasMore,true);
    const newer=await f.create();
    const second=await page(f,`account=${account}&chainId=0x3c8&status=ALLOWED&operation=native_transfer&limit=2&cursor=${first.nextCursor}`);
    assert.deepEqual(second.reviews.map(r=>r.reviewId),expected.slice(2));assert.equal(second.hasMore,false);assert.equal(second.nextCursor,null);
    assert.equal((await page(f,'limit=1')).reviews[0].reviewId,newer.reviewId);
    assert.equal((await page(f,`account=${recipient}`)).reviews.length,0);
    assert.equal((await page(f,'chainId=0x1')).reviews.length,0);
    assert.equal((await page(f,'status=CANCELLED')).reviews.length,0);
    assert.equal((await f.api(`/api/wallet/reviews?limit=2&cursor=${first.nextCursor}`)).data.error,'WALLET_CURSOR_FILTER_MISMATCH');
    for(const query of ['limit=0','limit=101','limit=-1','limit=1.5','limit=2&limit=2','unknown=x','cursor=broken','account=oops','chainId=0x01','operation=swap'])assert.equal((await f.api('/api/wallet/reviews?'+query)).code,400,query);
  }finally{await f.close();}
});

test('history projects native and token summaries without private execution material; old records stay readable',async()=>{
  const f=await walletHarness();try{
    const base=await f.create(),db=f.h.app.engine.store.db;
    for(const kind of ['erc20_transfer','erc20_approve'] as const){
      const r:WalletReview={...base,reviewId:randomUUID(),clientRequestId:randomUUID(),createdAt:base.createdAt+1,
        intent:{account,chainId:'0x3c8',recipient,operation:'contract_call',maxValueWei:'0',maxTotalFeeWei:'1000000',functionSelector:kind==='erc20_transfer'?'0xa9059cbb':'0x095ea7b3',contractAction:kind==='erc20_transfer'?{kind,recipient:account,amount:'9007199254740993'}:{kind,spender:account,amount:'9007199254740993'}}};
      db.prepare('INSERT INTO wallet_reviews VALUES(?,?,?)').run(r.reviewId,r.clientRequestId,JSON.stringify(r));
      const filtered=await page(f,'operation='+kind);assert.equal(filtered.reviews.length,1);
      assert.equal(filtered.reviews[0].target,account);assert.equal(filtered.reviews[0].token,recipient);assert.equal(filtered.reviews[0].amount,'9007199254740993');
    }
    base.schemaVersion='wallet-review-v1';delete base.walletSessionId;delete base.walletSessionRevision;save(f,base);
    const native=(await page(f,'operation=native_transfer')).reviews[0];assert.equal(native.amount,'100');assert.equal(native.token,null);
    const serialized=JSON.stringify(await page(f));
    for(const key of ['preparedTransaction','calldata','confirmationNonce','walletSessionId','events','checks','usage','userConfirmationDigest'])assert.ok(!serialized.includes(key),key);
    const old=await actions(f,base.reviewId);assert.equal(old.executionState,'UNAVAILABLE');assert.deepEqual(old.actions,['cancel']);assert.ok(old.reasonCodes.includes('WALLET_REVIEW_UPGRADE_REQUIRED'));
  }finally{await f.close();}
});

test('read-only actions track confirmation and one-use consumption without RPC, model or database writes',async()=>{
  const f=await walletHarness();try{
    const r=await f.create(),path=`/api/wallet/reviews/${r.reviewId}`;
    const rpcBefore=f.rpcState.calls.length,modelBefore=f.reviewerState.requests;
    const db=f.h.app.engine.store.db,changes=db.prepare('SELECT total_changes() AS count').get();
    const waiting=await actions(f,r.reviewId);assert.equal(waiting.executionState,'AWAITING_CONFIRMATION');assert.deepEqual(waiting.actions,['confirm','cancel']);assert.equal(waiting.decisionEffective,false);
    await page(f);assert.equal(f.rpcState.calls.length,rpcBefore);assert.equal(f.reviewerState.requests,modelBefore);assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(),changes);
    assert.equal((await f.api(path+'/consume',{transaction:r.preparedTransaction})).code,409);
    await f.confirm(r);const ready=await actions(f,r.reviewId);assert.equal(ready.executionState,'READY_TO_CONSUME');assert.equal(ready.decisionEffective,true);assert.deepEqual(ready.actions,['consume','cancel']);
    assert.equal((await f.api(path+'/consume',{transaction:r.preparedTransaction})).code,200);
    const consumed=await actions(f,r.reviewId);assert.equal(consumed.executionState,'PERMIT_CONSUMED');assert.equal(consumed.decisionEffective,false);assert.deepEqual(consumed.actions,['report']);
    await f.api(`/api/wallet/sessions/${f.session.sessionId}`,{account,chainId:'0x3c8',providerId:'test-wallet',connected:false,revision:1});
    assert.deepEqual((await actions(f,r.reviewId)).actions,['report']);
    f.rpcState.missingReceipt=true;await f.api(path+'/broadcast',{txHash});assert.deepEqual((await actions(f,r.reviewId)).actions,['recheck_receipt']);
    f.rpcState.missingReceipt=false;await f.api(path+'/receipt/recheck',{});assert.deepEqual((await actions(f,r.reviewId)).actions,[]);
    assert.equal((await f.api(`/api/wallet/reviews/${randomUUID()}/actions`)).code,404);
  }finally{await f.close();}
});

for(const verdict of ['BLOCK','UNCERTAIN'] as const)test(`actions preserve ${verdict} and the separate explicit risk decision`,async()=>{
  const f=await walletHarness();try{
    f.reviewerState.verdict=verdict;const r=await f.create(),path=`/api/wallet/reviews/${r.reviewId}`;
    const before=await actions(f,r.reviewId);assert.equal(before.executionState,'AWAITING_RISK_CONFIRMATION');assert.deepEqual(before.actions,['override','cancel']);
    assert.equal((await f.api(path+'/override',{...confirmation(r),acknowledgement:'CONTINUE_WITH_RISK'})).code,200);
    const after=await actions(f,r.reviewId);assert.equal(after.userDecision,'CONTINUE_WITH_RISK');assert.equal(after.reviewVerdict,verdict);assert.equal(after.decisionEffective,true);assert.deepEqual(after.actions,['consume','cancel']);
    const saved=f.h.app.wallet.get(r.reviewId);save(f,{...saved,userOverride:{...saved.userOverride!,confirmationDigest:'0x'+'0'.repeat(64)}});
    assert.ok((await actions(f,r.reviewId)).reasonCodes.includes('WALLET_RISK_OVERRIDE_CHANGED'));save(f,saved);
    const summary=(await page(f)).reviews[0];assert.equal(summary.userDecision,'CONTINUE_WITH_RISK');assert.equal(summary.reviewVerdict,verdict);
    await f.api(path+'/cancel',{});const cancelled=await actions(f,r.reviewId);assert.equal(cancelled.userDecision,'CONTINUE_WITH_RISK');assert.equal(cancelled.decisionEffective,false);assert.deepEqual(cancelled.actions,[]);
  }finally{await f.close();}
});

test('unfinished review exposes cancellation only and cannot be auto-confirmed by reading actions',async()=>{
  const f=await walletHarness();try{
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    f.rpcState.handler=async m=>{if(m==='eth_chainId'){entered();await gate;}return undefined;};
    const reply=await f.api('/api/wallet/reviews',body());await started;
    const current=await actions(f,reply.data.reviewId);assert.equal(current.executionState,'REVIEWING');assert.deepEqual(current.actions,['cancel']);assert.equal(current.reviewVerdict,null);
    await f.api(`/api/wallet/reviews/${reply.data.reviewId}/cancel`,{});release();
    assert.equal((await actions(f,reply.data.reviewId)).executionState,'CANCELLED');
  }finally{await f.close();}
});

test('actions stop hard failures and missing observations; stale confirmations never enable consumption',async()=>{
  const f=await walletHarness();try{
    const bad=body();bad.intent.recipient=account;
    const hard=await f.create(bad);assert.equal((await actions(f,hard.reviewId)).executionState,'STOPPED');assert.deepEqual((await actions(f,hard.reviewId)).actions,['cancel']);
    f.rpcState.errorMethod='eth_call';const unknown=await f.create();assert.equal((await actions(f,unknown.reviewId)).executionState,'STOPPED');f.rpcState.errorMethod='';
    const r=await f.create();await f.confirm(r);const confirmed=f.h.app.wallet.get(r.reviewId);
    save(f,{...confirmed,expiresAt:Date.now()-1});const expired=await actions(f,r.reviewId);assert.equal(expired.status,'ALLOWED');assert.equal(expired.executionState,'EXPIRED');assert.equal(expired.decisionEffective,false);assert.deepEqual(expired.actions,['cancel']);
    save(f,{...confirmed,userConfirmationDigest:'0x'+'0'.repeat(64)});assert.ok((await actions(f,r.reviewId)).reasonCodes.includes('WALLET_CONFIRMATION_REQUIRED'));
    save(f,confirmed);f.h.config.wallet!.networks[0].maxValueWei='1';assert.ok((await actions(f,r.reviewId)).reasonCodes.includes('VALUE_LIMIT'));f.h.config.wallet!.networks[0].maxValueWei='10000';
    f.h.app.wallet.sessions.update(f.session.sessionId,{account:recipient,chainId:'0x3c8',providerId:'test-wallet',connected:true,revision:1});assert.ok((await actions(f,r.reviewId)).reasonCodes.includes('WALLET_SESSION_CHANGED'));
    await f.h.restart();assert.equal((await actions(f,r.reviewId)).executionState,'INTERRUPTED');assert.deepEqual((await actions(f,r.reviewId)).actions,[]);
  }finally{await f.close();}
});

test('actions suppress in-flight consume/report and permanently rejected report retries',async()=>{
  const f=await walletHarness();try{
    const r=await f.create();await f.confirm(r);
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    f.rpcState.handler=async m=>{if(m==='eth_chainId'){entered();await gate;}return undefined;};
    const pending=f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction});
    await started;const busy=await actions(f,r.reviewId);assert.deepEqual(busy.actions,['cancel']);assert.ok(busy.reasonCodes.includes('WALLET_CONSUME_IN_PROGRESS'));release();assert.equal((await pending).code,200);
    let releaseReport!:()=>void,enteredReport!:()=>void;const reportGate=new Promise<void>(resolve=>releaseReport=resolve),reportStarted=new Promise<void>(resolve=>enteredReport=resolve);
    f.rpcState.handler=async m=>{if(m==='eth_getTransactionByHash'){enteredReport();await reportGate;}return undefined;};
    f.rpcState.txPatch={value:'0x65'};const report=f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});
    await reportStarted;const reporting=await actions(f,r.reviewId);assert.deepEqual(reporting.actions,[]);assert.ok(reporting.reasonCodes.includes('WALLET_REPORT_IN_PROGRESS'));releaseReport();assert.equal((await report).code,409);
    assert.deepEqual((await actions(f,r.reviewId)).actions,[]);
  }finally{await f.close();}
});
