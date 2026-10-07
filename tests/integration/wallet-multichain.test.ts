import {test} from 'node:test';
import assert from 'node:assert/strict';
import {walletHarness,body,account,txHash,postHash} from './wallet-graph-harness.js';

test('opted-in EVM network emits v3 evidence, replays with local policy and separately checks confirmations/reorg',async()=>{
  const f=await walletHarness(),g=await walletHarness();try{
    for(const fixture of [f,g]){
      fixture.h.config.wallet!.networks[0].chainId='0x539';fixture.h.config.wallet!.networks[0].nativeSymbol='TEST';fixture.h.config.wallet!.networks[0].receiptEnabled=true;fixture.h.config.wallet!.networks[0].requiredConfirmations=3;
      fixture.rpcState.chain='0x539';fixture.rpcState.txPatch={chainId:'0x539'};
    }
    const session=f.h.app.wallet.sessions.create({account,chainId:'0x539',providerId:'test-wallet'});
    const input=body();input.transaction.chainId='0x539';input.intent.chainId='0x539';
    const start=await f.rawApi('/api/wallet/reviews',{...input,walletSessionId:session.sessionId,walletSessionRevision:session.revision});assert.equal(start.code,202);
    const r=await f.settle(start.data.reviewId);await f.confirm(r);assert.equal((await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction})).code,200);
    const report=await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});assert.equal(report.code,200);assert.ok(report.data.evidenceRef,JSON.stringify(report.data));
    const packet=(await f.api('/api/wallet/evidence/'+report.data.evidenceRef)).data;assert.equal(packet.body.version,'wallet-observation-v3');assert.equal(packet.body.chainId,'0x539');
    assert.equal((await g.api('/api/wallet/evidence/replay',{packet})).data.status,'MATCH');
    g.h.config.wallet!.networks[0].nativeSymbol='WRONG';assert.equal((await g.api('/api/wallet/evidence/replay',{packet})).data.status,'MISMATCH');
    let head='0x12',reorg=false;
    f.rpcState.handler=async(method,params)=>method==='eth_getBlockByNumber'&&params[0]==='latest'?{number:head,hash:postHash,baseFeePerGas:'0x1'}:method==='eth_getBlockByNumber'&&params[0]==='0x11'&&reorg?{number:'0x11',hash:'0x'+'d'.repeat(64),baseFeePerGas:'0x1'}:undefined;
    const path=`/api/wallet/reviews/${r.reviewId}/receipt/finality`;
    assert.equal((await f.api(path,{})).data.status,'PENDING');head='0x13';const confirmed=await f.api(path,{});assert.equal(confirmed.data.status,'CONFIRMATIONS_MET');assert.equal(confirmed.data.confirmations,'3');
    reorg=true;assert.equal((await f.api(path,{})).data.status,'REORG_DETECTED');
    reorg=false;f.rpcState.chain='0x1';assert.equal((await f.api(path,{})).data.status,'UNKNOWN');f.rpcState.chain='0x539';
    f.rpcState.receiptPatch={status:'0x0'};assert.equal((await f.api(path,{})).data.reason,'RECEIPT_OBSERVATION_CHANGED');
    assert.equal(f.h.app.wallet.get(r.reviewId).evidenceRef,report.data.evidenceRef,'finality observation must not rewrite historical evidence');
  }finally{await f.close();await g.close();}
});
