import {z} from 'zod';
import {WalletAddressSchema,WalletQuantitySchema,WalletHashSchema,WalletLinkIdSchema,WalletTransactionSchema,PreparedWalletTransactionSchema} from './wallet.js';

export const DefenseIdSchema=z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
export const DefenseAmountSchema=z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v=>BigInt(v)<2n**256n);
export const DefenseRoleSchema=z.enum(['OWNER','AGENT','EXECUTOR']);
export const PaymentPolicySchema=z.strictObject({
  account:WalletAddressSchema,chainId:WalletQuantitySchema,
  operation:z.enum(['native_transfer','erc20_transfer','erc20_approve']),token:WalletAddressSchema.nullable(),
  recipient:WalletAddressSchema,maxAmountPerTransaction:DefenseAmountSchema,maxTotalAmount:DefenseAmountSchema,
  maxFeePerTransaction:DefenseAmountSchema,maxTotalFee:DefenseAmountSchema,maxTransactions:z.number().int().min(1).max(10000),
  validFrom:z.number().int().positive(),expiresAt:z.number().int().positive(),
}).refine(p=>p.expiresAt>p.validFrom&&BigInt(p.maxAmountPerTransaction)<=BigInt(p.maxTotalAmount)&&BigInt(p.maxFeePerTransaction)<=BigInt(p.maxTotalFee))
  .refine(p=>(p.operation==='native_transfer')===(p.token===null));
export const CreatePaymentAuthorizationSchema=z.strictObject({clientRequestId:DefenseIdSchema,label:z.string().min(1).max(100),policy:PaymentPolicySchema,confirmed:z.literal(true)});
export const RevisePaymentAuthorizationSchema=CreatePaymentAuthorizationSchema.omit({clientRequestId:true}).extend({expectedVersion:z.number().int().positive()});
export const PaymentAuthorizationSchema=z.strictObject({
  schemaVersion:z.literal('payment-authorization-v1'),authorizationId:WalletLinkIdSchema,version:z.number().int().positive(),
  tenantId:DefenseIdSchema,ownerId:DefenseIdSchema,label:z.string().max(100),policy:PaymentPolicySchema,
  digest:WalletHashSchema,createdAt:z.number().int().positive(),status:z.enum(['ACTIVE','REVOKED','SUPERSEDED']),
});
export const PaymentLineSchema=z.strictObject({paymentRef:DefenseIdSchema,invoiceDigest:WalletHashSchema,materialDigests:z.array(WalletHashSchema).max(8),maxAmount:DefenseAmountSchema});
export const CreatePaymentTaskSchema=z.strictObject({
  clientRequestId:DefenseIdSchema,authorizationId:WalletLinkIdSchema,authorizationVersion:z.number().int().positive(),authorizationDigest:WalletHashSchema,
  agentId:DefenseIdSchema,executorId:DefenseIdSchema,walletSessionId:WalletLinkIdSchema,walletSessionRevision:z.number().int().positive(),
  maxTotalAmount:DefenseAmountSchema,maxTotalFee:DefenseAmountSchema,maxTransactions:z.number().int().min(1).max(64),expiresAt:z.number().int().positive(),
  payments:z.array(PaymentLineSchema).min(1).max(64),
}).refine(t=>new Set(t.payments.map(p=>p.paymentRef)).size===t.payments.length&&new Set(t.payments.map(p=>p.invoiceDigest)).size===t.payments.length);
export const PaymentTaskSchema=CreatePaymentTaskSchema.safeExtend({
  schemaVersion:z.literal('payment-task-v1'),taskId:WalletLinkIdSchema,tenantId:DefenseIdSchema,ownerId:DefenseIdSchema,
  createdAt:z.number().int().positive(),status:z.enum(['ACTIVE','CANCELLED']),
});
export const CreatePaymentProposalSchema=z.strictObject({
  clientRequestId:DefenseIdSchema,taskId:WalletLinkIdSchema,paymentRef:DefenseIdSchema,
  invoiceDigest:WalletHashSchema,materialDigests:z.array(WalletHashSchema).max(8),
  transaction:WalletTransactionSchema,explanation:z.string().max(1000).default(''),
});
export const PaymentDifferenceSchema=z.strictObject({field:z.string().max(80),code:z.string().regex(/^[A-Z0-9_]{1,80}$/),expected:z.string().max(160),actual:z.string().max(160)});
export const PaymentProposalSchema=CreatePaymentProposalSchema.extend({
  schemaVersion:z.literal('payment-proposal-v1'),proposalId:WalletLinkIdSchema,tenantId:DefenseIdSchema,agentId:DefenseIdSchema,
  authorizationId:WalletLinkIdSchema,authorizationVersion:z.number().int().positive(),authorizationDigest:WalletHashSchema,
  createdAt:z.number().int().positive(),status:z.enum(['BLOCKED','REVIEW_CREATED','CANCELLED']),
  differences:z.array(PaymentDifferenceSchema),reviewId:WalletLinkIdSchema.nullable(),
  explanationAuthority:z.literal('UNTRUSTED_AGENT_DECLARATION'),
});
export const DefenseRevokeAuthorizationSchema=z.strictObject({expectedVersion:z.number().int().positive()});
export const ExecutionGrantSchema=z.strictObject({
  schemaVersion:z.literal('execution-grant-v1'),grantId:WalletLinkIdSchema,proposalId:WalletLinkIdSchema,reviewId:WalletLinkIdSchema,
  taskId:WalletLinkIdSchema,tenantId:DefenseIdSchema,executorId:DefenseIdSchema,authorizationId:WalletLinkIdSchema,
  authorizationVersion:z.number().int().positive(),authorizationDigest:WalletHashSchema,transactionDigest:WalletHashSchema,
  transaction:PreparedWalletTransactionSchema,consumedAt:z.number().int().positive(),expiresAt:z.number().int().positive(),
  authority:z.literal('ONLINE_SERVER_CONSUMPTION_RECORD'),
});
export type PaymentPolicy=z.infer<typeof PaymentPolicySchema>;
export type PaymentAuthorization=z.infer<typeof PaymentAuthorizationSchema>;
export type PaymentTask=z.infer<typeof PaymentTaskSchema>;
export type PaymentProposal=z.infer<typeof PaymentProposalSchema>;
export type PaymentDifference=z.infer<typeof PaymentDifferenceSchema>;
export type ExecutionGrant=z.infer<typeof ExecutionGrantSchema>;
