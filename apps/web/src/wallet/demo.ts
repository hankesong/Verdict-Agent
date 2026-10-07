import { AgentGraphEventSchema, CreateWalletReviewSchema, WalletReviewSchema, WalletSessionSchema, WalletGraphPageSchema, canonical_json, type AgentGraphEvent, type WalletReview, type WalletSession } from '@verdict/protocol';
import type { WalletProvider, WalletAPI } from './provider';

export const demoAccount='0x1111111111111111111111111111111111111111';
export const demoRecipient='0x2222222222222222222222222222222222222222';
const hash=(digit:string)=>'0x'+digit.repeat(64);
const txHash=hash('a');
const stages:Array<[NonNullable<AgentGraphEvent['stage']>,NonNullable<AgentGraphEvent['eventType']>,AgentGraphEvent['status'],NonNullable<AgentGraphEvent['source']>]>=[
  ['TRANSACTION_INTENT','wallet.review.created','LOCKED','USER'],
  ['BALANCE_OBSERVATION','wallet.balance.observed','OBSERVED','RPC'],
  ['NONCE_OBSERVATION','wallet.balance.observed','OBSERVED','RPC'],
  ['HARD_RULE','wallet.policy.checked','PASSED','DETERMINISTIC'],
  ['RPC_PREFLIGHT','wallet.preflight.completed','PASSED','RPC'],
  ['PI_REVIEW','wallet.guard.reviewed','ALLOW','PI'],
  ['PERMIT','wallet.guard.reviewed','WAITING_SIGNATURE','DETERMINISTIC'],
];
type RecordEntry={review:WalletReview;events:AgentGraphEvent[];sent:boolean;broadcastAt?:number};

