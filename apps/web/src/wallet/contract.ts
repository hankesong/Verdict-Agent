import { encodeFunctionData } from 'viem';
import { WalletAddressSchema } from '@verdict/protocol';
export function tokenCall(kind:'erc20_transfer'|'erc20_approve',target:string,amount:string) {
  const address=WalletAddressSchema.parse(target);
  if(!/^(0|[1-9][0-9]*)$/.test(amount)||BigInt(amount)>=2n**256n)throw Error('代币数量须为最小单位整数');
  const approve=kind==='erc20_approve';
  const abi=[{type:'function',name:approve?'approve':'transfer',stateMutability:'nonpayable',inputs:[{name:'target',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'success',type:'bool'}]}] as const;
  return encodeFunctionData({abi,functionName:approve?'approve':'transfer',args:[address as `0x${string}`,BigInt(amount)]});
}
