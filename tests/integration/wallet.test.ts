import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardedWallet } from '../../apps/web/src/wallet/provider.js';
import type { WalletReview, WalletTransaction, WalletIntent } from '@verdict/protocol';
const tx:WalletTransaction={chainId:'0x1',from:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222',value:'0x1',data:'0x'};
const intent:WalletIntent={account:tx.from,chainId:tx.chainId,recipient:tx.to,maxValueWei:'1',maxTotalFeeWei:'1000000000000000',operation:'native_transfer'};
const session={account:tx.from,chainId:tx.chainId,providerId:'browser-wallet',sessionId:'00000000-0000-4000-8000-000000000001',revision:1,connected:true,createdAt:1,updatedAt:1,authority:'CLIENT_DECLARED'};
function review(status:WalletReview['status']):WalletReview{return {schemaVersion:'wallet-review-v2',walletSessionId:session.sessionId,walletSessionRevision:1,confirmationNonce:'00000000-0000-4000-8000-000000000002',reviewId:'r1',clientRequestId:'c1',inputDigest:'0x'+'1'.repeat(64),transactionDigest:status==='ALLOWED'?'0x'+'2'.repeat(64):null,transaction:tx,intent,preparedTransaction:status==='ALLOWED'?{...tx,nonce:'0x1',gas:'0x5208',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1'}:null,status,reason:status,createdAt:Date.now(),expiresAt:status==='ALLOWED'?Date.now()+60000:null,checks:[],events:[],reviewer:{modelId:'reviewer',source:'TEST_TRANSPORT',verdict:status==='ALLOWED'?'ALLOW':null},usage:{requests:1,inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,costUsd:null},broadcastStatus:'NOT_BROADCAST_BY_SERVER'};}
function fixture(){
 const state={chain:'0x1',sends:0,confirms:0,consumes:0,confirmed:false,loseConfirmation:false,status:'ALLOWED' as WalletReview['status'],version:'wallet-review-v2' as WalletReview['schemaVersion'],calls:[] as string[]};
 const provider={request:async({method}:{method:string;params?:unknown[]})=>{if(method==='eth_requestAccounts'||method==='eth_accounts')return [tx.from];if(method==='eth_chainId')return state.chain;if(method==='eth_sendTransaction'){state.sends++;return '0x'+'a'.repeat(64);}throw Error(method);}};
 const api=async(path:string,body?:unknown)=>{
  state.calls.push(path);
  if(path==='/api/wallet/sessions')return session;
  if(path.startsWith('/api/wallet/sessions/'))return {...session,connected:false,revision:2};
  if(path==='/api/wallet/reviews'){assert.equal((body as any).schemaVersion,'wallet-review-v2');assert.equal((body as any).walletSessionId,session.sessionId);return {...review('QUEUED'),schemaVersion:state.version};}
  if(path==='/api/wallet/reviews/r1')return {...review(state.status),...(state.confirmed?{userConfirmedAt:Date.now(),userConfirmationDigest:'0x'+'3'.repeat(64)}:{})};
  if(path.endsWith('/confirm')){state.confirms++;assert.equal((body as any).handwritingAcknowledged,true);assert.equal((body as any).walletSessionRevision,1);state.confirmed=true;if(state.loseConfirmation)throw Error('LOST_RESPONSE');return {reviewId:'r1',transactionDigest:review('ALLOWED').transactionDigest,confirmedAt:Date.now(),authority:'CLIENT_DECLARED'};}
  if(path.endsWith('/consume')){assert.equal(state.confirmed,true);state.consumes++;return {reviewId:'r1',transactionDigest:review('ALLOWED').transactionDigest,transaction:(body as any).transaction};}
  if(path.endsWith('/cancel'))return review('CANCELLED');throw Error(path);
 };
 return {state,provider,wallet:new GuardedWallet(api)};
}
test('v2 adapter requires explicit handwriting, confirms before consuming, then requests wallet once',async()=>{
 const f=fixture();await f.wallet.connect(f.provider);await f.wallet.review(tx,intent);const r=await f.wallet.poll();await assert.rejects(f.wallet.send(r),/HANDWRITING_REQUIRED/);assert.equal(f.state.confirms,0);assert.equal(f.state.sends,0);
 const hash=await f.wallet.send(r,true);assert.equal(hash,'0x'+'a'.repeat(64));assert.equal(f.state.confirms,1);assert.equal(f.state.consumes,1);assert.equal(f.state.sends,1);assert.ok(f.state.calls.indexOf('/api/wallet/reviews/r1/confirm')<f.state.calls.indexOf('/api/wallet/reviews/r1/consume'));
});
test('provider chain changing during review invalidates the backend session without signing',async()=>{
 const f=fixture();await f.wallet.connect(f.provider);const promise=f.wallet.review(tx,intent);f.state.chain='0x2';await assert.rejects(promise,/WALLET_CHANGED/);assert.equal(f.state.sends,0);assert.equal(f.state.consumes,0);assert.ok(f.state.calls.some(x=>x.startsWith('/api/wallet/sessions/')));
});
test('blocked review never confirms or reaches wallet',async()=>{
 const f=fixture();f.state.status='BLOCKED';await f.wallet.connect(f.provider);await f.wallet.review(tx,intent);const r=await f.wallet.poll();await assert.rejects(f.wallet.send(r,true),/REVIEW_REQUIRED/);assert.equal(f.state.confirms,0);assert.equal(f.state.sends,0);
});
test('lost confirmation response reads the same review instead of re-confirming',async()=>{
 const f=fixture();f.state.loseConfirmation=true;await f.wallet.connect(f.provider);await f.wallet.review(tx,intent);const r=await f.wallet.poll();await f.wallet.send(r,true);assert.equal(f.state.confirms,1);assert.equal(f.state.consumes,1);assert.equal(f.state.sends,1);
});
test('v1 reviews cannot downgrade the v2 confirmation boundary',async()=>{
 const f=fixture();f.state.version='wallet-review-v1';await f.wallet.connect(f.provider);await assert.rejects(f.wallet.review(tx,intent),/SESSION_CHANGED/);assert.equal(f.state.sends,0);
});
