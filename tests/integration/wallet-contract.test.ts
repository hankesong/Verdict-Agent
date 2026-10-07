import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData, erc20Abi, keccak256} from 'viem';
import {WalletConfigSchema} from '../../apps/server/src/config.js';
import {contractPolicy} from '../../apps/server/src/wallet-contract.js';
import {WalletReviewSchema, type WalletReview, type WalletIntent} from '@verdict/protocol';

const account=('0x'+'1'.repeat(40)) as `0x${string}`, token=('0x'+'2'.repeat(40)) as `0x${string}`, recipient=('0x'+'3'.repeat(40)) as `0x${string}`, spender=('0x'+'4'.repeat(40)) as `0x${string}`;
const runtime='0x60006000';
const network=WalletConfigSchema.parse({networks:[{chainId:'0x3c8',name:'test',rpcUrlEnv:'RPC',maxValueWei:'0',maxTotalFeeWei:'1000000',tokens:[{address:token,codeHash:keccak256(runtime as `0x${string}`),maxTransferAmount:'1000',maxApprovalAmount:'1000',approvedSpenders:[spender]}]}],contractCalls:{enabled:true}}).networks[0];
function review(action:WalletIntent, data:string):WalletReview {
  return WalletReviewSchema.parse({schemaVersion:'wallet-review-v2',walletSessionId:'00000000-0000-4000-8000-000000000001',walletSessionRevision:1,reviewId:'r',clientRequestId:'c',inputDigest:'0x1',transactionDigest:null,transaction:{chainId:'0x3c8',from:account,to:token,value:'0x0',data},intent:action,preparedTransaction:null,status:'REVIEWING',reason:'PENDING',createdAt:1,expiresAt:null,checks:[],events:[],reviewer:{modelId:'m',source:'TEST_TRANSPORT',verdict:null},usage:{requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:null},broadcastStatus:'NOT_BROADCAST_BY_SERVER',confirmationNonce:'00000000-0000-4000-8000-000000000002'});
}
const base={account,chainId:'0x3c8',recipient:token,maxValueWei:'0',maxTotalFeeWei:'1000000'};
test('contract policy binds ERC-20 transfer calldata to the declared intent and configured code hash',()=>{
  const data=encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[recipient,500n]});
  const r=review({...base,operation:'contract_call',functionSelector:'0xa9059cbb',contractAction:{kind:'erc20_transfer',recipient,amount:'500'}},data);
  assert.equal(contractPolicy(r,network).address,token);
  const changed={...r,transaction:{...r.transaction,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[spender,500n]})}};
  assert.throws(()=>contractPolicy(changed,network),/INTENT_CALL_MISMATCH/);
});
test('contract policy refuses unknown token, unlimited approval and unapproved spender',()=>{
  const data=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[spender,2n**256n-1n]});
  const r=review({...base,operation:'contract_call',functionSelector:'0x095ea7b3',contractAction:{kind:'erc20_approve',spender,amount:(2n**256n-1n).toString()}},data);
  assert.throws(()=>contractPolicy(r,network),/UNLIMITED_APPROVAL/);
  const unknown={...r,transaction:{...r.transaction,to:'0x'+'9'.repeat(40)},intent:{...r.intent,recipient:'0x'+'9'.repeat(40)}};
  assert.throws(()=>contractPolicy(unknown,network),/TOKEN_NOT_CONFIGURED/);
  const disallowed=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[recipient,1n]});
  const disallowedReview=review({...base,operation:'contract_call',functionSelector:'0x095ea7b3',contractAction:{kind:'erc20_approve',spender:recipient,amount:'1'}},disallowed);
  assert.throws(()=>contractPolicy(disallowedReview,network),/SPENDER_NOT_CONFIGURED/);
});
