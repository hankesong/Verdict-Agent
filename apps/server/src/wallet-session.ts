import { randomUUID } from 'node:crypto';
import { ConnectWalletSessionSchema, UpdateWalletSessionSchema, WalletSessionSchema, type WalletReview, type WalletSession } from '@verdict/protocol';
import type { ServerConfig } from './config.js';
import { Store, ApiError } from './store.js';

// Browser adapter state, not authentication. No wallet signature is needed to connect an account.
export class WalletSessions {
  constructor(private store: Store, private config: ServerConfig) {
    store.db.exec('CREATE TABLE IF NOT EXISTS wallet_sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    for (const row of store.db.prepare('SELECT body FROM wallet_sessions').all() as {body: string}[]) {
      const session = WalletSessionSchema.parse(JSON.parse(row.body));
      if (session.connected) { session.connected = false; session.revision++; session.updatedAt = Date.now(); this.save(session); }
    }
  }
  private supported(chainId: string) {
    if (!this.config.wallet?.networks.some(n => n.chainId === chainId)) throw new ApiError(400, 'CHAIN_OUT_OF_SCOPE');
  }
  create(raw: unknown) {
    const input = ConnectWalletSessionSchema.parse(raw); this.supported(input.chainId);
    const now = Date.now();
    const session: WalletSession = {...input, sessionId: randomUUID(), revision: 1, connected: true, createdAt: now, updatedAt: now, authority: 'CLIENT_DECLARED'};
    this.store.db.prepare('INSERT INTO wallet_sessions VALUES(?,?)').run(session.sessionId, JSON.stringify(session));
    return session;
  }
  get(id: string) {
    const row = this.store.db.prepare('SELECT body FROM wallet_sessions WHERE id=?').get(id) as {body: string} | undefined;
    if (!row) throw new ApiError(404, 'WALLET_SESSION_NOT_FOUND');
    return WalletSessionSchema.parse(JSON.parse(row.body));
  }
  private save(session: WalletSession) {
    this.store.db.prepare('UPDATE wallet_sessions SET body=? WHERE id=?').run(JSON.stringify(session), session.sessionId);
  }
  update(id: string, raw: unknown) {
    const input = UpdateWalletSessionSchema.parse(raw), previous = this.get(id);
    if (input.revision !== previous.revision) throw new ApiError(409, 'WALLET_SESSION_CHANGED');
    // An unsupported chain must still invalidate the old session and all old permits.
    const session: WalletSession = {...previous, ...input, revision: previous.revision + 1, updatedAt: Date.now()};
    this.save(session); return session;
  }
  assert(id: string, revision: number, account: string, chainId: string) {
    const session = this.get(id);
    if (!session.connected || session.revision !== revision || session.account !== account || session.chainId !== chainId) throw new ApiError(409, 'WALLET_SESSION_CHANGED');
    this.supported(chainId); return session;
  }
  assertReview(r: WalletReview) {
    if (r.schemaVersion !== 'wallet-review-v2' || !r.walletSessionId || !r.walletSessionRevision) throw new ApiError(409, 'WALLET_REVIEW_UPGRADE_REQUIRED');
    return this.assert(r.walletSessionId, r.walletSessionRevision, r.transaction.from, r.transaction.chainId);
  }
}
