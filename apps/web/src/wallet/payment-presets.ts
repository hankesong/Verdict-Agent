import { z } from 'zod';
import { WalletAddressSchema, WalletQuantitySchema } from '@verdict/protocol';

const wei=z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value=>BigInt(value)<2n**256n);
const PresetSchema=z.object({id:z.string().uuid(),label:z.string().trim().min(1).max(80),account:WalletAddressSchema,chainId:WalletQuantitySchema,recipient:WalletAddressSchema,maxValueWei:wei,maxTotalFeeWei:wei,createdAt:z.number()});
export type PaymentPreset=z.infer<typeof PresetSchema>;

// Local saved inputs. The backend receives intent separately and remains the permission authority.
export function paymentPresetStore(namespace:string,persist:boolean){
  let values:PaymentPreset[]=[];
  try{if(persist)values=z.array(PresetSchema).max(100).parse(JSON.parse(localStorage.getItem(namespace)??'[]'));}catch{}
  function write(next:PaymentPreset[]){if(persist)localStorage.setItem(namespace,JSON.stringify(next));values=next;}
  return {
    list:(account:string|null,chainId:string|null)=>values.filter(p=>p.account===account&&p.chainId===chainId),
    add(input:Omit<PaymentPreset,'id'|'createdAt'>){
      if(values.length>=100)throw Error('最多保存 100 条付款条件');
      const preset=PresetSchema.parse({...input,id:crypto.randomUUID(),createdAt:Date.now()});
      write([preset,...values]);return preset;
    },
    remove(id:string){write(values.filter(p=>p.id!==id));},
  };
}
