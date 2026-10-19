import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
process.env.FILTARR_SECRET_KEY='1'.repeat(64);
process.env.FILTARR_DB=`/tmp/filtarr-security-${randomUUID()}.db`;
const security=await import('./security.js');
const data=await import('./db.js');
describe('scoped API tokens',()=>{
  const userId=randomUUID();
  beforeAll(()=>{data.run('INSERT INTO users(id,plex_id,name,role,status,grants,created_at) VALUES(?,?,?,?,?,?,?)',userId,randomUUID(),'Alex','editor','active',JSON.stringify([{capability:'rules.view',rules:['rule-a'],connections:'all',destinations:'all',roots:'all'}]),data.now());});
  it('cannot expand an existing scoped grant',()=>{const user={id:userId,name:'Alex',role:'editor',status:'active',grants:[{capability:'rules.view',rules:['rule-a'],connections:'all',destinations:'all',roots:'all'}],via:'session' as const};expect(()=>security.validateTokenGrants(user as any,[{capability:'rules.view',rules:'all',connections:'all',destinations:'all',roots:'all'}])).toThrow();});
  it('grants only the intersection of token and current user access',()=>{const grants=[{capability:'rules.view' as const,rules:['rule-a'],connections:'all' as const,destinations:'all' as const,roots:'all' as const}];const result=security.createToken(userId,'Automation',grants,new Date(Date.now()+86400000).toISOString());const request={headers:{authorization:`Bearer ${result.token}`},cookies:{}} as any;const actor=security.authenticate(request)!;expect(security.allowed(actor,'rules.view',{ruleId:'rule-a'})).toBe(true);expect(security.allowed(actor,'rules.view',{ruleId:'rule-b'})).toBe(false);data.run('UPDATE users SET grants=? WHERE id=?','[]',userId);expect(security.allowed(security.authenticate(request),'rules.view',{ruleId:'rule-a'})).toBe(false);});
  it('rejects an invalid bearer token even when a session cookie is present',()=>{expect(security.authenticate({headers:{authorization:'Bearer invalid'},cookies:{filtarr_session:'anything'}} as any)).toBeNull();});
});
