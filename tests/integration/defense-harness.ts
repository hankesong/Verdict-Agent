import {randomUUID} from 'node:crypto';
import {ServerConfigSchema} from '../../apps/server/src/config.js';
import {walletHarness,account,recipient} from './wallet-graph-harness.js';
import type {CreatePaymentTaskSchema,CreatePaymentProposalSchema,CreatePaymentAuthorizationSchema,WalletReview} from '@verdict/protocol';
import type {z} from 'zod';

export async function defenseHarness(){
  const f=await walletHarness(),prefix='DEFENSE_TEST_'+randomUUID().replaceAll('-','').toUpperCase();
  const identities=[['owner','OWNER','one'],['agent','AGENT','one'],['executor','EXECUTOR','one'],['outsider','OWNER','two']] as const;
  const tokens:Record<string,string>={};
  for(const [id] of identities){tokens[id]=randomUUID()+randomUUID();process.env[prefix+'_'+id.toUpperCase()]=tokens[id];}
  f.h.config.defense=ServerConfigSchema.shape.defense.parse({principals:identities.map(([id,role,tenantId])=>({id,role,tenantId,accounts:role==='OWNER'?[account]:[],tokenEnv:prefix+'_'+id.toUpperCase()}))});
  await f.h.restart();
  const api=async(role:string,path:string,body?:unknown)=>{
    const r=await fetch(f.h.base+'/api/defense'+path,{headers:{authorization:'Bearer '+(tokens[role]??'invalid'),'content-type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    return {code:r.status,data:await r.json() as any};
  };
  const session=(await api('owner','/sessions',{account,chainId:'0x3c8',providerId:'test-wallet'})).data;
  const authorizationInput=():z.infer<typeof CreatePaymentAuthorizationSchema>=>({clientRequestId:randomUUID(),label:'Supplier',confirmed:true,policy:{account,chainId:'0x3c8',operation:'native_transfer',token:null,recipient,maxAmountPerTransaction:'100',maxTotalAmount:'300',maxFeePerTransaction:'1000000',maxTotalFee:'3000000',maxTransactions:3,validFrom:Date.now()-1000,expiresAt:Date.now()+600000}});
  const createAuthorization=async(input=authorizationInput())=>{const r=await api('owner','/authorizations',input);if(r.code!==201)throw Error(JSON.stringify(r));return r.data;};
  const taskInput=(a:any):z.infer<typeof CreatePaymentTaskSchema>=>({clientRequestId:randomUUID(),authorizationId:a.authorizationId,authorizationVersion:a.version,authorizationDigest:a.digest,agentId:'agent',executorId:'executor',walletSessionId:session.sessionId,walletSessionRevision:session.revision,maxTotalAmount:'300',maxTotalFee:'3000000',maxTransactions:3,expiresAt:Date.now()+300000,payments:[1,2,3].map(n=>({paymentRef:'payment-'+n,invoiceDigest:'0x'+String(n).repeat(64),materialDigests:['0x'+'a'.repeat(64)],maxAmount:'100'}))});
  const createTask=async(a:any,input=taskInput(a))=>{const r=await api('owner','/tasks',input);if(r.code!==201)throw Error(JSON.stringify(r));return r.data;};
  const proposalInput=(t:any,index=0):z.infer<typeof CreatePaymentProposalSchema>=>({clientRequestId:randomUUID(),taskId:t.taskId,paymentRef:t.payments[index].paymentRef,invoiceDigest:t.payments[index].invoiceDigest,materialDigests:t.payments[index].materialDigests,transaction:{chainId:'0x3c8',from:account,to:recipient,value:'0x50',data:'0x'},explanation:'untrusted external bill says pay this amount'});
  const propose=async(t:any,input=proposalInput(t))=>{const r=await api('agent','/proposals',input);if(r.code!==202)throw Error(JSON.stringify(r));if(r.data.reviewId)await f.settle(r.data.reviewId);return r.data;};
  const confirmation=(r:WalletReview)=>({transactionDigest:r.transactionDigest,account:r.transaction.from,chainId:r.transaction.chainId,confirmationNonce:r.confirmationNonce,walletSessionId:r.walletSessionId,walletSessionRevision:r.walletSessionRevision,handwritingAcknowledged:true});
  return {...f,api,tokens,session,authorizationInput,createAuthorization,taskInput,createTask,proposalInput,propose,confirmation,close:async()=>{await f.close();for(const [id] of identities)delete process.env[prefix+'_'+id.toUpperCase()];}};
}
