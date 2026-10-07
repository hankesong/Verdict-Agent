import {z} from 'zod';
import {PaymentProposalSchema,WalletReviewSchema,ExecutionGrantSchema,WalletLinkIdSchema,WalletHashSchema,PreparedWalletTransactionSchema,type ExecutionGrant} from '@verdict/protocol';

export class DefenseClient {
  constructor(private base:string,private token:string){
    const u=new URL(base);
    if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname))))throw Error('DEFENSE_ENDPOINT_INVALID');
  }
  async request(path:string,body?:unknown):Promise<unknown>{
    if(!/^\/[a-zA-Z0-9_/?=&.-]+$/.test(path))throw Error('DEFENSE_PATH_INVALID');
    const response=await fetch(new URL('/api/defense'+path,this.base),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(120000)});
    const result=await response.json();if(!response.ok)throw Error('DEFENSE_REQUEST_FAILED_'+response.status);return result;
  }
}
export interface DefenseExecutionAdapter {
  // This must atomically reserve the ID in durable adapter storage before sending any transaction.
  claimOnce(grantId:string):Promise<boolean>;
  currentAccount():Promise<{account:string;chainId:string}>;
  execute(transaction:z.infer<typeof PreparedWalletTransactionSchema>,context:{idempotencyKey:string;expiresAt:number}):Promise<string>;
  recordResult(grantId:string,result:{status:'SUBMITTED';txHash:string}|{status:'UNKNOWN'}):Promise<void>;
}
// Use only a fresh successful consume response. A historical grant is never an instruction to resend.
export async function executeDefendedPayment(client:DefenseClient,proposalId:string,adapter:DefenseExecutionAdapter){
  WalletLinkIdSchema.parse(proposalId);
  const view=z.object({proposal:PaymentProposalSchema,review:WalletReviewSchema.nullable()}).parse(await client.request('/proposals/'+proposalId));
  if(!view.review?.preparedTransaction||view.proposal.status!=='REVIEW_CREATED')throw Error('DEFENSE_PROPOSAL_NOT_READY');
  const transaction=view.review.preparedTransaction;
  const match=async()=>{const current=await adapter.currentAccount();if(current.account.toLowerCase()!==transaction.from||current.chainId!==transaction.chainId)throw Error('DEFENSE_ADAPTER_SESSION_CHANGED');};
  await match();
  const grant:ExecutionGrant=ExecutionGrantSchema.parse(await client.request(`/proposals/${proposalId}/consume`,{transaction}));
  if(grant.proposalId!==proposalId||grant.reviewId!==view.review.reviewId||JSON.stringify(grant.transaction)!==JSON.stringify(transaction))throw Error('DEFENSE_GRANT_MISMATCH');
  if(!await adapter.claimOnce(grant.grantId))throw Error('DEFENSE_ADAPTER_ALREADY_CLAIMED');
  let txHash:string;
  try{await match();if(Date.now()>=grant.expiresAt)throw Error('DEFENSE_GRANT_EXPIRED');txHash=WalletHashSchema.parse((await adapter.execute(grant.transaction,{idempotencyKey:grant.grantId,expiresAt:grant.expiresAt})).toLowerCase());}
  catch(e){await adapter.recordResult(grant.grantId,{status:'UNKNOWN'});throw e;}
  await adapter.recordResult(grant.grantId,{status:'SUBMITTED',txHash});
  // Reporting may safely retry using the saved hash. Execution must not be repeated on HTTP failure.
  await client.request(`/proposals/${proposalId}/broadcast`,{txHash});return {grant,txHash};
}
