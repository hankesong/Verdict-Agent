import {z} from 'zod';
import {WalletReceiptWatchSchema,type WalletReceiptWatch,type WalletReview} from '@verdict/protocol';
import type {ServerConfig} from './config.js';
import {Store,ApiError} from './store.js';
import type {WalletReviews} from './wallet.js';

const rowSchema=WalletReceiptWatchSchema.extend({pollIntervalMs:z.number().int().positive()});
type Row=z.infer<typeof rowSchema>;
const active=(r:Row)=>['QUEUED','WAITING','RUNNING'].includes(r.status);

// Single-writer SQLite queue. A job only re-observes an already reported transaction hash.
export class WalletReceiptWatches {
  private timer?:ReturnType<typeof setTimeout>;
  private jobs=new Map<string,Promise<void>>();
  private closing=false;
  constructor(private store:Store,private config:ServerConfig,private wallet:WalletReviews){
    store.db.exec(`CREATE TABLE IF NOT EXISTS wallet_receipt_watches(review_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wallet_receipt_watches_pending ON wallet_receipt_watches(json_extract(body,'$.status'),json_extract(body,'$.nextPollAt'));`);
    for(const r of this.pending()){
      if(this.reconcile(r))continue;
      if(Date.now()>=r.deadlineAt)this.finish(r,'EXHAUSTED','WATCH_DEADLINE_REACHED');
      else if(r.attempts>=r.maxAttempts)this.finish(r,'EXHAUSTED','WATCH_ATTEMPTS_EXHAUSTED');
      else this.finish(r,'STOPPED','RESTART_REQUIRES_RESUME');
    }
    this.schedule();
  }
  private settings(){return this.config.wallet?.receiptTracking;}
  private read(id:string):Row|undefined{
    const row=this.store.db.prepare('SELECT body FROM wallet_receipt_watches WHERE review_id=?').get(id) as {body:string}|undefined;
    return row?rowSchema.parse(JSON.parse(row.body)):undefined;
  }
  private pending(){
    const rows=this.store.db.prepare("SELECT body FROM wallet_receipt_watches WHERE json_extract(body,'$.status') IN ('QUEUED','WAITING','RUNNING') ORDER BY json_extract(body,'$.nextPollAt'), review_id").all() as {body:string}[];
    return rows.map(row=>rowSchema.parse(JSON.parse(row.body)));
  }
  private dto(row:Row):WalletReceiptWatch{const {pollIntervalMs:_,...value}=row;return WalletReceiptWatchSchema.parse(value);}
  private save(r:Row){
    r.updatedAt=Date.now();
    this.store.db.prepare('INSERT INTO wallet_receipt_watches VALUES(?,?) ON CONFLICT(review_id) DO UPDATE SET body=excluded.body').run(r.reviewId,JSON.stringify(rowSchema.parse(r)));
  }
  get(id:string){
    this.wallet.get(id);
    const r=this.read(id);if(!r)throw new ApiError(404,'WALLET_RECEIPT_WATCH_NOT_FOUND');return this.dto(r);
  }
  start(id:string){
    const review=this.wallet.receiptTrackingReview(id);
    const old=this.read(id);if(old)return this.dto(old); // Retries never replenish attempts or extend the deadline.
    if(this.closing)throw new ApiError(503,'SERVER_STOPPING');
    const c=this.settings();if(!c?.enabled)throw new ApiError(503,'WALLET_RECEIPT_TRACKING_DISABLED');
    if(this.pending().length>=c.maxPending)throw new ApiError(429,'WALLET_RECEIPT_QUEUE_FULL');
    const now=Date.now(),r:Row={schemaVersion:'wallet-receipt-watch-v1',reviewId:id,txHash:review.receiptReport!.txHash,
      status:'QUEUED',attempts:0,maxAttempts:c.maxAttempts,pollIntervalMs:c.pollIntervalMs,
      createdAt:now,updatedAt:now,deadlineAt:now+c.maxDurationMs,nextPollAt:now,lastPollAt:null,finishedAt:null,reason:'WATCH_REQUESTED'};
    this.observeTerminal(r,review);this.save(r);this.schedule();return this.dto(r);
  }
  stop(id:string){
    this.get(id);const r=this.read(id)!;
    if(active(r))this.finish(r,'STOPPED','USER_STOPPED');
    this.schedule();return this.dto(r);
  }
  resume(id:string){
    const review=this.wallet.receiptTrackingReview(id);this.get(id);const r=this.read(id)!;
    if(r.status!=='STOPPED')return this.dto(r);
    if(this.closing)throw new ApiError(503,'SERVER_STOPPING');
    const c=this.settings();if(!c?.enabled)throw new ApiError(503,'WALLET_RECEIPT_TRACKING_DISABLED');
    if(this.jobs.has(id))throw new ApiError(409,'WALLET_WATCH_STOP_IN_PROGRESS');
    if(this.observeTerminal(r,review))return this.dto(r);
    if(Date.now()>=r.deadlineAt){this.finish(r,'EXHAUSTED','WATCH_DEADLINE_REACHED');return this.dto(r);}
    if(r.attempts>=Math.min(r.maxAttempts,c.maxAttempts)){this.finish(r,'EXHAUSTED','WATCH_ATTEMPTS_EXHAUSTED');return this.dto(r);}
    if(this.pending().length>=c.maxPending)throw new ApiError(429,'WALLET_RECEIPT_QUEUE_FULL');
    r.status='WAITING';r.nextPollAt=Date.now();r.finishedAt=null;r.reason='WATCH_RESUMED';this.save(r);this.schedule();return this.dto(r);
  }
  private finish(r:Row,status:Row['status'],reason:string){
    r.status=status;r.reason=reason;r.nextPollAt=null;r.finishedAt=Date.now();this.save(r);
  }
  private observeTerminal(r:Row,review:WalletReview){
    if(review.receiptReport?.txHash!==r.txHash){this.finish(r,'STOPPED','BROADCAST_REPORT_CHANGED');return true;}
    if(review.receiptReport.receiptStatus==='REJECTED'){this.finish(r,'REJECTED','RECEIPT_REPORT_REJECTED');return true;}
    // Completion means observation is stored, including failed transactions and differing token effects.
    if(review.evidenceRef){this.finish(r,'COMPLETED','RECEIPT_OBSERVATION_SAVED');return true;}
    return false;
  }
  private reconcile(r:Row){
    try{return this.observeTerminal(r,this.wallet.receiptTrackingReview(r.reviewId));}
    catch(e){this.finish(r,'STOPPED',e instanceof ApiError?e.message:'WATCH_REVIEW_UNAVAILABLE');return true;}
  }
  private schedule(){
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    if(this.closing)return;
    const waiting=this.pending().filter(r=>!this.jobs.has(r.reviewId));
    if(!waiting.length||this.jobs.size>=(this.settings()?.concurrency??1))return;
    const at=Math.min(...waiting.map(r=>Math.min(r.nextPollAt??Date.now(),r.deadlineAt)));
    this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},Math.max(1,at-Date.now()));this.timer.unref();
  }
  private pump(){
    if(this.closing)return;
    const c=this.settings();
    for(const r of this.pending()){
      if(this.jobs.has(r.reviewId))continue;
      if(this.reconcile(r))continue;
      if(!c?.enabled){this.finish(r,'STOPPED','WALLET_RECEIPT_TRACKING_DISABLED');continue;}
      if(Date.now()>=r.deadlineAt){this.finish(r,'EXHAUSTED','WATCH_DEADLINE_REACHED');continue;}
      if(r.attempts>=Math.min(r.maxAttempts,c.maxAttempts)){this.finish(r,'EXHAUSTED','WATCH_ATTEMPTS_EXHAUSTED');continue;}
      if((r.nextPollAt??0)>Date.now()||this.jobs.size>=c.concurrency)continue;
      if(!this.wallet.receiptReportAvailable(r.reviewId)){
        r.nextPollAt=Math.min(r.deadlineAt,Date.now()+Math.min(r.pollIntervalMs,1000));r.reason='WALLET_REPORT_BUSY';this.save(r);continue;
      }
      r.status='RUNNING';r.attempts++;r.lastPollAt=Date.now();r.nextPollAt=null;r.reason='RECHECK_IN_PROGRESS';this.save(r);
      const done=Promise.resolve().then(()=>this.poll(r.reviewId)).catch(()=>{
        const current=this.read(r.reviewId);if(current&&active(current))this.finish(current,'STOPPED','WATCH_INTERNAL_ERROR');
      }).finally(()=>{this.jobs.delete(r.reviewId);this.schedule();});
      this.jobs.set(r.reviewId,done);
    }
    this.schedule();
  }
  private async poll(id:string){
    let error:string|undefined;
    try{await this.wallet.recheckReceipt(id);}catch(e){error=e instanceof ApiError?e.message:'RECEIPT_RECHECK_UNAVAILABLE';}
    const r=this.read(id)!;
    if(!active(r))return; // stop won a race; an in-flight observation may still be recorded.
    const review=this.wallet.get(id);
    if(this.observeTerminal(r,review))return;
    if(error&&!['WALLET_REPORT_BUSY','SERVER_STOPPING'].includes(error)){this.finish(r,'STOPPED',error);return;}
    if(Date.now()>=r.deadlineAt){this.finish(r,'EXHAUSTED','WATCH_DEADLINE_REACHED');return;}
    if(r.attempts>=r.maxAttempts){this.finish(r,'EXHAUSTED','WATCH_ATTEMPTS_EXHAUSTED');return;}
    r.status='WAITING';r.reason=error??review.receiptReport?.error??'RECEIPT_OBSERVATION_INCOMPLETE';
    r.nextPollAt=Math.min(r.deadlineAt,Date.now()+Math.min(60000,r.pollIntervalMs*2**Math.min(r.attempts-1,3)));this.save(r);
  }
  async close(){
    this.closing=true;if(this.timer)clearTimeout(this.timer);
    await Promise.allSettled(this.jobs.values());
  }
}
