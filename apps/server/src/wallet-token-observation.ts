import {z} from 'zod';
import {encodeFunctionData,erc20Abi,keccak256,toHex} from 'viem';
import {WalletTokenStateSchema,WalletTokenPostStateSchema,WalletAddressSchema,WalletHashSchema,WalletQuantitySchema,type WalletIntent,type PreparedWalletTransaction} from '@verdict/protocol';
import {assertBlock,WalletObservationFailure,type WalletRpc} from './wallet-observation.js';
import {inspectContract,type WalletNetwork} from './wallet-contract.js';

const word=z.string().regex(/^0x[0-9a-f]{64}$/);
const tokenReceipt=z.object({transactionHash:WalletHashSchema,blockHash:WalletHashSchema,blockNumber:WalletQuantitySchema,status:z.enum(['0x0','0x1']),
  logs:z.array(z.object({address:WalletAddressSchema,topics:z.array(WalletHashSchema).max(4),data:z.string().regex(/^0x(?:[0-9a-f]{2})*$/).max(4096),removed:z.literal(false).optional()})).max(64)});

export async function tokenPostState(ask:WalletRpc,transaction:PreparedWalletTransaction,intent:WalletIntent,n:WalletNetwork,before:{blockNumber:string;blockHash:string},receipt:{transactionHash:string;blockNumber:string;blockHash:string;status:'0x0'|'0x1'}) {
  if(intent.operation!=='contract_call')throw new WalletObservationFailure('CONTRACT_INTENT_REQUIRED',true);
  const action=intent.contractAction,other=action.kind==='erc20_transfer'?action.recipient:action.spender;
  const balanceOf=(owner:string)=>encodeFunctionData({abi:erc20Abi,functionName:'balanceOf',args:[owner as `0x${string}`]});
  const probes=action.kind==='erc20_transfer'?[balanceOf(transaction.from),balanceOf(other)]:[encodeFunctionData({abi:erc20Abi,functionName:'allowance',args:[transaction.from as `0x${string}`,other as `0x${string}`]})];
  const read=async(block:{blockNumber:string;blockHash:string})=>{
    await assertBlock(ask,block.blockNumber,block.blockHash);
    const code=await ask('eth_getCode',[transaction.to,block.blockNumber]);
    try{await inspectContract({transaction,intent},n,ask,block.blockNumber,code);}catch{throw new WalletObservationFailure('TOKEN_CODE_OR_POLICY_NOT_ACCEPTED',true);}
    const values=await Promise.all(probes.map(data=>ask('eth_call',[{from:transaction.from,to:transaction.to,data},block.blockNumber])));
    const state=WalletTokenStateSchema.parse({blockNumber:block.blockNumber,blockHash:block.blockHash,values:values.map(value=>BigInt(word.parse(value)).toString())});
    await assertBlock(ask,block.blockNumber,block.blockHash);return state;
  };
  const initial=await read(before),final=await read(receipt);
  const raw=tokenReceipt.safeParse(await ask('eth_getTransactionReceipt',[receipt.transactionHash]));
  if(!raw.success)throw new WalletObservationFailure('TOKEN_RECEIPT_LOGS_UNAVAILABLE');
  const observed=raw.data;
  if(observed.transactionHash!==receipt.transactionHash||observed.blockHash!==receipt.blockHash||observed.blockNumber!==receipt.blockNumber||observed.status!==receipt.status)throw new WalletObservationFailure('TOKEN_RECEIPT_CHANGED',true);
  const signature=keccak256(toHex(action.kind==='erc20_transfer'?'Transfer(address,address,uint256)':'Approval(address,address,uint256)'));
  const topic=(address:string)=>'0x'+'0'.repeat(24)+address.slice(2);
  const logs=observed.logs;
  const matching=logs.length===1&&logs[0].address===transaction.to&&logs[0].topics.join(',')===[signature,topic(transaction.from),topic(other)].join(',')&&word.safeParse(logs[0].data).success&&BigInt(logs[0].data)===BigInt(action.amount);
  const deltas=final.values.map((v,i)=>(BigInt(v)-BigInt(initial.values[i])).toString());
  const stateMatches=action.kind==='erc20_transfer'?deltas[0]===(-BigInt(action.amount)).toString()&&deltas[1]===action.amount:final.values[0]===action.amount;
  await assertBlock(ask,receipt.blockNumber,receipt.blockHash);
  return WalletTokenPostStateSchema.parse({token:transaction.to,owner:transaction.from,counterparty:other,operation:action.kind,amount:action.amount,before:initial,after:final,deltas,
    receiptEvent:receipt.status==='0x0'?(logs.length?'MISMATCH':'NOT_EXPECTED'):(matching?'MATCH':'MISMATCH'),
    stateComparison:receipt.status==='0x0'?'NOT_EXECUTED':stateMatches?'MATCH':'DIFFERENT',source:'RPC_OBSERVATION',scope:'BLOCK_RANGE_NOT_TRANSACTION_CAUSAL'});
}
