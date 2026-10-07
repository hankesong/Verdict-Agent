import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {encodeAbiParameters,encodeFunctionData,erc20Abi,keccak256,toHex} from 'viem';
import {WalletEvidenceReplaySchema,WalletReceiptWatchSchema,type CreateWalletReviewSchema} from '@verdict/protocol';
import {z} from 'zod';
import {walletHarness,body,account,recipient} from '../../tests/integration/wallet-graph-harness.js';

const taskTools=resolve('.local/evm-tools/node_modules');
const wrapper=resolve(taskTools,'@foundry-rs/anvil/bin.mjs');
if(!existsSync(wrapper))throw Error('Install the documented local Anvil/solc tools in .local/evm-tools first.');
const require=createRequire(import.meta.url);
const solc=require(resolve(taskTools,'solc')) as {compile(input:string):string;version():string};
const source=readFileSync(new URL('./fixtures/ReviewToken.sol',import.meta.url),'utf8');
const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'ReviewToken.sol':{content:source}},settings:{evmVersion:'cancun',outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}})));
assert.ok(!output.errors?.some((e:{severity:string})=>e.severity==='error'),JSON.stringify(output.errors));
const runtime='0x'+output.contracts['ReviewToken.sol'].ReviewToken.evm.deployedBytecode.object;
const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
const child=spawn(process.execPath,[wrapper,'--host','127.0.0.1','--port',String(port),'--chain-id','968','--accounts','0','--silent'],{stdio:'ignore'});
let childError:Error|undefined;child.on('error',e=>{childError=e;});
const endpoint=`http://127.0.0.1:${port}`;
const rpc=async(method:string,params:unknown[])=>{
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(3000)});
  const data=await response.json() as {error?:unknown;result?:unknown};if(data.error)throw Error(`${method}: ${JSON.stringify(data.error)}`);return data.result;
};
let f:Awaited<ReturnType<typeof walletHarness>>|undefined;
let verifier:Awaited<ReturnType<typeof walletHarness>>|undefined;
try{
  let ready=false;for(let i=0;i<50;i++){if(childError)throw childError;try{await rpc('eth_chainId',[]);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(ready,'local EVM did not start');
  const token='0x'+'3'.repeat(40),spender='0x'+'4'.repeat(40);
  // Synthetic loopback-only state. No private key or public-network transaction.
  await rpc('anvil_setBalance',[account,toHex(10n**20n)]);
  await rpc('anvil_setCode',[token,runtime]);
  const balanceSlot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[account as `0x${string}`,0n]));
  await rpc('anvil_setStorageAt',[token,balanceSlot,toHex(1000n,{size:32})]);
  await rpc('evm_mine',[]);
  f=await walletHarness();
  f.h.config.wallet!.rpcTimeoutMs=3000;f.h.config.wallet!.reviewTimeoutMs=15000;f.h.config.wallet!.permitTtlMs=30000;
  Object.assign(f.h.config.wallet!.receiptTracking,{pollIntervalMs:100,maxAttempts:8,maxDurationMs:10000});
  f.h.config.wallet!.networks[0].maxTotalFeeWei='10000000000000000';
  f.h.config.wallet!.contractCalls.enabled=true;
  f.h.config.wallet!.networks[0].tokens=[{address:token,codeHash:keccak256(runtime as `0x${string}`),maxTransferAmount:'1000',maxApprovalAmount:'1000',approvedSpenders:[spender]}];
  f.rpcState.handler=async(method,params)=>rpc(method,params);
  verifier=await walletHarness();
  const verifierRpcEnv=verifier.h.config.wallet!.networks[0].rpcUrlEnv;
  verifier.h.config.wallet=structuredClone(f.h.config.wallet);
  verifier.h.config.wallet!.networks[0].rpcUrlEnv=verifierRpcEnv;
  verifier.rpcState.handler=async(method,params)=>rpc(method,params);
  // Load the copied local policy while retaining the verifier's own store and RPC configuration.
  await verifier.h.restart();
  assert.notEqual(f.h.app.engine.store.dir,verifier.h.app.engine.store.dir);
  await rpc('anvil_impersonateAccount',[account]);
  const results=[];
  for(const approve of [false,true]){
    const input:z.infer<typeof CreateWalletReviewSchema>={...body(),clientRequestId:randomUUID(),
      transaction:{chainId:'0x3c8',from:account,to:token,value:'0x0',data:encodeFunctionData({abi:erc20Abi,functionName:approve?'approve':'transfer',args:[(approve?spender:recipient) as `0x${string}`,100n]})},
      intent:{account,chainId:'0x3c8',recipient:token,maxValueWei:'0',maxTotalFeeWei:'10000000000000000',operation:'contract_call',functionSelector:approve?'0x095ea7b3':'0xa9059cbb',contractAction:approve?{kind:'erc20_approve',spender,amount:'100'}:{kind:'erc20_transfer',recipient,amount:'100'}}};
    const r=await f.create(input);assert.equal(r.status,'ALLOWED',JSON.stringify({reason:r.reason,checks:r.checks}));
    await f.confirm(r);const response=await f.api(`/api/wallet/reviews/${r.reviewId}/consume`,{transaction:r.preparedTransaction});assert.equal(response.code,200,JSON.stringify(response.data));
    const facts=r.checks.find(c=>c.id==='preflight')!.facts;
    assert.equal(facts.after,approve?'100':'900,100');
    const probe=encodeFunctionData({abi:erc20Abi,functionName:approve?'allowance':'balanceOf',args:approve?[account as `0x${string}`,spender as `0x${string}`]:[account as `0x${string}`]});
    const unchanged=await rpc('eth_call',[{to:token,data:probe},'latest']);
    assert.equal(BigInt(unchanged as string),approve?0n:1000n,'review and consume must not mutate EVM state');
    // Only this test driver sends to its own Anvil. The backend only consumes and observes.
    await rpc('evm_setAutomine',[false]);
    const txHash=await rpc('eth_sendTransaction',[r.preparedTransaction]);
    assert.match(String(txHash),/^0x[0-9a-f]{64}$/);
    const initialReport=await f.api(`/api/wallet/reviews/${r.reviewId}/broadcast`,{txHash});
    assert.equal(initialReport.code,200);assert.equal(initialReport.data.receiptReport.receiptStatus,'UNKNOWN');
    const watchPath=`/api/wallet/reviews/${r.reviewId}/receipt/watch`;
    assert.equal((await f.api(watchPath,{})).code,202);
    let observedPending=false;
    for(let i=0;i<200;i++){
      const w=WalletReceiptWatchSchema.parse((await f.api(watchPath)).data);
      if(w.status==='WAITING'&&w.attempts>=1){observedPending=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(observedPending,'watch must observe pending EVM state before mining');
    await rpc('evm_mine',[]);await rpc('evm_setAutomine',[true]);
    let completed=false;
    for(let i=0;i<200;i++){
      const w=WalletReceiptWatchSchema.parse((await f.api(watchPath)).data);
      if(w.status==='COMPLETED'){completed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(completed,'watch must independently observe the mined transaction');
    const reported=await f.api(`/api/wallet/reviews/${r.reviewId}`);
    assert.equal(reported.code,200,JSON.stringify(reported.data));
    assert.equal(reported.data.receiptReport.receiptStatus,'SUCCESS',JSON.stringify(reported.data.receiptReport));
    assert.equal(reported.data.tokenPostState?.receiptEvent,'MATCH',JSON.stringify(reported.data));
    assert.equal(reported.data.tokenPostState.stateComparison,'MATCH');
    assert.deepEqual(reported.data.tokenPostState.after.values,approve?['100']:['900','100']);
    const packet=await f.api('/api/wallet/evidence/'+reported.data.evidenceRef);assert.equal(packet.code,200);
    const replayResponse:{code:number;data:unknown}=await verifier.api('/api/wallet/evidence/replay',{packet:packet.data});
    assert.equal(replayResponse.code,200);const replay=WalletEvidenceReplaySchema.parse(replayResponse.data);
    assert.equal(replay.status,'MATCH',JSON.stringify(replay));
    assert.equal(replay.reviewAndPermit,'NOT_REPLAYED');
    assert.equal((await verifier.api('/api/wallet/reviews/'+r.reviewId)).code,404,'replay must not import signing permission');
    results.push({operation:approve?'erc20_approve':'erc20_transfer',status:r.status,before:facts.before,simulatedAfter:facts.after,gas:r.preparedTransaction?.gas,
      localTxHash:txHash,receipt:reported.data.receiptReport.receiptStatus,observedAfter:reported.data.tokenPostState.after.values,replay:replay.status,watch:'PENDING_TO_COMPLETED'});
  }
  const balance=await rpc('eth_call',[{to:token,data:encodeFunctionData({abi:erc20Abi,functionName:'balanceOf',args:[account as `0x${string}`]})},'latest']);
  assert.equal(BigInt(balance as string),900n,'only the explicit local transfer changes the balance');
  assert.ok(!f.rpcState.calls.some(c=>/send|sign/i.test(c.method)));
  assert.ok(!verifier.rpcState.calls.some(c=>/send|sign/i.test(c.method)));
  console.log(JSON.stringify({rpcSource:'LOCAL_ANVIL_EVM',modelSource:'TEST_TRANSPORT',solc:solc.version(),results,simulationDidNotMutateState:true,backendBroadcasts:0,localTestDriverBroadcasts:2},null,2));
}finally{
  if(f)await f.close();
  if(verifier)await verifier.close();
  child.kill('SIGTERM');
  await new Promise<void>(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();const timer=setTimeout(()=>{child.kill('SIGKILL');r();},2000);child.once('exit',()=>{clearTimeout(timer);r();});});
}
