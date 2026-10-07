import { z } from 'zod';

// Separate from account-delivery evidence: these are pre-signing RPC observations.
export const WalletAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase());
export const WalletQuantitySchema = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/);
export const WalletLinkIdSchema = z.string().uuid();
export const WalletHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const Amount = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v => BigInt(v) < 2n ** 256n);
const FunctionSelector = z.string().regex(/^0x[0-9a-f]{8}$/);
export const WalletTransactionSchema = z.strictObject({
  chainId: WalletQuantitySchema, from: WalletAddressSchema, to: WalletAddressSchema,
  value: WalletQuantitySchema, data: z.string().regex(/^0x(?:[0-9a-f]{2})*$/).max(32770),
});
export const PreparedWalletTransactionSchema = WalletTransactionSchema.extend({
  nonce: WalletQuantitySchema, gas: WalletQuantitySchema,
  maxFeePerGas: WalletQuantitySchema, maxPriorityFeePerGas: WalletQuantitySchema,
});
const IntentBase = {
  account: WalletAddressSchema, chainId: WalletQuantitySchema, recipient: WalletAddressSchema,
  maxValueWei: Amount, maxTotalFeeWei: Amount,
};
export const ContractActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('erc20_transfer'), recipient: WalletAddressSchema, amount: Amount}),
  z.strictObject({kind: z.literal('erc20_approve'), spender: WalletAddressSchema, amount: Amount}),
]);
export const NativeWalletIntentSchema = z.strictObject({...IntentBase, operation: z.literal('native_transfer')});
export const ContractWalletIntentSchema = z.strictObject({...IntentBase, operation: z.literal('contract_call'), functionSelector: FunctionSelector, contractAction: ContractActionSchema});
export const WalletIntentSchema = z.discriminatedUnion('operation', [
  NativeWalletIntentSchema,
  ContractWalletIntentSchema,
]);
export const ConnectWalletSessionSchema = z.strictObject({
  account: WalletAddressSchema, chainId: WalletQuantitySchema,
  providerId: z.string().min(1).max(128).regex(/^[\w.-]+$/),
});
export const UpdateWalletSessionSchema = ConnectWalletSessionSchema.extend({
  revision: z.number().int().positive(), connected: z.boolean(),
});
export const WalletSessionSchema = ConnectWalletSessionSchema.extend({
  sessionId: WalletLinkIdSchema, revision: z.number().int().positive(), connected: z.boolean(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
  authority: z.literal('CLIENT_DECLARED'),
});
export const CreateWalletReviewSchema = z.strictObject({
  schemaVersion: z.literal('wallet-review-v2'),
  walletSessionId: WalletLinkIdSchema, walletSessionRevision: z.number().int().positive(),
  clientRequestId: z.string().min(1).max(100).regex(/^[\w-]+$/),
  transaction: WalletTransactionSchema, intent: WalletIntentSchema,
  traceId: WalletLinkIdSchema.optional(), parentAgentId: WalletLinkIdSchema.optional(), graphRunId: WalletLinkIdSchema.optional(),
});
export const WalletCheckSchema = z.strictObject({
  id: z.string(), status: z.enum(['PASS', 'FAIL', 'UNKNOWN']), reason: z.string(),
  source: z.enum(['HARD_RULE', 'RPC_OBSERVATION']), facts: z.record(z.string(), z.string()),
});
export const WalletStateObservationSchema = z.strictObject({
  blockNumber:WalletQuantitySchema, blockHash:WalletHashSchema,
  senderBalance:Amount, recipientBalance:Amount, senderNonce:WalletQuantitySchema,
});
export const WalletObservedTransactionSchema = PreparedWalletTransactionSchema.extend({
  hash:WalletHashSchema, blockNumber:WalletQuantitySchema.nullable(), blockHash:WalletHashSchema.nullable(),
}).strict();
export const WalletObservedReceiptSchema = z.strictObject({
  transactionHash:WalletHashSchema, from:WalletAddressSchema, to:WalletAddressSchema,
  status:z.enum(['0x0','0x1']), blockNumber:WalletQuantitySchema, blockHash:WalletHashSchema,
  gasUsed:WalletQuantitySchema,
});
export const WalletReceiptReportSchema = z.strictObject({
  txHash:WalletHashSchema, transactionFound:z.boolean(),
  receiptStatus:z.enum(['UNKNOWN','SUCCESS','FAIL','REJECTED']),
  blockNumber:WalletQuantitySchema.nullable(),blockHash:WalletHashSchema.nullable(),gasUsed:WalletQuantitySchema.nullable(),
  error:z.string().max(160).nullable(), postStateStatus:z.enum(['NOT_CHECKED','UNKNOWN','POST_STATE_RECHECKED']).optional(),
});
export const WalletPostStateSchema = z.strictObject({
  senderBalanceBefore:Amount,senderBalanceAfter:Amount,senderBalanceDelta:z.string().regex(/^-?[0-9]+$/),
  recipientBalanceBefore:Amount,recipientBalanceAfter:Amount,recipientBalanceDelta:z.string().regex(/^-?[0-9]+$/),
  senderNonceBefore:WalletQuantitySchema,senderNonceAfter:WalletQuantitySchema,senderNonceDelta:z.string().regex(/^-?[0-9]+$/),
  receiptStatus:z.enum(['SUCCESS','FAIL']),blockNumber:WalletQuantitySchema,blockHash:WalletHashSchema,
  source:z.literal('RPC_OBSERVATION'),confirmation:z.literal('RECEIPT_CONFIRMED'),
});
export const WalletTokenStateSchema = z.strictObject({
  blockNumber: WalletQuantitySchema, blockHash: WalletHashSchema,
  values: z.array(Amount).min(1).max(2),
});
export const WalletTokenPostStateSchema = z.strictObject({
  token: WalletAddressSchema, owner: WalletAddressSchema, counterparty: WalletAddressSchema,
  operation: z.enum(['erc20_transfer','erc20_approve']), amount: Amount,
  before: WalletTokenStateSchema, after: WalletTokenStateSchema,
  deltas: z.array(z.string().regex(/^-?[0-9]+$/)).min(1).max(2),
  receiptEvent: z.enum(['MATCH','MISMATCH','NOT_EXPECTED']),
  stateComparison: z.enum(['MATCH','DIFFERENT','NOT_EXECUTED']),
  source: z.literal('RPC_OBSERVATION'), scope: z.literal('BLOCK_RANGE_NOT_TRANSACTION_CAUSAL'),
});
export const WalletReviewSchema = z.strictObject({
  schemaVersion: z.enum(['wallet-review-v1','wallet-review-v2']), reviewId: z.string(), clientRequestId: z.string(),
  walletSessionId: WalletLinkIdSchema.optional(), walletSessionRevision: z.number().int().positive().optional(),
  traceId: WalletLinkIdSchema.optional(), parentAgentId: WalletLinkIdSchema.optional(), graphRunId: WalletLinkIdSchema.optional(),
  inputDigest: z.string(), transactionDigest: z.string().nullable(),
  transaction: WalletTransactionSchema, intent: WalletIntentSchema,
  preparedTransaction: PreparedWalletTransactionSchema.nullable(),
  status: z.enum(['QUEUED', 'REVIEWING', 'ALLOWED', 'BLOCKED', 'UNCERTAIN', 'CONSUMED', 'CANCELLED', 'INTERRUPTED', 'EXPIRED']),
  reason: z.string(), createdAt: z.number(), expiresAt: z.number().nullable(),
  checks: z.array(WalletCheckSchema),
  events: z.array(z.strictObject({sequence: z.number(), kind: z.enum(['STATE','TOOL_START','TOOL_END']), name:z.string(), at:z.number()})),
  reviewer: z.strictObject({modelId:z.string(), source:z.enum(['LIVE','TEST_TRANSPORT']), verdict:z.enum(['ALLOW','BLOCK','UNCERTAIN']).nullable()}),
  usage: z.strictObject({requests:z.number(), inputTokens:z.number(), outputTokens:z.number(), cacheReadTokens:z.number(), cacheWriteTokens:z.number(), costUsd:z.number().nullable()}),
  // A preflight result is neither a transaction receipt nor a guarantee of future state.
  broadcastStatus: z.literal('NOT_BROADCAST_BY_SERVER'),
  receiptReport: WalletReceiptReportSchema.optional(),
  postState: WalletPostStateSchema.optional(),
  tokenPostState: WalletTokenPostStateSchema.optional(),
  evidenceRef:WalletHashSchema.optional(),
  // One challenge per review; confirmation records are set only after explicit client acknowledgement.
  confirmationNonce: WalletLinkIdSchema.optional(),
  userConfirmedAt: z.number().int().positive().optional(),
  userConfirmationDigest: WalletHashSchema.optional(),
  userOverride: z.strictObject({
    at: z.number().int().positive(), reasonCode: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    confirmationDigest: WalletHashSchema,
  }).optional(),
});
export const ConsumeWalletReviewSchema = z.strictObject({transaction: PreparedWalletTransactionSchema});
export const ConfirmWalletReviewSchema = z.strictObject({
  transactionDigest: WalletHashSchema,
  account: WalletAddressSchema,
  chainId: WalletQuantitySchema,
  confirmationNonce: WalletLinkIdSchema,
  walletSessionId: WalletLinkIdSchema, walletSessionRevision: z.number().int().positive(),
  // An adapter declaration, never proof of the person's identity or of a physical gesture.
  handwritingAcknowledged: z.literal(true),
});
export const OverrideWalletReviewSchema = ConfirmWalletReviewSchema.extend({
  acknowledgement: z.literal('CONTINUE_WITH_RISK'),
});
export const BroadcastWalletReviewSchema = z.strictObject({txHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)});
export const WalletMetaSchema = z.strictObject({
  configured:z.boolean(), reason:z.string(), supportedOperations:z.array(z.enum(['native_transfer','contract_call'])),
  networks:z.array(z.strictObject({chainId:WalletQuantitySchema, name:z.string(), maxValueWei:Amount, maxTotalFeeWei:Amount, nativeSymbol:z.string().optional(), ready:z.boolean()})),
  reviewSchemaVersion: z.literal('wallet-review-v2').optional(),
  confirmationRequired: z.boolean().optional(),
});
export const WalletReviewActionsSchema = z.strictObject({
  schemaVersion: z.literal('wallet-actions-v1'), reviewId: z.string(), evaluatedAt: z.number().int(),
  status: WalletReviewSchema.shape.status,
  executionState: z.enum(['REVIEWING','AWAITING_CONFIRMATION','AWAITING_RISK_CONFIRMATION','READY_TO_CONSUME','PERMIT_CONSUMED','EXPIRED','CANCELLED','INTERRUPTED','STOPPED','UNAVAILABLE']),
  reviewVerdict: z.enum(['ALLOW','BLOCK','UNCERTAIN']).nullable(),
  userDecision: z.enum(['NOT_CONFIRMED','CONFIRMED','CONTINUE_WITH_RISK']),
  decisionEffective: z.boolean(), validUntil: z.number().int().nullable(),
  actions: z.array(z.enum(['confirm','override','consume','cancel','report','recheck_receipt'])),
  reasonCodes: z.array(z.string().max(160)),
});
export const WalletReviewSummarySchema = z.strictObject({
  reviewId: z.string(), createdAt: z.number().int(), account: WalletAddressSchema, chainId: WalletQuantitySchema,
  operation: z.enum(['native_transfer','erc20_transfer','erc20_approve']),
  target: WalletAddressSchema, token: WalletAddressSchema.nullable(), amount: Amount,
  status: WalletReviewSchema.shape.status, reason: z.string(),
  reviewVerdict: z.enum(['ALLOW','BLOCK','UNCERTAIN']).nullable(),
  userDecision: WalletReviewActionsSchema.shape.userDecision,
  receiptStatus: z.enum(['NOT_REPORTED','UNKNOWN','SUCCESS','FAIL','REJECTED']),
  postStateStatus: z.enum(['NOT_CHECKED','UNKNOWN','POST_STATE_RECHECKED']),
  tokenOutcome: WalletTokenPostStateSchema.pick({receiptEvent:true,stateComparison:true,scope:true}).nullable(),
  evidenceRef: WalletHashSchema.nullable(),
});
export const WalletReviewListQuerySchema = z.strictObject({
  account: WalletAddressSchema.optional(), chainId: WalletQuantitySchema.optional(),
  status: WalletReviewSchema.shape.status.optional(),
  operation: WalletReviewSummarySchema.shape.operation.optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
export const WalletReviewPageSchema = z.strictObject({
  schemaVersion: z.literal('wallet-review-page-v1'), reviews: z.array(WalletReviewSummarySchema),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
});
export type WalletReviewActions = z.infer<typeof WalletReviewActionsSchema>;
export type WalletReviewSummary = z.infer<typeof WalletReviewSummarySchema>;
export type WalletReviewPage = z.infer<typeof WalletReviewPageSchema>;
// A separate DTO keeps existing review/history/action responses compatible with strict clients.
export const WalletReceiptWatchSchema = z.strictObject({
  schemaVersion:z.literal('wallet-receipt-watch-v1'), reviewId:WalletLinkIdSchema, txHash:WalletHashSchema,
  status:z.enum(['QUEUED','RUNNING','WAITING','COMPLETED','REJECTED','EXHAUSTED','STOPPED']),
  attempts:z.number().int().nonnegative(), maxAttempts:z.number().int().positive(),
  createdAt:z.number().int().positive(), updatedAt:z.number().int().positive(), deadlineAt:z.number().int().positive(),
  nextPollAt:z.number().int().positive().nullable(), lastPollAt:z.number().int().positive().nullable(),
  finishedAt:z.number().int().positive().nullable(), reason:z.string().regex(/^[A-Z0-9_]{1,160}$/),
});
export type WalletReceiptWatch = z.infer<typeof WalletReceiptWatchSchema>;
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;
export type PreparedWalletTransaction = z.infer<typeof PreparedWalletTransactionSchema>;
export type WalletIntent = z.infer<typeof WalletIntentSchema>;
export type WalletReview = z.infer<typeof WalletReviewSchema>;
export type WalletCheck = z.infer<typeof WalletCheckSchema>;
export type WalletSession = z.infer<typeof WalletSessionSchema>;
export type WalletReceiptReport = z.infer<typeof WalletReviewSchema>['receiptReport'];
export type WalletPostState = z.infer<typeof WalletReviewSchema>['postState'];

// Local/private export for explicit exchange. Never put this packet in Agent Graph or A evidence.
const WalletEvidenceV1Schema = z.strictObject({
  version:z.literal('wallet-observation-v1'),chainId:z.literal('0x3c8'),nativeSymbol:z.literal('tBOT'),
  walletReviewId:WalletLinkIdSchema,traceId:WalletLinkIdSchema,
  observationSource:z.enum(['LIVE','TEST_TRANSPORT']),capturedAt:z.string().datetime(),
  intent:NativeWalletIntentSchema,preparedTransaction:PreparedWalletTransactionSchema,
  before:WalletStateObservationSchema,transaction:WalletObservedTransactionSchema,
  receipt:WalletObservedReceiptSchema,after:WalletStateObservationSchema,postState:WalletPostStateSchema,
  authority:z.literal('RPC_OBSERVATION_ONLY'),
});
const WalletEvidenceV2Schema = WalletEvidenceV1Schema.extend({
  version: z.literal('wallet-observation-v2'), intent: ContractWalletIntentSchema,
  tokenPostState: WalletTokenPostStateSchema,
});
const WalletEvidenceV3Schema=WalletEvidenceV1Schema.extend({
  version:z.literal('wallet-observation-v3'),chainId:WalletQuantitySchema,nativeSymbol:z.string().min(1).max(12),
  intent:WalletIntentSchema,tokenPostState:WalletTokenPostStateSchema.optional(),
}).refine(b=>(b.intent.operation==='contract_call')===(b.tokenPostState!==undefined)&&b.chainId===b.preparedTransaction.chainId&&b.chainId===b.intent.chainId);
export const WalletEvidenceBodySchema = z.discriminatedUnion('version',[WalletEvidenceV1Schema,WalletEvidenceV2Schema,WalletEvidenceV3Schema]);
export const WalletEvidencePacketSchema=z.strictObject({evidenceRef:WalletHashSchema,body:WalletEvidenceBodySchema});
export const ReplayWalletEvidenceSchema=z.strictObject({packet:WalletEvidencePacketSchema});
export const WalletEvidenceReplaySchema=z.strictObject({
  evidenceRef:WalletHashSchema,integrity:z.enum(['VERIFIED','MISMATCH']),
  status:z.enum(['MATCH','MISMATCH','UNKNOWN']),reason:z.string(),
  authority:z.literal('RPC_OBSERVATION_ONLY'),reviewAndPermit:z.literal('NOT_REPLAYED'),
  observationSource:z.enum(['LIVE','TEST_TRANSPORT']),postState:WalletPostStateSchema.optional(),
  tokenPostState: WalletTokenPostStateSchema.optional(),
});
export type WalletStateObservation=z.infer<typeof WalletStateObservationSchema>;
export type WalletTokenPostState=z.infer<typeof WalletTokenPostStateSchema>;
export type WalletEvidencePacket=z.infer<typeof WalletEvidencePacketSchema>;
export type WalletEvidenceReplay=z.infer<typeof WalletEvidenceReplaySchema>;
export const WalletFinalityObservationSchema=z.strictObject({
  schemaVersion:z.literal('wallet-finality-v1'),reviewId:WalletLinkIdSchema,txHash:WalletHashSchema,checkedAt:z.number().int().positive(),
  status:z.enum(['CONFIRMATIONS_MET','PENDING','REORG_DETECTED','UNKNOWN']),confirmations:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  requiredConfirmations:z.number().int().positive(),reason:z.string().max(160),authority:z.literal('RPC_OBSERVATION_ONLY'),
});
