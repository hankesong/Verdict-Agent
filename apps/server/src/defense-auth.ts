import {createHash,timingSafeEqual} from 'node:crypto';
import type {ServerConfig} from './config.js';
import {ApiError} from './store.js';

export type DefensePrincipal=NonNullable<ServerConfig['defense']>['principals'][number];
export function requireRole(p:DefensePrincipal,...roles:DefensePrincipal['role'][]){
  if(!roles.includes(p.role))throw new ApiError(403,'DEFENSE_ROLE_FORBIDDEN');
}
export function authenticateDefense(config:ServerConfig,authorization:string|undefined):DefensePrincipal{
  if(!config.defense)throw new ApiError(503,'DEFENSE_NOT_CONFIGURED');
  const entries=config.defense.principals.filter(p=>!p.disabled).map(p=>({p,token:process.env[p.tokenEnv]}));
  const valid=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(s);
  if(entries.some(e=>!valid(e.token))||new Set(entries.map(e=>e.token)).size!==entries.length)throw new ApiError(503,'DEFENSE_CREDENTIALS_UNAVAILABLE');
  if(!authorization?.startsWith('Bearer ')||!valid(authorization.slice(7)))throw new ApiError(401,'DEFENSE_AUTH_REQUIRED');
  const hash=(s:string)=>createHash('sha256').update(s).digest(),given=hash(authorization.slice(7));
  const matched=entries.find(e=>timingSafeEqual(given,hash(e.token!)));
  if(!matched)throw new ApiError(401,'DEFENSE_AUTH_REQUIRED');return matched.p;
}
