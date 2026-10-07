import {z} from 'zod';
import {digest} from '@verdict/core';
import {WalletReviewListQuerySchema,WalletReviewPageSchema,WalletReviewSchema,WalletReviewSummarySchema,WalletHashSchema,type WalletReview} from '@verdict/protocol';
import {Store,ApiError} from './store.js';

const cursorSchema=z.strictObject({v:z.literal(1),createdAt:z.number().int().nonnegative(),id:z.string().min(1).max(160),query:WalletHashSchema});
export const userDecision=(r:WalletReview)=>r.userOverride?'CONTINUE_WITH_RISK' as const:r.userConfirmedAt?'CONFIRMED' as const:'NOT_CONFIRMED' as const;
export function walletSummary(r:WalletReview){
  const i=r.intent,token=i.operation==='contract_call'?i.contractAction:null;
  return WalletReviewSummarySchema.parse({reviewId:r.reviewId,createdAt:r.createdAt,account:r.transaction.from,chainId:r.transaction.chainId,
    operation:token?.kind??'native_transfer',target:token?(token.kind==='erc20_transfer'?token.recipient:token.spender):r.transaction.to,
    token:token?r.transaction.to:null,amount:token?.amount??BigInt(r.transaction.value).toString(),
    status:r.status,reason:r.reason,reviewVerdict:r.reviewer.verdict,userDecision:userDecision(r),receiptStatus:r.receiptReport?.receiptStatus??'NOT_REPORTED',
    postStateStatus:r.receiptReport?.postStateStatus??'NOT_CHECKED',
    tokenOutcome:r.tokenPostState?{receiptEvent:r.tokenPostState.receiptEvent,stateComparison:r.tokenPostState.stateComparison,scope:r.tokenPostState.scope}:null,
    evidenceRef:r.evidenceRef??null});
}
export function listWalletReviews(store:Store,params:URLSearchParams){
  if([...params.keys()].some(k=>params.getAll(k).length!==1))throw new ApiError(400,'DUPLICATE_QUERY_PARAMETER');
  const q=WalletReviewListQuerySchema.parse(Object.fromEntries(params)),limit=q.limit??25;
  const binding=digest({account:q.account??null,chainId:q.chainId??null,status:q.status??null,operation:q.operation??null});
  let cursor:z.infer<typeof cursorSchema>|undefined;
  if(q.cursor){
    try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8')));}catch{throw new ApiError(400,'INVALID_WALLET_CURSOR');}
    if(cursor.query!==binding)throw new ApiError(400,'WALLET_CURSOR_FILTER_MISMATCH');
  }
  const conditions:string[]=[],values:(string|number)[]=[];
  const filters:Array<[string|undefined,string]>=[
    [q.account,"json_extract(body,'$.transaction.from')"],
    [q.chainId,"json_extract(body,'$.transaction.chainId')"],
    [q.status,"json_extract(body,'$.status')"],
    [q.operation,"COALESCE(json_extract(body,'$.intent.contractAction.kind'), json_extract(body,'$.intent.operation'))"],
  ];
  for(const [value,expression] of filters){
    if(value!==undefined){conditions.push(`${expression} = ?`);values.push(value);}
  }
  if(cursor){conditions.push("(json_extract(body,'$.createdAt') < ? OR (json_extract(body,'$.createdAt') = ? AND id < ?))");values.push(cursor.createdAt,cursor.createdAt,cursor.id);}
  const rows=store.db.prepare(`SELECT body FROM wallet_reviews ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY json_extract(body,'$.createdAt') DESC, id DESC LIMIT ?`).all(...values,limit+1) as {body:string}[];
  const reviews=rows.slice(0,limit).map(row=>walletSummary(WalletReviewSchema.parse(JSON.parse(row.body)))),last=reviews.at(-1);
  const hasMore=rows.length>limit;
  return WalletReviewPageSchema.parse({schemaVersion:'wallet-review-page-v1',reviews,hasMore,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({v:1,createdAt:last.createdAt,id:last.reviewId,query:binding})).toString('base64url'):null});
}
