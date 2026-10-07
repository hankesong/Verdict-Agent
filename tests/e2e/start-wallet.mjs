import {keccak256,toHex} from 'viem';
import {walletHarness} from '../integration/wallet-graph-harness.ts';
const f=await walletHarness();
f.h.config.port=Number(process.env.TEST_WALLET_PORT??3122);
f.h.config.instanceId='wallet-browser-test';
f.h.config.corsOrigins=['http://127.0.0.1:5183'];
f.h.config.wallet.permitTtlMs=120000;
f.h.config.wallet.rpcTimeoutMs=3000;
f.h.config.wallet.reviewTimeoutMs=20000;
f.h.config.guard.requestTimeoutMs=10000;
const token='0x'+'3'.repeat(40),account='0x'+'1'.repeat(40),spender='0x'+'4'.repeat(40),runtime='0x60006000';
const word=n=>toHex(n,{size:32}),topic=a=>'0x'+'0'.repeat(24)+a.slice(2);
f.h.config.wallet.contractCalls.enabled=true;
f.h.config.wallet.networks[0].tokens=[{address:token,codeHash:keccak256(runtime),maxTransferAmount:'1000',maxApprovalAmount:'1000',approvedSpenders:[spender]}];
f.rpcState.handler=async(method,params)=>{
 if(method==='eth_getCode'&&params[0]===token)return runtime;
 if(method==='eth_getStorageAt')return word(0n);
 if(method==='eth_estimateGas'&&params[0].to===token)return '0xc350';
 if(method==='eth_call'&&params[0].to===token){const d=params[0].data;if(d.startsWith('0x70a08231'))return word(d.endsWith(account.slice(2))?1000n:200n);if(d.startsWith('0xdd62ed3e'))return word(0n);return word(1n);}
 if(method==='debug_traceCall')return {type:'CALL',from:account,to:token,value:'0x0',calls:[]};
 if(method==='eth_simulateV1'){
  const call=params[0].blockStateCalls[0].calls[0],approve=call.data.startsWith('0x095ea7b3'),amount=BigInt('0x'+call.data.slice(74)),target='0x'+call.data.slice(34,74);
  const log={address:token,topics:[keccak256(toHex(approve?'Approval(address,address,uint256)':'Transfer(address,address,uint256)')),topic(account),topic(target)],data:word(amount)};
  const after=approve?[amount]:[1000n-amount,200n+amount];
  return [{calls:[{status:'0x1',gasUsed:'0xc350',returnData:word(1n),logs:[log]},...after.map(n=>({status:'0x1',gasUsed:'0x100',returnData:word(n),logs:[]}))]}];
 }
 return undefined;
};
await f.h.restart();
console.log('Wallet browser backend ready: TEST_TRANSPORT, local RPC and model.');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await f.close();process.exit(0);});
