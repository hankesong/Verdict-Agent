import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {decodeFunctionData,encodeFunctionData,erc20Abi} from 'viem';
import {digest} from '@verdict/core';
import {CreatePaymentAuthorizationSchema,RevisePaymentAuthorizationSchema,DefenseRevokeAuthorizationSchema,PaymentAuthorizationSchema,CreatePaymentTaskSchema,PaymentTaskSchema,CreatePaymentProposalSchema,PaymentProposalSchema,ExecutionGrantSchema,ConsumeWalletReviewSchema,ConnectWalletSessionSchema,UpdateWalletSessionSchema,type PaymentAuthorization,type PaymentPolicy,type PaymentTask,type PaymentProposal,type PaymentDifference,type ExecutionGrant,type WalletReview,type WalletIntent} from '@verdict/protocol';
import {ApiError,Store} from './store.js';
import {requireRole,type DefensePrincipal} from './defense-auth.js';
import type {ServerConfig} from './config.js';
import type {WalletReviews} from './wallet.js';
import type {WalletReceiptWatches} from './wallet-receipt-watch.js';

type Reservation={proposal_id:string;authorization_id:string;task_id:string;amount:string;fee:string;state:'RESERVED'|'SPENT'|'RELEASED'};
const key=(p:DefensePrincipal,id:string)=>`${p.tenantId}:${p.id}:${id}`;
const sameSet=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(v=>b.includes(v));
const difference=(field:string,code:string,expected:string,actual:string):PaymentDifference=>({field,code,expected,actual});

