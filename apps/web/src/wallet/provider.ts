import { WalletAddressSchema, WalletQuantitySchema, WalletReviewSchema, PreparedWalletTransactionSchema, WalletSessionSchema,
  type WalletReview, type WalletTransaction, type WalletIntent, type WalletSession, canonical_json } from '@verdict/protocol';
import { z } from 'zod';

export interface WalletProvider {
  request(args:{method:string;params?:unknown[]}):Promise<unknown>;
  on?(event:string,listener:(...args:unknown[])=>void):void;
  removeListener?(event:string,listener:(...args:unknown[])=>void):void;
}
export type WalletChoice={id:string;name:string;provider:WalletProvider};
// EIP-6963 metadata is untrusted display text; never render wallet-supplied HTML/icons.
export function discoverWallets(receive:(choice:WalletChoice)=>void):()=>void {
  const providers=new Set<WalletProvider>();
  const add=(id:string,name:string,p:WalletProvider)=>{if(p&&typeof p.request==='function'&&!providers.has(p)){providers.add(p);receive({id,name:name.slice(0,80),provider:p});}};
  const announce=(event:Event)=>{const detail=(event as CustomEvent).detail;
    if(detail?.info&&typeof detail.info.uuid==='string'&&typeof detail.info.name==='string')add(detail.info.uuid,detail.info.name,detail.provider);};
  window.addEventListener('eip6963:announceProvider',announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const legacy=(window as unknown as {ethereum?:WalletProvider}).ethereum;
  if(legacy)add('injected','浏览器钱包',legacy);
  return ()=>window.removeEventListener('eip6963:announceProvider',announce);
}
export type WalletAPI=(path:string,body?:unknown)=>Promise<unknown>;
export class GuardedWallet {
  private provider: WalletProvider | null = null;
  private revision = 0;
  private signing = false;
  private starting = false;
  private connecting = false;
  private reviewId: string | null = null;
  private reviewRevision = -1;
  private snapshots = new Map<string, string>();
  private pending: { clientRequestId: string; transaction: WalletTransaction; intent: WalletIntent } | null = null;
  private invalidations = new Map<string, { account:string; chainId:string; providerId:string; connected:boolean; revision:number }>();
  private syncing: Promise<void> | null = null;
  session: WalletSession | null = null;
  providerId: string | null = null;
  account: string | null = null;
  chainId: string | null = null;
  constructor(private api: WalletAPI, private onChange: () => void = () => {}) {}

  private async syncInvalidations() {
    if (this.syncing) { await this.syncing; if (!this.invalidations.size) return; }
    this.syncing = (async () => {
      for (const [id, body] of this.invalidations) {
        try { await this.api(`/api/wallet/sessions/${id}`, body); }
        catch(error) {
          if (!(error instanceof Error && /WALLET_SESSION_CHANGED/.test(error.message))) throw error;
        }
        this.invalidations.delete(id);
      }
    })();
    try { await this.syncing; } finally { this.syncing = null; }
  }
  private invalidate(update: Partial<Pick<WalletSession,'account'|'chainId'|'providerId'|'connected'>> = {}) {
    const session=this.session;
    this.revision++; this.snapshots.clear(); this.reviewId=null; this.reviewRevision=-1;
    this.session=null; this.account=null; this.chainId=null; this.pending=null;
    if(session) this.invalidations.set(session.sessionId,{account:session.account,chainId:session.chainId,providerId:session.providerId,revision:session.revision,connected:false,...update});
    this.onChange();
    void this.syncInvalidations().catch(()=>{ /* Reconnection waits for a successful invalidation retry. */ });
  }
  readonly changed = () => this.invalidate();
  private readonly accountsChanged = (raw:unknown) => {
    const accounts=z.array(WalletAddressSchema).safeParse(raw);
    this.invalidate(accounts.success&&accounts.data.length?{account:accounts.data[0],connected:true}:{connected:false});
  };
  private readonly chainChanged = (raw:unknown) => {
    const chain=WalletQuantitySchema.safeParse(raw);
    this.invalidate(chain.success?{chainId:chain.data,connected:true}:{connected:false});
  };
  disconnect() {
    this.provider?.removeListener?.('accountsChanged',this.accountsChanged);
    this.provider?.removeListener?.('chainChanged',this.chainChanged);
    this.provider?.removeListener?.('disconnect',this.changed);
    this.provider=null; this.invalidate();
  }
  async connect(provider:WalletProvider,providerId='browser-wallet') {
    if(this.signing||this.starting||this.connecting)throw Error('WALLET_BUSY');
    this.connecting=true;
    try {
      this.disconnect(); await this.syncInvalidations();
      this.provider=provider; this.providerId=providerId;
      provider.on?.('accountsChanged',this.accountsChanged);provider.on?.('chainChanged',this.chainChanged);provider.on?.('disconnect',this.changed);
      await provider.request({method:'eth_requestAccounts'});
      const epoch=this.revision;
      const accounts=z.array(WalletAddressSchema).min(1).parse(await provider.request({method:'eth_accounts'}));
      const chain=WalletQuantitySchema.parse(await provider.request({method:'eth_chainId'}));
      if(epoch!==this.revision||this.provider!==provider)throw Error('WALLET_CHANGED');
      const session=WalletSessionSchema.parse(await this.api('/api/wallet/sessions',{account:accounts[0],chainId:chain,providerId}));
      if(epoch!==this.revision||this.provider!==provider){
        this.invalidations.set(session.sessionId,{account:session.account,chainId:session.chainId,providerId:session.providerId,connected:false,revision:session.revision});
        await this.syncInvalidations();throw Error('WALLET_CHANGED');
      }
      if(!session.connected||session.account!==accounts[0]||session.chainId!==chain||session.providerId!==providerId)throw Error('WALLET_SESSION_MISMATCH');
      this.account=accounts[0];this.chainId=chain;this.session=session;this.onChange();
    } finally {this.connecting=false;}
  }
  private async assertSession(provider:WalletProvider,revision:number,account:string,chain:string) {
    const accounts=z.array(WalletAddressSchema).parse(await provider.request({method:'eth_accounts'}));
    const current=WalletQuantitySchema.parse(await provider.request({method:'eth_chainId'}));
    if(this.revision!==revision||this.provider!==provider||accounts[0]!==account||current!==chain){this.invalidate();throw Error('WALLET_CHANGED');}
    if(!this.session?.connected||this.session.account!==account||this.session.chainId!==chain)throw Error('WALLET_SESSION_REQUIRED');
  }
  private assertReview(review:WalletReview) {
    if(review.schemaVersion!=='wallet-review-v2'||!this.session||review.walletSessionId!==this.session.sessionId||review.walletSessionRevision!==this.session.revision)throw Error('WALLET_SESSION_CHANGED');
  }
  async review(transaction:WalletTransaction,intent:WalletIntent):Promise<WalletReview> {
    if(this.starting||this.signing||this.connecting)throw Error('WALLET_BUSY');
    if(!this.provider||!this.account||!this.chainId||!this.session)throw Error('WALLET_NOT_CONNECTED');
    if(transaction.from!==this.account||transaction.chainId!==this.chainId)throw Error('WALLET_CHANGED');
    this.starting=true;
    const revision=this.revision,provider=this.provider,account=this.account,chain=this.chainId,session=this.session;
    try {
      await this.syncInvalidations();
      if(this.reviewId)await this.api(`/api/wallet/reviews/${this.reviewId}/cancel`,{});
      this.snapshots.clear();this.reviewId=null;
      await this.assertSession(provider,revision,account,chain);
      if(this.pending&&canonical_json({transaction:this.pending.transaction,intent:this.pending.intent})!==canonical_json({transaction,intent}))throw Error('上次提交尚未确认，请先重试原交易');
      this.pending??={clientRequestId:crypto.randomUUID(),transaction:structuredClone(transaction),intent:structuredClone(intent)};
      let r:WalletReview;
      try {r=WalletReviewSchema.parse(await this.api('/api/wallet/reviews',{schemaVersion:'wallet-review-v2',walletSessionId:session.sessionId,walletSessionRevision:session.revision,...this.pending}));}
      catch(error){if(error&&typeof error==='object'&&'status' in error&&[400,403,404,409,415,422].includes(Number(error.status)))this.pending=null;throw error;}
      this.pending=null;
      if(revision!==this.revision||provider!==this.provider){await this.api(`/api/wallet/reviews/${r.reviewId}/cancel`,{});throw Error('WALLET_CHANGED');}
      this.assertReview(r);this.reviewId=r.reviewId;this.reviewRevision=revision;return r;
    } finally {this.starting=false;}
  }
  async poll():Promise<WalletReview> {
    if(!this.reviewId)throw Error('NO_ACTIVE_REVIEW');const id=this.reviewId;
    const r=WalletReviewSchema.parse(await this.api(`/api/wallet/reviews/${id}`));
    if(this.reviewId!==id||this.reviewRevision!==this.revision)throw Error('WALLET_CHANGED');
    this.assertReview(r);
    if(r.status==='ALLOWED'&&r.preparedTransaction)this.snapshots.set(id,canonical_json(r.preparedTransaction));
    return r;
  }
  async cancel() {
    if(this.signing)throw Error('WALLET_REQUEST_ALREADY_SENT');
    const id=this.reviewId;this.reviewId=null;this.snapshots.clear();
    if(id)await this.api(`/api/wallet/reviews/${id}/cancel`,{});
  }
  async send(review:WalletReview,handwritingAcknowledged=false):Promise<string> {
    if(this.signing||this.starting||this.connecting)throw Error('WALLET_BUSY');
    const provider=this.provider,revision=this.revision,account=this.account,chain=this.chainId;
    if(!provider||!account||!chain)throw Error('WALLET_NOT_CONNECTED');
    this.assertReview(review);
    if(!handwritingAcknowledged)throw Error('WALLET_HANDWRITING_REQUIRED');
    if(review.reviewId!==this.reviewId||revision!==this.reviewRevision||review.status!=='ALLOWED'||!review.expiresAt||Date.now()>=review.expiresAt||!review.preparedTransaction||this.snapshots.get(review.reviewId)!==canonical_json(review.preparedTransaction)||!review.confirmationNonce)throw Error('WALLET_REVIEW_REQUIRED');
    const tx=PreparedWalletTransactionSchema.parse(structuredClone(review.preparedTransaction));
    if(tx.from!==account||tx.chainId!==chain)throw Error('WALLET_CHANGED');
    this.signing=true;
    try {
      await this.assertSession(provider,revision,account,chain);
      const confirmation={transactionDigest:review.transactionDigest,account:tx.from,chainId:tx.chainId,confirmationNonce:review.confirmationNonce,walletSessionId:review.walletSessionId,walletSessionRevision:review.walletSessionRevision,handwritingAcknowledged:true};
      try {
        const response=z.object({reviewId:z.string(),transactionDigest:z.string(),confirmedAt:z.number().positive(),authority:z.literal('CLIENT_DECLARED')}).parse(await this.api(`/api/wallet/reviews/${review.reviewId}/confirm`,confirmation));
        if(response.reviewId!==review.reviewId||response.transactionDigest!==review.transactionDigest)throw Error('WALLET_CONFIRMATION_MISMATCH');
      } catch(error) {
        // A lost successful response must recover the same confirmation, never POST a new one.
        const current=WalletReviewSchema.parse(await this.api(`/api/wallet/reviews/${review.reviewId}`));
        this.assertReview(current);
        if(current.reviewId!==review.reviewId||current.status!=='ALLOWED'||current.transactionDigest!==review.transactionDigest||current.confirmationNonce!==review.confirmationNonce||!current.userConfirmedAt||!current.userConfirmationDigest||!current.preparedTransaction||canonical_json(current.preparedTransaction)!==canonical_json(tx)||Date.now()>=(current.expiresAt??0))throw error;
      }
      await this.assertSession(provider,revision,account,chain);
      const response=z.object({reviewId:z.string(),transactionDigest:z.string(),transaction:PreparedWalletTransactionSchema}).parse(await this.api(`/api/wallet/reviews/${review.reviewId}/consume`,{transaction:tx}));
      this.snapshots.delete(review.reviewId);
      if(response.reviewId!==review.reviewId||response.transactionDigest!==review.transactionDigest||canonical_json(response.transaction)!==canonical_json(tx))throw Error('WALLET_TRANSACTION_CHANGED');
      await this.assertSession(provider,revision,account,chain);
      if(Date.now()>=review.expiresAt)throw Error('WALLET_REVIEW_EXPIRED');
      const result=await provider.request({method:'eth_sendTransaction',params:[Object.freeze(tx)]});
      return z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(result);
    } finally {this.snapshots.delete(review.reviewId);if(this.reviewId===review.reviewId){this.reviewId=null;this.reviewRevision=-1;}this.signing=false;}
  }
}
