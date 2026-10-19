import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { db, all, audit, getSetting, hash, now, one, run, setSetting, uid, type Row } from './db.js';
import type { FastifyRequest } from 'fastify';

export type Capability = 'rules.view'|'rules.create'|'rules.edit'|'rules.delete'|'rules.preview'|'rules.publish'|'rules.enable'|'rules.run'|'runs.view'|'runs.cancel'|'activity.view'|'activity.export'|'media.view'|'media.refresh'|'media.override'|'actions.move'|'actions.tags'|'actions.monitor'|'tokens.create'|'connections.view'|'connections.manage'|'destinations.view'|'destinations.manage'|'schedules.view'|'schedules.manage'|'people.manage'|'metrics.view';
export interface Grant { capability: Capability; rules?: string[] | 'all' | 'mine'; connections?: string[] | 'all'; destinations?: string[] | 'all'; roots?: string[] | 'all' }
export interface Actor { id: string; name: string; role: string; status: string; grants: Grant[]; tokenId?: string; tokenGrants?: Grant[]; via: 'session'|'token' }
const presets: Record<string, Capability[]> = {
  viewer: ['rules.view','runs.view','activity.view','media.view','connections.view','destinations.view','schedules.view','metrics.view'],
  editor: ['rules.view','rules.create','rules.edit','runs.view','activity.view','media.view','connections.view','destinations.view','schedules.view','metrics.view'],
  operator: ['rules.view','rules.preview','rules.run','runs.view','runs.cancel','activity.view','media.view','connections.view','destinations.view','schedules.view','metrics.view']
};
export function preset(role: string): Grant[] { return (presets[role] ?? []).map(capability => ({ capability, rules: 'all', connections: 'all', destinations: 'all', roots: 'all' })); }
export const secureEqual = (a: string, b: string) => { const x=Buffer.from(a); const y=Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); };
const key = process.env.FILTARR_SECRET_KEY;
if (!key || !/^[a-f\d]{64}$/i.test(key)) throw Error('FILTARR_SECRET_KEY must contain exactly 64 hexadecimal characters');
const secretKey = Buffer.from(key, 'hex');
export function encrypt(plain: string) { const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',secretKey,iv); const data=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]); return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join(':'); }
export function decrypt(value: string) { const [iv,tag,data]=value.split(':'); if (!iv||!tag||!data) throw Error('Invalid encrypted value'); const cipher=createDecipheriv('aes-256-gcm',secretKey,Buffer.from(iv,'hex')); cipher.setAuthTag(Buffer.from(tag,'hex')); return Buffer.concat([cipher.update(Buffer.from(data,'hex')),cipher.final()]).toString('utf8'); }
export function createToken(userId: string, name: string, grants: Grant[], expiresAt: string | null) {
  const id=uid().replace(/-/g,'').slice(0,16); const secret=randomBytes(32).toString('base64url');
  run('INSERT INTO api_tokens(id,user_id,name,secret_hash,grants,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',id,userId,name,hash(secret),JSON.stringify(grants),expiresAt,now());
  return { id, token:`filtarr_${id}_${secret}` };
}
function userActor(user: Row, via: 'session'|'token', token?: Row): Actor { return { id:user.id,name:user.name,role:user.role,status:user.status,grants:JSON.parse(user.grants),tokenId:token?.id,tokenGrants:token ? JSON.parse(token.grants) : undefined,via }; }
export function authenticate(req: FastifyRequest): Actor | null {
  const authorization=req.headers.authorization;
  if (authorization !== undefined) {
    const match=/^Bearer filtarr_([a-f0-9]{16})_([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) return null;
    const token=one('SELECT * FROM api_tokens WHERE id=?',match[1]);
    if (!token || token.revoked_at || (token.expires_at && token.expires_at <= now()) || !secureEqual(token.secret_hash,hash(match[2]!))) return null;
    const user=one('SELECT * FROM users WHERE id=?',token.user_id);
    if (!user || user.status !== 'active') return null;
    run('UPDATE api_tokens SET last_used_at=? WHERE id=?',now(),token.id);
    return userActor(user,'token',token);
  }
  const sid=req.cookies?.filtarr_session;
  if (!sid) return null;
  const session=one('SELECT * FROM sessions WHERE id_hash=? AND expires_at>?',hash(sid),now());
  if (!session) return null;
  const user=one('SELECT * FROM users WHERE id=?',session.user_id);
  return user ? userActor(user,'session') : null;
}
export interface Resource { ruleId?: string; ruleCreatorId?: string; connectionId?: string; destinationId?: string; root?: string }
function grantMatches(g: Grant, resource: Resource, actorId: string): boolean {
  if (resource.ruleId && g.rules !== 'all' && !(Array.isArray(g.rules) && g.rules.includes(resource.ruleId)) && !(g.rules === 'mine' && resource.ruleCreatorId === actorId)) return false;
  if (resource.connectionId && g.connections !== 'all' && !(Array.isArray(g.connections) && g.connections.includes(resource.connectionId))) return false;
  if (resource.destinationId && g.destinations !== 'all' && !(Array.isArray(g.destinations) && g.destinations.includes(resource.destinationId))) return false;
  if (resource.root && g.roots !== 'all' && !(Array.isArray(g.roots) && g.roots.includes(resource.root))) return false;
  return true;
}
export function allowed(actor: Actor | null, capability: Capability, resource: Resource = {}): boolean {
  if (!actor || actor.status !== 'active') return false;
  const userAllowed = actor.role === 'owner' || actor.grants.some(g => g.capability === capability && grantMatches(g,resource,actor.id));
  return userAllowed && (!actor.tokenGrants || actor.tokenGrants.some(g => g.capability === capability && grantMatches(g,resource,actor.id)));
}
export function sessionOnly(actor: Actor | null): boolean { return !!actor && actor.via === 'session' && actor.status === 'active'; }
export function createSession(userId: string): string { const raw=randomBytes(32).toString('base64url'); run('INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,?)',hash(raw),userId,new Date(Date.now()+7*86400000).toISOString()); return raw; }
export function ensureSetupToken(): string | undefined {
  if (one('SELECT id FROM users WHERE role=?','owner')) return;
  const env=process.env.FILTARR_SETUP_TOKEN;
  if (env) { setSetting('setup_token_hash',hash(env)); return env; }
  if (getSetting('setup_token_hash')) return;
  const raw=randomBytes(24).toString('base64url'); setSetting('setup_token_hash',hash(raw)); return raw;
}
export function revokeUserSessions(userId: string) { run('DELETE FROM sessions WHERE user_id=?',userId); }
export const capabilities: Capability[] = ['rules.view','rules.create','rules.edit','rules.delete','rules.preview','rules.publish','rules.enable','rules.run','runs.view','runs.cancel','activity.view','activity.export','media.view','media.refresh','media.override','actions.move','actions.tags','actions.monitor','tokens.create','connections.view','connections.manage','destinations.view','destinations.manage','schedules.view','schedules.manage','people.manage','metrics.view'];
function dimensionWithin(requested: string[]|'all'|'mine'|undefined, held: string[]|'all'|'mine'|undefined, mineAllowed=false): boolean {
  if (held==='all') return true;
  if (requested===undefined) return held===undefined;
  if (requested==='all') return false;
  if (requested==='mine') return mineAllowed && held==='mine';
  if (!Array.isArray(requested)) return false;
  return Array.isArray(held) && requested.every(id=>held.includes(id));
}
export function grantWithin(requested: Grant, held: Grant): boolean {
  return requested.capability===held.capability && dimensionWithin(requested.rules,held.rules,true) && dimensionWithin(requested.connections,held.connections) && dimensionWithin(requested.destinations,held.destinations) && dimensionWithin(requested.roots,held.roots);
}
export function validateTokenGrants(actor: Actor, requested: Grant[]): void {
  const forbidden:Capability[]=['tokens.create','people.manage','connections.manage','destinations.manage','schedules.manage'];
  for (const grant of requested) {
    if (!capabilities.includes(grant.capability) || forbidden.includes(grant.capability)) throw Error(`Token cannot grant ${grant.capability}`);
    if (actor.role!=='owner' && !actor.grants.some(held=>grantWithin(grant,held))) throw Error(`Token scope exceeds your access: ${grant.capability}`);
  }
}