// In-memory UI_MOCK fixtures. This adapter has no network, storage or injected-wallet access.
export function createExperience(){
  const reviews=new Map<string,RecordEntry>(),sessions=new Map<string,WalletSession>();
  let pending:RecordEntry|null=null;
  function append(record:RecordEntry,step:typeof stages[number]){
    const [stage,eventType,status,source]=step,r=record.review,sequence=record.events.length+1;
    const phase=stage==='TRANSACTION_INTENT'?'PROPOSAL':stage==='HARD_RULE'||stage==='PI_REVIEW'?'REVIEW':stage==='RECEIPT'||stage==='POST_STATE'?'VERIFICATION':stage==='PERMIT'||stage==='EVIDENCE'?'OUTCOME':'EXECUTION';
    record.events.push(AgentGraphEventSchema.parse({graphVersion:'1.0.0',eventId:crypto.randomUUID(),sequence,at:new Date().toISOString(),agentId:`wallet:${r.reviewId}`,runId:r.graphRunId,actionId:`ui-mock-${sequence}`,actionOrder:sequence,previousActionId:record.events.at(-1)?.actionId??null,toolCallId:null,tool:null,phase,status,modelSource:'TEST_TRANSPORT',traceId:r.traceId,walletReviewId:r.reviewId,graphRunId:r.graphRunId,parentEventId:record.events.at(-1)?.eventId??null,eventType,stage,source,chainId:r.transaction.chainId,...(source==='RPC'?{blockNumber:'0x10',blockHash:hash('b'),resultDigest:hash('c')}:{} )}));
  }
  function update(record:RecordEntry){
    const r=record.review;
    if(r.status==='REVIEWING'){
      const count=Math.min(stages.length,1+Math.floor((Date.now()-r.createdAt)/700));
      while(record.events.length<count)append(record,stages[record.events.length]);
      if(count===stages.length){r.status='ALLOWED';r.reason='PI_ALLOW';r.expiresAt=Date.now()+300000;r.reviewer.verdict='ALLOW';r.checks=[{id:'ui-mock-policy',status:'PASS',reason:'EXPLICIT_SCOPE_MATCH',source:'HARD_RULE',facts:{source:'UI_MOCK'}},{id:'ui-mock-preflight',status:'PASS',reason:'NATIVE_TRANSFER_PREFLIGHT',source:'RPC_OBSERVATION',facts:{source:'UI_MOCK'}}];}
    }
    if(record.broadcastAt){
      const steps:typeof stages=[['BROADCAST','wallet.broadcast.reported','PENDING','WALLET'],['BROADCAST','wallet.broadcast.reported','BROADCAST','RPC'],['RECEIPT','wallet.receipt.observed','RECEIPT_CONFIRMED','RPC'],['POST_STATE','wallet.post_state.checked','POST_STATE_RECHECKED','RPC'],['EVIDENCE','wallet.evidence.saved','SAVED','DETERMINISTIC']];
      const count=Math.min(steps.length,1+Math.floor((Date.now()-record.broadcastAt)/700));
      while(record.events.length<8+count)append(record,steps[record.events.length-8]);
      if(count===steps.length)r.receiptReport={txHash,transactionFound:true,receiptStatus:'SUCCESS',blockNumber:'0x11',blockHash:hash('b'),gasUsed:'0x5208',error:null,postStateStatus:'POST_STATE_RECHECKED'};
    }
    return record;
  }
  const provider:WalletProvider={async request({method,params}){
    if(method==='eth_requestAccounts'||method==='eth_accounts')return [demoAccount];
    if(method==='eth_chainId')return '0x3c8';
    if(method==='eth_getBalance')return '0xde0b6b3a7640000';
    if(method==='eth_sendTransaction'){
      if(!pending||pending.review.status!=='CONSUMED'||pending.sent||canonical_json(params?.[0])!==canonical_json(pending.review.preparedTransaction))throw Error('UI_MOCK_CONFIRMATION_REQUIRED');
      pending.sent=true;return txHash;
    }
    throw Error('UI_MOCK_METHOD_UNAVAILABLE');
  }};
  const api:WalletAPI=async(path,body)=>{
    const url=new URL(path,'http://ui-mock.invalid'),route=url.pathname;
    if(route==='/api/wallet/meta')return {configured:true,reason:'UI_MOCK',reviewSchemaVersion:'wallet-review-v2',confirmationRequired:true,supportedOperations:['native_transfer'],networks:[{chainId:'0x3c8',name:'模拟网络',nativeSymbol:'tBOT',maxValueWei:'1000000000000000000',maxTotalFeeWei:'1000000000000000',ready:true}]};
    if(route==='/api/wallet/sessions'&&body){
      const session=WalletSessionSchema.parse({...body as object,sessionId:crypto.randomUUID(),revision:1,connected:true,createdAt:Date.now(),updatedAt:Date.now(),authority:'CLIENT_DECLARED'});sessions.set(session.sessionId,session);return structuredClone(session);
    }
    const sessionRoute=route.match(/^\/api\/wallet\/sessions\/([^/]+)$/);
    if(sessionRoute&&body){const old=sessions.get(sessionRoute[1]);if(!old)throw Error('UI_MOCK_SESSION_NOT_FOUND');const session=WalletSessionSchema.parse({...old,...body as object,revision:old.revision+1,updatedAt:Date.now()});sessions.set(session.sessionId,session);return structuredClone(session);}
    if(route==='/api/wallet/reviews'&&body){
      const input=CreateWalletReviewSchema.parse(body),session=sessions.get(input.walletSessionId);
      if(!session?.connected||session.revision!==input.walletSessionRevision)throw Error('UI_MOCK_SESSION_NOT_FOUND');
      const review=WalletReviewSchema.parse({...input,reviewId:crypto.randomUUID(),traceId:crypto.randomUUID(),graphRunId:crypto.randomUUID(),inputDigest:hash('1'),transactionDigest:hash('2'),preparedTransaction:{...input.transaction,nonce:'0x1',gas:'0x5208',maxFeePerGas:'0x3',maxPriorityFeePerGas:'0x1'},status:'REVIEWING',reason:'REVIEW_STARTED',createdAt:Date.now(),expiresAt:null,checks:[],events:[],reviewer:{modelId:'UI_MOCK',source:'TEST_TRANSPORT',verdict:null},usage:{requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:null},broadcastStatus:'NOT_BROADCAST_BY_SERVER',confirmationNonce:crypto.randomUUID()});
      const record={review,events:[],sent:false};reviews.set(review.reviewId,record);update(record);return structuredClone(review);
    }
    const match=route.match(/^\/api\/wallet\/reviews\/([^/]+)(?:\/(graph|cancel|confirm|consume|broadcast))?$/);
    const record=match?reviews.get(match[1]):undefined;if(!record||!match)throw Error('UI_MOCK_RECORD_NOT_FOUND');
    update(record);const r=record.review;
    if(match[2]==='graph'){
      const after=Number(url.searchParams.get('after')??0),events=record.events.filter(event=>event.sequence>after);
      return WalletGraphPageSchema.parse({graphVersion:'1.0.0',agentId:`wallet:${r.reviewId}`,available:true,events,nextCursor:events.at(-1)?.sequence??after,hasMore:false,walletReviewId:r.reviewId,traceId:r.traceId,graphRunId:r.graphRunId,parentAgentId:null,status:r.status,receiptStatus:r.receiptReport?.receiptStatus??'NOT_REPORTED',task:{status:r.receiptReport?'COMPLETED':'RUNNING',modelSource:'TEST_TRANSPORT',runId:r.graphRunId,error:null,finishedAt:r.receiptReport?new Date().toISOString():null,adoptedEvidenceId:null}});
    }
    if(match[2]==='cancel'&&body){r.status='CANCELLED';r.reason='USER_CANCELLED';append(record,['TRANSACTION_INTENT','wallet.review.stopped','CANCELLED','USER']);}
    if(match[2]==='confirm'&&body){
      const confirmation=body as Record<string,unknown>;
      if(r.status!=='ALLOWED'||r.userConfirmedAt||confirmation.handwritingAcknowledged!==true||confirmation.confirmationNonce!==r.confirmationNonce||confirmation.transactionDigest!==r.transactionDigest)throw Error('UI_MOCK_CONFIRMATION_REQUIRED');
      r.userConfirmedAt=Date.now();r.userConfirmationDigest=hash('3');return {reviewId:r.reviewId,transactionDigest:r.transactionDigest,confirmedAt:r.userConfirmedAt,authority:'CLIENT_DECLARED'};
    }
    if(match[2]==='consume'&&body){
      if(r.status!=='ALLOWED'||!r.userConfirmedAt||canonical_json((body as {transaction:unknown}).transaction)!==canonical_json(r.preparedTransaction))throw Error('UI_MOCK_CONFIRMATION_REQUIRED');
      r.status='CONSUMED';r.reason='PERMIT_CONSUMED_ONCE';append(record,['PERMIT','wallet.permit.consumed','CONSUMED','DETERMINISTIC']);pending=record;return {reviewId:r.reviewId,transactionDigest:r.transactionDigest,transaction:structuredClone(r.preparedTransaction)};
    }
    if(match[2]==='broadcast'&&body){if(!record.sent)throw Error('UI_MOCK_CONFIRMATION_REQUIRED');record.broadcastAt??=Date.now();update(record);}
    return structuredClone(r);
  };
  return {provider,api};
}