// Owner authority, agent proposals and executor consumption are deliberately separate roles.
export class PaymentDefense {
  constructor(private store:Store,private config:ServerConfig,private wallet:WalletReviews,private watches:WalletReceiptWatches){
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_authorizations(id TEXT NOT NULL,version INTEGER NOT NULL,request_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS payment_tasks(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_proposals(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,review_id TEXT UNIQUE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS defense_sessions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_reservations(proposal_id TEXT PRIMARY KEY,authorization_id TEXT NOT NULL,task_id TEXT NOT NULL,tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,payment_ref TEXT NOT NULL,invoice_digest TEXT NOT NULL,amount TEXT NOT NULL,fee TEXT NOT NULL,state TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS payment_invoice_once ON payment_reservations(tenant_id,owner_id,invoice_digest) WHERE state!='RELEASED';
      CREATE UNIQUE INDEX IF NOT EXISTS payment_line_once ON payment_reservations(task_id,payment_ref) WHERE state!='RELEASED';
      CREATE INDEX IF NOT EXISTS payment_budget ON payment_reservations(authorization_id,state);
      CREATE TABLE IF NOT EXISTS execution_grants(id TEXT PRIMARY KEY,review_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS defense_nonces(chain_id TEXT NOT NULL,account TEXT NOT NULL,nonce TEXT NOT NULL,proposal_id TEXT NOT NULL,PRIMARY KEY(chain_id,account,nonce));
      CREATE TABLE IF NOT EXISTS defense_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,resource_id TEXT NOT NULL,body TEXT NOT NULL);
    `);
    wallet.setDefenseBoundary({assert:r=>this.assertReview(r),consume:r=>this.commitConsumption(r)});
  }
  private audit(tenantId:string,resourceId:string,actor:string,kind:string,detail:unknown){
    this.store.db.prepare('INSERT INTO defense_audit(tenant_id,resource_id,body) VALUES(?,?,?)').run(tenantId,resourceId,JSON.stringify({at:Date.now(),actor,kind,detail}));
  }
  private principal(id:string,role:DefensePrincipal['role'],tenantId:string){
    const p=this.config.defense?.principals.find(p=>p.id===id&&!p.disabled&&p.role===role&&p.tenantId===tenantId);
    if(!p)throw new ApiError(403,'DEFENSE_PRINCIPAL_UNAVAILABLE');return p;
  }
  private assertAccount(p:DefensePrincipal,account:string){if(!p.accounts.includes(account))throw new ApiError(403,'DEFENSE_ACCOUNT_FORBIDDEN');}
  private row(table:string,id:string){
    const row=this.store.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id) as {body:string}|undefined;
    if(!row)throw new ApiError(404,'DEFENSE_RESOURCE_NOT_FOUND');return JSON.parse(row.body);
  }
  private readAuth(id:string,version?:number){
    const row=(version===undefined?this.store.db.prepare('SELECT body FROM payment_authorizations WHERE id=? ORDER BY version DESC LIMIT 1').get(id):this.store.db.prepare('SELECT body FROM payment_authorizations WHERE id=? AND version=?').get(id,version)) as {body:string}|undefined;
    if(!row)throw new ApiError(404,'DEFENSE_RESOURCE_NOT_FOUND');return PaymentAuthorizationSchema.parse(JSON.parse(row.body));
  }
  private readTask(id:string){return PaymentTaskSchema.parse(this.row('payment_tasks',id));}
  private readProposal(id:string){return PaymentProposalSchema.parse(this.row('payment_proposals',id));}
  private authDigest(a:Pick<PaymentAuthorization,'authorizationId'|'version'|'tenantId'|'ownerId'|'label'|'policy'>){
    return digest({authorizationId:a.authorizationId,version:a.version,tenantId:a.tenantId,ownerId:a.ownerId,label:a.label,policy:a.policy});
  }
  private checkPolicy(policy:PaymentPolicy){
    const n=this.config.wallet?.networks.find(n=>n.chainId===policy.chainId);
    if(!n)throw new ApiError(400,'DEFENSE_NETWORK_UNAVAILABLE');
    if(policy.expiresAt<=Date.now()||BigInt(policy.maxFeePerTransaction)>BigInt(n.maxTotalFeeWei))throw new ApiError(400,'DEFENSE_POLICY_LIMIT');
    if(policy.operation==='native_transfer'){
      if(BigInt(policy.maxAmountPerTransaction)>BigInt(n.maxValueWei))throw new ApiError(400,'DEFENSE_POLICY_LIMIT');
    }else{
      const token=n.tokens.find(t=>t.address===policy.token);
      if(!this.config.wallet?.contractCalls.enabled||!token)throw new ApiError(400,'DEFENSE_TOKEN_UNAVAILABLE');
      if(BigInt(policy.maxAmountPerTransaction)>BigInt(policy.operation==='erc20_transfer'?token.maxTransferAmount:token.maxApprovalAmount))throw new ApiError(400,'DEFENSE_POLICY_LIMIT');
      if(policy.operation==='erc20_approve'&&!token.approvedSpenders.includes(policy.recipient))throw new ApiError(400,'DEFENSE_SPENDER_UNAVAILABLE');
    }
    if(policy.recipient==='0x'+'0'.repeat(40))throw new ApiError(400,'DEFENSE_ZERO_RECIPIENT');
  }
  createSession(p:DefensePrincipal,raw:unknown){
    requireRole(p,'OWNER');const input=ConnectWalletSessionSchema.parse(raw);this.assertAccount(p,input.account);
    return this.store.transaction(()=>{const s=this.wallet.sessions.create(input);this.store.db.prepare('INSERT INTO defense_sessions VALUES(?,?,?)').run(s.sessionId,p.tenantId,p.id);return s;});
  }
  private ownSession(p:DefensePrincipal,id:string){
    const row=this.store.db.prepare('SELECT tenant_id,owner_id FROM defense_sessions WHERE id=?').get(id) as {tenant_id:string;owner_id:string}|undefined;
    if(!row||row.tenant_id!==p.tenantId||row.owner_id!==p.id)throw new ApiError(404,'DEFENSE_RESOURCE_NOT_FOUND');
  }
  updateSession(p:DefensePrincipal,id:string,raw:unknown){requireRole(p,'OWNER');this.ownSession(p,id);const input=UpdateWalletSessionSchema.parse(raw);this.assertAccount(p,input.account);return this.wallet.updateSession(id,input);}
  createAuthorization(p:DefensePrincipal,raw:unknown){
    requireRole(p,'OWNER');const input=CreatePaymentAuthorizationSchema.parse(raw);this.assertAccount(p,input.policy.account);
    const old=this.store.db.prepare('SELECT body FROM payment_authorizations WHERE request_key=?').get(key(p,input.clientRequestId)) as {body:string}|undefined;
    if(old){const a=PaymentAuthorizationSchema.parse(JSON.parse(old.body));if(a.digest!==this.authDigest({...a,label:input.label,policy:input.policy}))throw new ApiError(409,'DEFENSE_REQUEST_CONFLICT');return a;}
    this.checkPolicy(input.policy);
    const fields={authorizationId:randomUUID(),version:1,tenantId:p.tenantId,ownerId:p.id,label:input.label,policy:input.policy};
    const a:PaymentAuthorization={...fields,schemaVersion:'payment-authorization-v1',digest:this.authDigest(fields),createdAt:Date.now(),status:'ACTIVE'};
    return this.store.transaction(()=>{this.store.db.prepare('INSERT INTO payment_authorizations VALUES(?,?,?,?)').run(a.authorizationId,a.version,key(p,input.clientRequestId),JSON.stringify(a));this.audit(p.tenantId,a.authorizationId,p.id,'AUTHORIZATION_CONFIRMED',{version:a.version,digest:a.digest});return a;});
  }
  getAuthorization(p:DefensePrincipal,id:string,version?:number){requireRole(p,'OWNER');const a=this.readAuth(id,version);if(a.tenantId!==p.tenantId||a.ownerId!==p.id)throw new ApiError(404,'DEFENSE_RESOURCE_NOT_FOUND');return a;}
  reviseAuthorization(p:DefensePrincipal,id:string,raw:unknown){
    requireRole(p,'OWNER');const input=RevisePaymentAuthorizationSchema.parse(raw);this.assertAccount(p,input.policy.account);this.checkPolicy(input.policy);
    return this.store.transaction(()=>{const old=this.getAuthorization(p,id);if(old.version!==input.expectedVersion||old.status!=='ACTIVE')throw new ApiError(409,'DEFENSE_AUTHORIZATION_STALE');
      // Budget units cannot silently change across revisions of a shared lifetime ledger.
      if(old.policy.chainId!==input.policy.chainId||old.policy.account!==input.policy.account||old.policy.token!==input.policy.token||old.policy.operation!==input.policy.operation)throw new ApiError(409,'DEFENSE_NEW_AUTHORIZATION_REQUIRED');
      const next:PaymentAuthorization={...old,version:old.version+1,label:input.label,policy:input.policy,createdAt:Date.now(),digest:this.authDigest({...old,version:old.version+1,label:input.label,policy:input.policy})};
      this.store.db.prepare('UPDATE payment_authorizations SET body=? WHERE id=? AND version=?').run(JSON.stringify({...old,status:'SUPERSEDED'}),id,old.version);
      this.invalidateAuthorization(id,old.version);
      this.store.db.prepare('INSERT INTO payment_authorizations VALUES(?,?,?,?)').run(id,next.version,`revision:${id}:${next.version}`,JSON.stringify(next));this.audit(p.tenantId,id,p.id,'AUTHORIZATION_REVISED',{version:next.version,digest:next.digest});return next;});
  }
  revokeAuthorization(p:DefensePrincipal,id:string,raw:unknown){
    const {expectedVersion}=DefenseRevokeAuthorizationSchema.parse(raw);
    return this.store.transaction(()=>{const old=this.getAuthorization(p,id);if(old.version!==expectedVersion)throw new ApiError(409,'DEFENSE_AUTHORIZATION_STALE');if(old.status==='REVOKED')return old;
      const a={...old,status:'REVOKED' as const};this.store.db.prepare('UPDATE payment_authorizations SET body=? WHERE id=? AND version=?').run(JSON.stringify(a),id,old.version);
      this.invalidateAuthorization(id,old.version);this.audit(p.tenantId,id,p.id,'AUTHORIZATION_REVOKED',{version:old.version});return a;});
  }
  private invalidateAuthorization(id:string,version:number){
    const rows=this.store.db.prepare("SELECT body FROM payment_proposals WHERE json_extract(body,'$.authorizationId')=? AND json_extract(body,'$.authorizationVersion')=?").all(id,version) as {body:string}[];
    for(const row of rows)this.cancelUnspent(PaymentProposalSchema.parse(JSON.parse(row.body)),'AUTHORIZATION_INVALIDATED');
  }
  createTask(p:DefensePrincipal,raw:unknown){
    requireRole(p,'OWNER');const input=CreatePaymentTaskSchema.parse(raw),requestKey=key(p,input.clientRequestId);
    const old=this.store.db.prepare('SELECT body FROM payment_tasks WHERE request_key=?').get(requestKey) as {body:string}|undefined;
    if(old){const t=PaymentTaskSchema.parse(JSON.parse(old.body));const {schemaVersion:_,taskId:__,tenantId:___,ownerId:____,createdAt:_____,status:______,...original}=t;if(digest(original)!==digest(input))throw new ApiError(409,'DEFENSE_REQUEST_CONFLICT');return t;}
    const a=this.getAuthorization(p,input.authorizationId,input.authorizationVersion),now=Date.now();
    if(a.status!=='ACTIVE'||a.digest!==input.authorizationDigest)throw new ApiError(409,'DEFENSE_AUTHORIZATION_STALE');
    this.assertAccount(p,a.policy.account);this.ownSession(p,input.walletSessionId);this.wallet.sessions.assert(input.walletSessionId,input.walletSessionRevision,a.policy.account,a.policy.chainId);
    this.principal(input.agentId,'AGENT',p.tenantId);this.principal(input.executorId,'EXECUTOR',p.tenantId);
    if(now<a.policy.validFrom||now>=a.policy.expiresAt||input.expiresAt> a.policy.expiresAt||input.expiresAt<=now)throw new ApiError(409,'DEFENSE_AUTHORIZATION_EXPIRED');
    if(BigInt(input.maxTotalAmount)>BigInt(a.policy.maxTotalAmount)||BigInt(input.maxTotalFee)>BigInt(a.policy.maxTotalFee)||input.maxTransactions>a.policy.maxTransactions||input.payments.length>input.maxTransactions||input.payments.some(l=>BigInt(l.maxAmount)>BigInt(a.policy.maxAmountPerTransaction)))throw new ApiError(409,'DEFENSE_TASK_LIMIT');
    const t:PaymentTask={...input,schemaVersion:'payment-task-v1',taskId:randomUUID(),tenantId:p.tenantId,ownerId:p.id,createdAt:now,status:'ACTIVE'};
    return this.store.transaction(()=>{this.store.db.prepare('INSERT INTO payment_tasks VALUES(?,?,?)').run(t.taskId,requestKey,JSON.stringify(t));this.audit(p.tenantId,t.taskId,p.id,'TASK_SCOPE_CONFIRMED',{authorizationDigest:a.digest,paymentsDigest:digest(t.payments)});return t;});
  }
  getTask(p:DefensePrincipal,id:string){const t=this.readTask(id);if(t.tenantId!==p.tenantId||!((p.role==='OWNER'&&p.id===t.ownerId)||(p.role==='AGENT'&&p.id===t.agentId)||(p.role==='EXECUTOR'&&p.id===t.executorId)))throw new ApiError(404,'DEFENSE_RESOURCE_NOT_FOUND');return t;}
  private liveTask(t:PaymentTask){
    const a=this.readAuth(t.authorizationId,t.authorizationVersion),now=Date.now();
    if(t.status!=='ACTIVE')throw new ApiError(409,'DEFENSE_TASK_CANCELLED');
    if(a.status!=='ACTIVE'||a.digest!==t.authorizationDigest||this.authDigest(a)!==a.digest)throw new ApiError(409,'DEFENSE_AUTHORIZATION_STALE');
    if(now<t.createdAt||now<a.policy.validFrom||now>=a.policy.expiresAt||now>=t.expiresAt)throw new ApiError(409,'DEFENSE_AUTHORIZATION_EXPIRED');
    this.assertAccount(this.principal(t.ownerId,'OWNER',t.tenantId),a.policy.account);this.principal(t.agentId,'AGENT',t.tenantId);this.principal(t.executorId,'EXECUTOR',t.tenantId);
    this.wallet.sessions.assert(t.walletSessionId,t.walletSessionRevision,a.policy.account,a.policy.chainId);return a;
  }
  cancelTask(p:DefensePrincipal,id:string){requireRole(p,'OWNER');return this.store.transaction(()=>{const t=this.getTask(p,id);t.status='CANCELLED';this.store.db.prepare('UPDATE payment_tasks SET body=? WHERE id=?').run(JSON.stringify(t),id);
    for(const x of this.proposalsForTask(id))this.cancelUnspent(x,'TASK_CANCELLED',p.id);this.audit(t.tenantId,id,p.id,'TASK_CANCELLED',{});return t;});}
  private proposalsForTask(id:string){return (this.store.db.prepare("SELECT body FROM payment_proposals WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(id) as {body:string}[]).map(row=>PaymentProposalSchema.parse(JSON.parse(row.body)));}
  getProposal(p:DefensePrincipal,id:string){const x=this.readProposal(id);this.getTask(p,x.taskId);return x;}
  private saveProposal(x:PaymentProposal){this.store.db.prepare('UPDATE payment_proposals SET body=?,review_id=? WHERE id=?').run(JSON.stringify(x),x.reviewId,x.proposalId);}
  private compare(policy:PaymentPolicy,maximum:string,tx:PaymentProposal['transaction']){
    const items:PaymentDifference[]=[];let value=BigInt(tx.value).toString();
    if(tx.from!==policy.account)items.push(difference('from','ACCOUNT_MISMATCH',policy.account,tx.from));
    if(tx.chainId!==policy.chainId)items.push(difference('chainId','CHAIN_MISMATCH',policy.chainId,tx.chainId));
    if(policy.operation==='native_transfer'){
      if(tx.to!==policy.recipient)items.push(difference('recipient','RECIPIENT_MISMATCH',policy.recipient,tx.to));
      if(tx.data!=='0x')items.push(difference('data','UNEXPECTED_CALLDATA','0x',tx.data.slice(0,160)));
    }else{
      if(tx.to!==policy.token)items.push(difference('token','TOKEN_MISMATCH',policy.token!,tx.to));
      if(BigInt(tx.value)!==0n)items.push(difference('value','TOKEN_CALL_WITH_NATIVE_VALUE','0',BigInt(tx.value).toString()));
      try{
        const decoded=decodeFunctionData({abi:erc20Abi,data:tx.data as `0x${string}`});
        if(decoded.functionName!=='transfer'&&decoded.functionName!=='approve')throw new Error();
        const [target,n]=decoded.args,recipient=target.toLowerCase();value=n.toString();
        const expected=policy.operation==='erc20_transfer'?'transfer':'approve';
        if(decoded.functionName!==expected)items.push(difference('operation','OPERATION_MISMATCH',expected,decoded.functionName));
        if(recipient!==policy.recipient)items.push(difference('recipient','RECIPIENT_MISMATCH',policy.recipient,recipient));
        if(tx.data!==encodeFunctionData({abi:erc20Abi,functionName:decoded.functionName,args:[target,n]}))items.push(difference('data','NONCANONICAL_CALLDATA','canonical_abi',tx.data.slice(0,160)));
      }catch{items.push(difference('data','UNSUPPORTED_TOKEN_CALL',policy.operation,tx.data.slice(0,160)));}
    }
    if(BigInt(value)>BigInt(policy.maxAmountPerTransaction))items.push(difference('amount','AMOUNT_LIMIT',policy.maxAmountPerTransaction,value));
    if(BigInt(value)>BigInt(maximum))items.push(difference('amount','PAYMENT_LINE_LIMIT',maximum,value));return {items,value};
  }
  private reservations(authId:string){return this.store.db.prepare("SELECT * FROM payment_reservations WHERE authorization_id=? AND state!='RELEASED'").all(authId) as Reservation[];}
  private limits(t:PaymentTask,a:PaymentAuthorization,value:string,exclude?:string){
    const rows=this.reservations(a.authorizationId).filter(r=>r.proposal_id!==exclude),task=rows.filter(r=>r.task_id===t.taskId),out:PaymentDifference[]=[];
    for(const [name,subset,maxAmount,maxFee,maxCount] of [['authorization',rows,a.policy.maxTotalAmount,a.policy.maxTotalFee,a.policy.maxTransactions],['task',task,t.maxTotalAmount,t.maxTotalFee,t.maxTransactions]] as const){
      const total=subset.reduce((s,r)=>s+BigInt(r.amount),0n)+BigInt(value),fees=subset.reduce((s,r)=>s+BigInt(r.fee),0n)+BigInt(a.policy.maxFeePerTransaction);
      if(total>BigInt(maxAmount))out.push(difference(name+'.amount','TOTAL_AMOUNT_LIMIT',maxAmount,total.toString()));
      if(fees>BigInt(maxFee))out.push(difference(name+'.fee','TOTAL_FEE_LIMIT',maxFee,fees.toString()));
      if(subset.length+1>maxCount)out.push(difference(name+'.count','TRANSACTION_COUNT_LIMIT',String(maxCount),String(subset.length+1)));
    }return out;
  }
  private reclaim(){
    const rows=this.store.db.prepare("SELECT p.body FROM payment_proposals p JOIN payment_reservations r ON p.id=r.proposal_id WHERE r.state='RESERVED'").all() as {body:string}[];
    for(const row of rows){const x=PaymentProposalSchema.parse(JSON.parse(row.body));let invalid=false;
      try{this.liveTask(this.readTask(x.taskId));const r=this.wallet.get(x.reviewId!);invalid=['CANCELLED','INTERRUPTED','EXPIRED'].includes(r.status)||(r.expiresAt!==null&&r.expiresAt<=Date.now());}catch{invalid=true;}
      if(invalid)this.cancelUnspent(x,'RESERVATION_INVALIDATED');
    }
  }
  createProposal(p:DefensePrincipal,raw:unknown){
    requireRole(p,'AGENT');const input=CreatePaymentProposalSchema.parse(raw),t=this.getTask(p,input.taskId),requestKey=key(p,input.clientRequestId);
    const old=this.store.db.prepare('SELECT body FROM payment_proposals WHERE request_key=?').get(requestKey) as {body:string}|undefined;
    if(old){const x=PaymentProposalSchema.parse(JSON.parse(old.body));const {clientRequestId,taskId,paymentRef,invoiceDigest,materialDigests,transaction,explanation}=x;if(digest({clientRequestId,taskId,paymentRef,invoiceDigest,materialDigests,transaction,explanation})!==digest(input))throw new ApiError(409,'DEFENSE_REQUEST_CONFLICT');return x;}
    const count=this.store.db.prepare("SELECT count(*) AS n FROM payment_proposals WHERE json_extract(body,'$.taskId')=?").get(t.taskId) as {n:number};
    if(count.n>=(this.config.defense?.maxProposalsPerTask??100))throw new ApiError(429,'DEFENSE_PROPOSAL_LIMIT');
    return this.store.transaction(()=>{
      this.reclaim();const a=this.readAuth(t.authorizationId,t.authorizationVersion),line=t.payments.find(l=>l.paymentRef===input.paymentRef),differences:PaymentDifference[]=[];
      try{this.liveTask(t);}catch(e){differences.push(difference('authorization',e instanceof ApiError?e.message:'AUTHORIZATION_UNAVAILABLE','active_valid_task','unavailable'));}
      if(!line)differences.push(difference('paymentRef','PAYMENT_REF_UNKNOWN','confirmed_task_line',input.paymentRef));
      if(line&&line.invoiceDigest!==input.invoiceDigest)differences.push(difference('invoiceDigest','INVOICE_BINDING_MISMATCH',line.invoiceDigest,input.invoiceDigest));
      if(line&&!sameSet(line.materialDigests,input.materialDigests))differences.push(difference('materialDigests','MATERIAL_BINDING_MISMATCH',digest([...line.materialDigests].sort()),digest([...input.materialDigests].sort())));
      const compared=this.compare(a.policy,line?.maxAmount??'0',input.transaction);differences.push(...compared.items,...this.limits(t,a,compared.value));
      if(this.store.db.prepare("SELECT 1 FROM payment_reservations WHERE tenant_id=? AND owner_id=? AND invoice_digest=? AND state!='RELEASED'").get(t.tenantId,t.ownerId,input.invoiceDigest))differences.push(difference('invoiceDigest','DUPLICATE_PAYMENT','unreserved_invoice',input.invoiceDigest));
      const x:PaymentProposal={...input,schemaVersion:'payment-proposal-v1',proposalId:randomUUID(),tenantId:t.tenantId,agentId:p.id,authorizationId:a.authorizationId,authorizationVersion:a.version,authorizationDigest:a.digest,createdAt:Date.now(),status:'BLOCKED',differences,reviewId:null,explanationAuthority:'UNTRUSTED_AGENT_DECLARATION'};
      this.store.db.prepare('INSERT INTO payment_proposals VALUES(?,?,?,?)').run(x.proposalId,requestKey,null,JSON.stringify(x));
      if(!differences.length){
        const policy=a.policy;
        const intent:WalletIntent=policy.operation==='native_transfer'?{account:policy.account,chainId:policy.chainId,recipient:policy.recipient,maxValueWei:line!.maxAmount,maxTotalFeeWei:policy.maxFeePerTransaction,operation:'native_transfer'}:{account:policy.account,chainId:policy.chainId,recipient:policy.token!,maxValueWei:'0',maxTotalFeeWei:policy.maxFeePerTransaction,operation:'contract_call',functionSelector:policy.operation==='erc20_transfer'?'0xa9059cbb':'0x095ea7b3',contractAction:policy.operation==='erc20_transfer'?{kind:'erc20_transfer',recipient:policy.recipient,amount:compared.value}:{kind:'erc20_approve',spender:policy.recipient,amount:compared.value}};
        const review=this.wallet.create({schemaVersion:'wallet-review-v2',clientRequestId:`defense-${x.proposalId}`,walletSessionId:t.walletSessionId,walletSessionRevision:t.walletSessionRevision,transaction:input.transaction,intent,traceId:t.taskId});
        x.reviewId=review.reviewId;x.status='REVIEW_CREATED';this.saveProposal(x);
        this.store.db.prepare('INSERT INTO payment_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(x.proposalId,a.authorizationId,t.taskId,t.tenantId,t.ownerId,x.paymentRef,x.invoiceDigest,compared.value,policy.maxFeePerTransaction,'RESERVED');
      }
      this.audit(t.tenantId,x.proposalId,p.id,x.status,{taskId:t.taskId,authorizationDigest:a.digest,invoiceDigest:x.invoiceDigest,materialDigests:x.materialDigests,differences:x.differences});return x;
    });
  }
  private bound(reviewId:string){const row=this.store.db.prepare('SELECT body FROM payment_proposals WHERE review_id=?').get(reviewId) as {body:string}|undefined;if(!row)throw new ApiError(409,'DEFENSE_PROPOSAL_REQUIRED');return PaymentProposalSchema.parse(JSON.parse(row.body));}
  private assertReview(r:WalletReview){
    const x=this.bound(r.reviewId),t=this.readTask(x.taskId),a=this.liveTask(t);
    if(x.status!=='REVIEW_CREATED'||x.authorizationDigest!==a.digest||digest(x.transaction)!==digest(r.transaction)||r.walletSessionId!==t.walletSessionId||r.walletSessionRevision!==t.walletSessionRevision)throw new ApiError(409,'DEFENSE_BINDING_CHANGED');
    const reserve=this.store.db.prepare('SELECT * FROM payment_reservations WHERE proposal_id=?').get(x.proposalId) as Reservation|undefined;
    if(!reserve||reserve.state!=='RESERVED'||this.compare(a.policy,t.payments.find(l=>l.paymentRef===x.paymentRef)!.maxAmount,r.transaction).items.length||this.limits(t,a,reserve.amount,x.proposalId).length)throw new ApiError(409,'DEFENSE_BUDGET_UNAVAILABLE');
  }
  private commitConsumption(r:WalletReview){
    this.assertReview(r);const x=this.bound(r.reviewId),t=this.readTask(x.taskId),tx=r.preparedTransaction!;
    if(this.store.db.prepare('SELECT 1 FROM defense_nonces WHERE chain_id=? AND account=? AND nonce=?').get(tx.chainId,tx.from,tx.nonce))throw new ApiError(409,'DEFENSE_NONCE_ALREADY_CONSUMED');
    this.store.db.prepare('INSERT INTO defense_nonces VALUES(?,?,?,?)').run(tx.chainId,tx.from,tx.nonce,x.proposalId);
    this.store.db.prepare("UPDATE payment_reservations SET state='SPENT' WHERE proposal_id=? AND state='RESERVED'").run(x.proposalId);
    const grant:ExecutionGrant={schemaVersion:'execution-grant-v1',grantId:randomUUID(),proposalId:x.proposalId,reviewId:r.reviewId,taskId:t.taskId,tenantId:t.tenantId,executorId:t.executorId,authorizationId:x.authorizationId,authorizationVersion:x.authorizationVersion,authorizationDigest:x.authorizationDigest,transactionDigest:r.transactionDigest!,transaction:tx,consumedAt:Date.now(),expiresAt:Math.min(r.expiresAt!,t.expiresAt,this.readAuth(x.authorizationId,x.authorizationVersion).policy.expiresAt),authority:'ONLINE_SERVER_CONSUMPTION_RECORD'};
    this.store.db.prepare('INSERT INTO execution_grants VALUES(?,?,?)').run(grant.grantId,r.reviewId,JSON.stringify(ExecutionGrantSchema.parse(grant)));this.audit(t.tenantId,x.proposalId,t.executorId,'PERMIT_CONSUMED',{grantId:grant.grantId,transactionDigest:grant.transactionDigest});
  }
  private cancelUnspent(x:PaymentProposal,reason:string,actor='SERVER'){
    if(x.status==='CANCELLED')return;
    if(x.reviewId){const r=this.wallet.get(x.reviewId);if(r.status==='CONSUMED')return;this.wallet.cancel(x.reviewId);}
    this.store.db.prepare("UPDATE payment_reservations SET state='RELEASED' WHERE proposal_id=? AND state='RESERVED'").run(x.proposalId);
    x.status='CANCELLED';this.saveProposal(x);this.audit(x.tenantId,x.proposalId,actor,'PROPOSAL_CANCELLED',{reason});
  }
  cancelProposal(p:DefensePrincipal,id:string){requireRole(p,'OWNER');return this.store.transaction(()=>{const x=this.getProposal(p,id);if(x.reviewId&&this.wallet.get(x.reviewId).status==='CONSUMED')throw new ApiError(409,'WALLET_PERMIT_ALREADY_CONSUMED');this.cancelUnspent(x,'USER_CANCELLED',p.id);return this.readProposal(id);});}
  confirmProposal(p:DefensePrincipal,id:string,raw:unknown,override=false){requireRole(p,'OWNER');return this.store.transaction(()=>{const x=this.getProposal(p,id);if(!x.reviewId)throw new ApiError(409,'PAYMENT_PROPOSAL_NOT_EXECUTABLE');const result=override?this.wallet.overrideRisk(x.reviewId,raw):this.wallet.confirm(x.reviewId,raw);this.audit(p.tenantId,id,p.id,override?'RISK_CONFIRMED':'USER_CONFIRMED',{reviewId:x.reviewId});return result;});}
  async consumeProposal(p:DefensePrincipal,id:string,raw:unknown){requireRole(p,'EXECUTOR');const x=this.getProposal(p,id);if(!x.reviewId)throw new ApiError(409,'PAYMENT_PROPOSAL_NOT_EXECUTABLE');ConsumeWalletReviewSchema.parse(raw);await this.wallet.consume(x.reviewId,raw);return this.grant(x.reviewId);}
  private grant(reviewId:string){const row=this.store.db.prepare('SELECT body FROM execution_grants WHERE review_id=?').get(reviewId) as {body:string}|undefined;return row?ExecutionGrantSchema.parse(JSON.parse(row.body)):null;}
  viewProposal(p:DefensePrincipal,id:string){const proposal=this.getProposal(p,id);return {proposal,review:proposal.reviewId?this.wallet.get(proposal.reviewId):null,actions:proposal.reviewId?this.wallet.actions(proposal.reviewId):null,grant:proposal.reviewId?this.grant(proposal.reviewId):null};}
  viewTask(p:DefensePrincipal,id:string){const task=this.getTask(p,id),a=this.readAuth(task.authorizationId,task.authorizationVersion);return {task,authorization:a,proposals:this.proposalsForTask(id),reservations:this.reservations(a.authorizationId).filter(r=>r.task_id===id)};}
  auditProposal(p:DefensePrincipal,id:string){const x=this.getProposal(p,id);return (this.store.db.prepare('SELECT seq,body FROM defense_audit WHERE tenant_id=? AND resource_id=? ORDER BY seq').all(p.tenantId,x.proposalId) as {seq:number;body:string}[]).map(r=>({sequence:r.seq,...JSON.parse(r.body)}));}
  graph(p:DefensePrincipal,id:string){const x=this.getProposal(p,id);if(!x.reviewId)throw new ApiError(404,'DEFENSE_REVIEW_NOT_CREATED');return x.reviewId;}
  async report(p:DefensePrincipal,id:string,raw:unknown){requireRole(p,'EXECUTOR');const x=this.getProposal(p,id);if(!x.reviewId||!this.grant(x.reviewId))throw new ApiError(409,'DEFENSE_GRANT_REQUIRED');return this.wallet.broadcast(x.reviewId,raw);}
  async recheck(p:DefensePrincipal,id:string){requireRole(p,'OWNER','EXECUTOR');const idReview=this.graph(p,id);return this.wallet.recheckReceipt(idReview);}
  watch(p:DefensePrincipal,id:string,action:'get'|'start'|'stop'|'resume'){if(action!=='get')requireRole(p,'OWNER','EXECUTOR');const reviewId=this.graph(p,id);return action==='get'?this.watches.get(reviewId):action==='start'?this.watches.start(reviewId):action==='stop'?this.watches.stop(reviewId):this.watches.resume(reviewId);}
  evidence(p:DefensePrincipal,id:string){const reviewId=this.graph(p,id),r=this.wallet.get(reviewId);if(!r.evidenceRef)throw new ApiError(404,'WALLET_EVIDENCE_UNAVAILABLE');return this.wallet.evidence.read(r.evidenceRef);}
  list(p:DefensePrincipal,kind:'authorizations'|'tasks'|'proposals',query:URLSearchParams){
    if([...query.keys()].some(k=>query.getAll(k).length!==1))throw new ApiError(400,'DUPLICATE_QUERY_PARAMETER');
    const q=z.strictObject({limit:z.string().regex(/^[1-9][0-9]?$/).transform(Number).optional(),before:z.string().uuid().optional()}).parse(Object.fromEntries(query)),limit=q.limit??25;
    const table=kind==='authorizations'?'payment_authorizations':kind==='tasks'?'payment_tasks':'payment_proposals';
    if(kind==='authorizations')requireRole(p,'OWNER');
    const ownerField=p.role==='OWNER'?'ownerId':p.role==='AGENT'?'agentId':'executorId';
    const scope=kind==='proposals'?`EXISTS (SELECT 1 FROM payment_tasks t WHERE t.id=json_extract(a.body,'$.taskId') AND json_extract(t.body,'$.${ownerField}')=?)`:`json_extract(a.body,'$.${ownerField}')=?`;
    const latest=kind==='authorizations'?'AND a.version=(SELECT MAX(b.version) FROM payment_authorizations b WHERE b.id=a.id)':'';
    const rows=this.store.db.prepare(`SELECT a.id,a.body FROM ${table} a WHERE json_extract(a.body,'$.tenantId')=? AND ${scope} ${latest} ${q.before?'AND a.id<?':''} ORDER BY a.id DESC LIMIT ?`).all(p.tenantId,p.id,...(q.before?[q.before]:[]),limit+1) as {id:string;body:string}[];
    const page=rows.slice(0,limit);return {items:page.map(row=>JSON.parse(row.body)),hasMore:rows.length>limit,nextCursor:rows.length>limit?page.at(-1)!.id:null};
  }
}
