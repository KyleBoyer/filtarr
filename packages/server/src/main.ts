import './env.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { randomBytes } from 'node:crypto';
import { nextScheduleRun } from './schedule.js';
import { z, ZodError } from 'zod';
import { ageRating, fieldByKey, fields, operators, parseRootTarget, plan, starterRules, type RuleDocument } from '@filtarr/core';
import { all, audit, db, getSetting, hash, now, one, run, setSetting, uid, type Row } from './db.js';
import { allowed, authenticate, capabilities, createSession, createToken, decrypt, encrypt, ensureSetupToken, preset, revokeUserSessions, secureEqual, sessionOnly, validateTokenGrants, type Actor, type Capability, type Grant } from './security.js';
import { arrRequest, connections, detectArr, getConnection, normalizeMedia, roots, targetPath, testConnection } from './arr.js';
import { discoverServers, locate, plexSections, plexSettings } from './plex.js';
import { actorById, authorizeRules, compactPlans, createRun, inventory, preflight, publishedRules, ruleFields, startWorker, stopWorker, suggestions } from './worker.js';
import { clearSourceCache, omdbTest, tautulliCall, tautulliSettings } from './sources.js';

const app=Fastify({logger:{level:process.env.LOG_LEVEL??'info',redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']},trustProxy:process.env.FILTARR_TRUST_PROXY==='true'});
await app.register(cookie);
await app.register(rateLimit,{max:120,timeWindow:'1 minute',keyGenerator:req=>req.ip});
await app.register(swagger,{hideUntagged:true,openapi:{info:{title:'Filtarr API',version:'1.0.0',description:'Rules, media, runs, activity, and access management.'},servers:[{url:'/'}],components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'Filtarr API token'}}},security:[{bearerAuth:[]}]}});
const configuredOrigin=process.env.FILTARR_PUBLIC_URL?new URL(process.env.FILTARR_PUBLIC_URL).origin:null;
// The origin the browser used (Host, or X-Forwarded-* with FILTARR_TRUST_PROXY), so LAN IPs and hostnames work without configuration.
// A configured public URL wins for its own host so a TLS-terminating proxy still yields https.
function requestOrigin(req:FastifyRequest){const host=req.host;if(configuredOrigin&&new URL(configuredOrigin).host===host)return configuredOrigin;return `${req.protocol}://${host}`;}
function sameOrigin(req:FastifyRequest){const origin=req.headers.origin;return !!origin&&(origin===requestOrigin(req)||origin===configuredOrigin);}
function actor(req: FastifyRequest): Actor { const value=(req as any).actor as Actor | null; if(!value||value.status!=='active')throw Object.assign(Error('Authentication required'),{statusCode:401});return value; }
function need(req:FastifyRequest,capability:Capability,resource:Parameters<typeof allowed>[2]={}):Actor { const a=actor(req);if(!allowed(a,capability,resource))throw Object.assign(Error('Permission denied'),{statusCode:403});return a; }
function owner(req:FastifyRequest):Actor { const a=actor(req); if(a.role!=='owner'||a.via!=='session')throw Object.assign(Error('Owner session required'),{statusCode:403});return a; }
function body<T>(schema:z.ZodType<T>,req:FastifyRequest):T {return schema.parse(req.body);}
const idParam=(req:FastifyRequest)=>String((req.params as any).id);
const paging=(req:FastifyRequest)=>{const q=req.query as any;return {limit:Math.min(100,Math.max(1,Number(q.limit)||30)),offset:Math.max(0,Number(q.offset)||0)};};
const actorInfo=(a:Actor)=>({id:a.id,name:a.name,tokenId:a.tokenId});
const json=(value:unknown)=>JSON.stringify(value);
const safe=(row:Row)=>{const {api_key_cipher,secret_hash,token_hash,setup_hash,...rest}=row;return rest;};
const secured=(req:FastifyRequest)=>req.url.startsWith('/api/v1')||req.url.startsWith('/api/docs')||req.url.startsWith('/api/openapi.json');
const actorLimits=new Map<string,{count:number;reset:number}>();
function withinActorLimit(key:string):number {
  const timestamp=Date.now(),entry=actorLimits.get(key);
  if(!entry||entry.reset<=timestamp){actorLimits.set(key,{count:1,reset:timestamp+60000});return 0;}
  if(entry.count>=120)return Math.max(1,Math.ceil((entry.reset-timestamp)/1000));
  entry.count++;return 0;
}
app.addHook('onRequest',async(req,reply)=>{
  if(req.url.startsWith('/auth/') && req.method==='POST' && req.url!=='/auth/plex/start'){
    const csrf=req.headers['x-filtarr-csrf'];
    if(!sameOrigin(req)||typeof csrf!=='string'||!req.cookies.filtarr_csrf||!secureEqual(csrf,req.cookies.filtarr_csrf))return reply.code(403).send({error:'CSRF validation failed',requestId:req.id});
  }
  if (!secured(req)) return;
  const explorerApi=req.url.startsWith('/api/v1') && !!req.headers['x-filtarr-api-explorer'];
  const a=explorerApi && !req.headers.authorization ? null : authenticate(req);
  (req as any).actor=a;
  if (!a || a.status!=='active') return reply.code(401).send({error:'Authentication required',requestId:req.id});
  if(req.url.startsWith('/api/v1'))for(const key of [`user:${a.id}`,...(a.tokenId?[`token:${a.tokenId}`]:[])]){
    const retry=withinActorLimit(key);
    if(retry)return reply.header('Retry-After',String(retry)).code(429).send({error:'Rate limit exceeded',requestId:req.id});
  }
  if (req.url.startsWith('/api/docs') && a.via!=='session') return reply.code(403).send({error:'Plex session required for Swagger UI',requestId:req.id});
  if (a.via==='session' && !['GET','HEAD','OPTIONS'].includes(req.method)) {
    const csrf=req.headers['x-filtarr-csrf'];
    if (!sameOrigin(req) || typeof csrf!=='string' || !req.cookies.filtarr_csrf || !secureEqual(csrf,req.cookies.filtarr_csrf)) return reply.code(403).send({error:'CSRF validation failed',requestId:req.id});
  }
});
const appCsp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.addHook('onSend',async(req,reply,payload)=>{
  reply.header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','no-referrer').header('Cross-Origin-Opener-Policy','same-origin').header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  // Swagger UI ships inline scripts, so it only gets the framing restriction.
  reply.header('Content-Security-Policy',req.url.startsWith('/api/docs')?"frame-ancestors 'none'":appCsp);
  if(requestOrigin(req).startsWith('https:'))reply.header('Strict-Transport-Security','max-age=31536000');
  if(req.url.startsWith('/api/')||req.url.startsWith('/auth/'))reply.header('Cache-Control','no-store');
  return payload;
});
await app.register(swaggerUi,{routePrefix:'/api/docs',uiConfig:{persistAuthorization:false,docExpansion:'list',requestInterceptor:(request:any)=>{request.headers['X-Filtarr-Api-Explorer']='1';return request;}}});
app.addHook('onResponse',async(req,reply)=>{
  if(!req.url.startsWith('/api/v1'))return;
  const a=(req as any).actor as Actor | null;
  run('INSERT INTO api_metrics(day,actor_id,token_id,requests,errors,rate_limited) VALUES(?,?,?,?,?,?) ON CONFLICT(day,actor_id,token_id) DO UPDATE SET requests=requests+1,errors=errors+excluded.errors,rate_limited=rate_limited+excluded.rate_limited',new Date().toISOString().slice(0,10),a?.id??'',a?.tokenId??'',1,reply.statusCode>=400?1:0,reply.statusCode===429?1:0);
});
app.setErrorHandler((error,req,reply)=>{
  const err=error as Error & {statusCode?:number};
  // Plain Error throws are deliberate user-facing rejections; built-in error types (TypeError, SyntaxError...) are bugs.
  const status=error instanceof ZodError?400:err.statusCode??(/conflict/i.test(err.message)?409:err.constructor===Error?400:500);
  if (status===502) req.log.warn({err:error},'upstream service failed');
  else if (status>=500) req.log.error({err:error},'request failed');
  else req.log.info({statusCode:status,reason:err.message},'request rejected');
  const exposed=status<500||status===502;
  reply.code(status).send({error:exposed?err.message:'Internal error',requestId:req.id,issues:error instanceof ZodError?error.issues:undefined});
});
const grantSchema=z.object({capability:z.enum(capabilities as [Capability,...Capability[]]),rules:z.union([z.literal('all'),z.literal('mine'),z.array(z.string())]).optional(),connections:z.union([z.literal('all'),z.array(z.string())]).optional(),destinations:z.union([z.literal('all'),z.array(z.string())]).optional(),roots:z.union([z.literal('all'),z.array(z.string())]).optional()});
const stringField={type:'string'} as const;
const listSchema={querystring:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0}}},response:{200:{type:'array',items:{type:'object',additionalProperties:true}}}};
const paramSchema={params:{type:'object',required:['id'],properties:{id:stringField}}};
const ruleDocumentSchema={type:'object',required:['name','condition','actions'],properties:{name:{type:'string'},condition:{type:'object',additionalProperties:true},actions:{type:'array',items:{type:'object',additionalProperties:true}},stopProcessing:{type:'boolean'},connectionIds:{type:'array',items:{type:'string'}},mediaTypes:{type:'array',items:{type:'string',enum:['movie','series']}}},description:'Example: Kids movies with certification in G, PG; move to the Kids destination; stop processing.'};
const tokenBodySchema={type:'object',required:['name','grants'],properties:{name:{type:'string'},grants:{type:'array',items:{type:'object',required:['capability'],properties:{capability:{type:'string'},rules:{oneOf:[{type:'string'},{type:'array',items:{type:'string'}}]},connections:{oneOf:[{type:'string'},{type:'array',items:{type:'string'}}]},destinations:{oneOf:[{type:'string'},{type:'array',items:{type:'string'}}]},roots:{oneOf:[{type:'string'},{type:'array',items:{type:'string'}}]}}}},expiresAt:{type:['string','null']}},description:'Example: Home automation with a rules.view grant scoped to all rules, connections, destinations, and roots.'};


// Plex hosted authentication. The setup secret is required only for the first account.
const authLimit={rateLimit:{max:10,timeWindow:'1 minute'}};
app.post('/auth/plex/start',{config:authLimit,schema:{body:{type:'object',properties:{setupToken:{type:'string'}}}}},async(req,reply)=>{
  const input=z.object({setupToken:z.string().optional()}).parse(req.body??{});
  if (!one("SELECT id FROM users WHERE role='owner'")) {
    if (!input.setupToken||!secureEqual(hash(input.setupToken),getSetting('setup_token_hash')??'')) throw Object.assign(Error('Valid setup token required'),{statusCode:403});
  }
  const clientId=getSetting('plex_client_id')??uid();setSetting('plex_client_id',clientId);
  const pinResponse=await fetch('https://plex.tv/api/v2/pins',{method:'POST',headers:{Accept:'application/json','X-Plex-Client-Identifier':clientId,'X-Plex-Product':'Filtarr','Content-Type':'application/x-www-form-urlencoded'},body:'strong=true',signal:AbortSignal.timeout(15000)});
  if (!pinResponse.ok) throw Object.assign(Error('Plex sign-in is unavailable'),{statusCode:502});
  const pin=await pinResponse.json() as any;
  const state=randomBytes(24).toString('base64url');
  run('INSERT INTO plex_attempts(state,pin_id,code,setup_hash,expires_at) VALUES(?,?,?,?,?)',state,Number(pin.id),String(pin.code),input.setupToken?hash(input.setupToken):null,new Date(Date.now()+600000).toISOString());
  // Bind the attempt to this browser so a state value alone (from a crafted link or a log) cannot complete someone else's sign-in.
  reply.setCookie('filtarr_plex_state',state,{path:'/auth/plex',httpOnly:true,sameSite:'lax',secure:requestOrigin(req).startsWith('https:'),maxAge:600});
  const forwardUrl=`${requestOrigin(req)}/auth/plex/complete?state=${encodeURIComponent(state)}`;
  const query=new URLSearchParams({clientID:clientId,code:String(pin.code),forwardUrl});query.set('context[device][product]','Filtarr');
  return {url:`https://app.plex.tv/auth#?${query.toString()}`};
});
app.get('/auth/plex/complete',{schema:{querystring:{type:'object',required:['state'],properties:{state:stringField}}}},async(req,reply)=>{
  const state=String((req.query as any).state);
  const attempt=one('SELECT * FROM plex_attempts WHERE state=? AND expires_at>?',state,now());
  const bound=req.cookies.filtarr_plex_state;
  if (!attempt || !bound || !secureEqual(bound,state)) return reply.redirect('/?login=expired');
  const clientId=getSetting('plex_client_id')!;
  const pinResponse=await fetch(`https://plex.tv/api/v2/pins/${attempt.pin_id}`,{headers:{Accept:'application/json','X-Plex-Client-Identifier':clientId,'X-Plex-Product':'Filtarr'},signal:AbortSignal.timeout(15000)});
  const pin=await pinResponse.json() as any;
  if (!pin.authToken) return reply.redirect('/?login=pending');
  const userResponse=await fetch('https://plex.tv/api/v2/user',{headers:{Accept:'application/json','X-Plex-Token':pin.authToken,'X-Plex-Client-Identifier':clientId},signal:AbortSignal.timeout(15000)});
  if (!userResponse.ok) throw Object.assign(Error('Unable to verify Plex account'),{statusCode:502});
  const plex=await userResponse.json() as any;
  const plexId=String(plex.id??''); if (!plexId) throw Error('Plex did not provide account ID');
  const name=String(plex.title||plex.username||plex.email||`Plex user ${plexId}`);
  let user=one('SELECT * FROM users WHERE plex_id=?',plexId);
  db.transaction(()=>{
    run('DELETE FROM plex_attempts WHERE state=?',state);
    if (!user) {
      const isFirst=!one("SELECT id FROM users WHERE role='owner'");
      if (isFirst && attempt.setup_hash!==getSetting('setup_token_hash')) throw Error('Owner setup has changed');
      const id=uid();run('INSERT INTO users(id,plex_id,name,role,status,grants,created_at) VALUES(?,?,?,?,?,?,?)',id,plexId,name,isFirst?'owner':'viewer',isFirst?'active':'pending','[]',now());
      user=one('SELECT * FROM users WHERE id=?',id);
      if (isFirst) setSetting('setup_token_hash','claimed');
    } else run('UPDATE users SET name=? WHERE id=?',name,user.id);
    if (user!.role==='owner') setSetting('plex_account_token_cipher',encrypt(String(pin.authToken)));
    audit('auth.plex',{id:user!.id,name},'user',user!.id,{status:user!.status,ip:req.ip,userAgent:String(req.headers['user-agent']??'').slice(0,200)});
  })();
  reply.clearCookie('filtarr_plex_state',{path:'/auth/plex'});
  const session=createSession(user!.id);
  const csrf=randomBytes(24).toString('base64url');
  reply.setCookie('filtarr_session',session,{path:'/',httpOnly:true,sameSite:'strict',secure:requestOrigin(req).startsWith('https:'),maxAge:7*86400});
  reply.setCookie('filtarr_csrf',csrf,{path:'/',httpOnly:false,sameSite:'strict',secure:requestOrigin(req).startsWith('https:'),maxAge:7*86400});
  return reply.redirect('/');
});
app.get('/auth/me',async(req)=>{const a=authenticate(req);if(!a)return {status:'anonymous',setupRequired:!one("SELECT id FROM users WHERE role='owner'")};if(a.status!=='active')return {status:a.status,accessRequestStatus:one('SELECT status FROM access_requests WHERE user_id=?',a.id)?.status??'none'};return {id:a.id,name:a.name,role:a.role,status:a.status,grants:a.grants,via:a.via};});
app.post('/auth/logout',async(req,reply)=>{const sid=req.cookies.filtarr_session,a=authenticate(req);if(sid)db.transaction(()=>{run('DELETE FROM sessions WHERE id_hash=?',hash(sid));if(a)audit('auth.logout',actorInfo(a),'user',a.id);})();reply.clearCookie('filtarr_session',{path:'/'});reply.clearCookie('filtarr_csrf',{path:'/'});return {ok:true};});
app.post('/auth/request-access',{config:authLimit},async(req)=>{const a=authenticate(req);if(!a)throw Object.assign(Error('Plex login required'),{statusCode:401});if(a.status==='active')return {status:'active'};const id=uid();db.transaction(()=>{run('INSERT INTO access_requests(id,user_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status',id,a.id,'pending',now());audit('access.request',actorInfo(a),'user',a.id);})();return {status:'pending'};});
app.post('/auth/invitations/redeem',{config:authLimit},async(req)=>{
  const a=authenticate(req);if(!a)throw Object.assign(Error('Plex login required'),{statusCode:401});const {token}=z.object({token:z.string()}).parse(req.body);
  const invite=one('SELECT * FROM invitations WHERE token_hash=? AND status=? AND expires_at>?',hash(token),'open',now());if(!invite)throw Object.assign(Error('Invitation invalid or expired'),{statusCode:404});
  const user=one('SELECT * FROM users WHERE id=?',a.id)!;
  if(invite.bound_plex_id && invite.bound_plex_id!==user.plex_id)throw Object.assign(Error('Invitation belongs to another Plex account'),{statusCode:403});
  db.transaction(()=>{run('UPDATE invitations SET redeemed_by=?,status=? WHERE id=?',a.id,invite.bound_plex_id?'accepted':'pending-approval',invite.id);if(invite.bound_plex_id)run('UPDATE users SET role=?,grants=?,status=? WHERE id=?',invite.role,invite.grants,'active',a.id);audit('invitation.redeemed',actorInfo(a),'invitation',invite.id,{status:invite.bound_plex_id?'accepted':'pending-approval'});})();
  return {status:invite.bound_plex_id?'active':'pending-approval'};
});

// API documentation is generated from route schemas. Access is checked in the global hook.
app.get('/api/openapi.json',async()=>app.swagger());
app.get('/api/v1/me',{schema:{tags:['Authentication'],summary:'Current user and effective grants'}},async(req)=>{const a=actor(req);return {id:a.id,name:a.name,role:a.role,grants:a.grants,via:a.via,tokenId:a.tokenId};});

app.get('/api/v1/people',{schema:{tags:['People'],summary:'List users and access requests'}},async(req)=>{owner(req);return all('SELECT id,plex_id,name,role,status,grants,created_at FROM users ORDER BY created_at');});
app.get('/api/v1/access-requests',{schema:{tags:['People']}},async(req)=>{owner(req);return all('SELECT ar.*,u.name,u.plex_id FROM access_requests ar JOIN users u ON u.id=ar.user_id WHERE ar.status=?','pending');});
app.post('/api/v1/access-requests/:id/approve',{schema:{tags:['People'],...paramSchema}},async(req)=>{
  const a=owner(req);const input=z.object({role:z.enum(['viewer','editor','operator']),grants:z.array(grantSchema).optional()}).parse(req.body);const request=one('SELECT * FROM access_requests WHERE id=?',idParam(req));if(!request)throw Object.assign(Error('Request not found'),{statusCode:404});
  db.transaction(()=>{run('UPDATE users SET status=?,role=?,grants=? WHERE id=?','active',input.role,json(input.grants??preset(input.role)),request.user_id);run('UPDATE access_requests SET status=? WHERE id=?','approved',request.id);audit('access.approved',actorInfo(a),'user',request.user_id,{role:input.role,grants:input.grants??preset(input.role)});})();return {ok:true};
});
app.put('/api/v1/people/:id/grants',{schema:{tags:['People'],...paramSchema}},async(req)=>{
  const a=owner(req);const id=idParam(req);const input=z.object({role:z.enum(['viewer','editor','operator']),grants:z.array(grantSchema),status:z.enum(['active','suspended'])}).parse(req.body);
  const target=one('SELECT * FROM users WHERE id=?',id);if(!target)throw Object.assign(Error('User not found'),{statusCode:404});if(target.role==='owner')throw Object.assign(Error('Owner cannot be changed here'),{statusCode:403});
  db.transaction(()=>{run('UPDATE users SET role=?,grants=?,status=? WHERE id=?',input.role,json(input.grants),input.status,id);if(input.status==='suspended')revokeUserSessions(id);audit('access.changed',actorInfo(a),'user',id,{before:{role:target.role,status:target.status,grants:JSON.parse(target.grants)},after:input});})();return {ok:true};
});
app.post('/api/v1/people/:id/transfer-ownership',{schema:{tags:['People'],...paramSchema,summary:'Transfer installation ownership'}},async(req)=>{
  const current=owner(req),target=one('SELECT * FROM users WHERE id=?',idParam(req));
  if(!target||target.status!=='active'||target.id===current.id)throw Error('Choose another active user');
  const input=z.object({confirmName:z.string()}).parse(req.body);if(input.confirmName!==target.name)throw Error('Type the target user name to confirm');
  db.transaction(()=>{
    run('UPDATE users SET role=?,grants=? WHERE id=?','viewer',json(preset('viewer')),current.id);
    run('UPDATE users SET role=?,grants=? WHERE id=?','owner','[]',target.id);
    audit('ownership.transferred',actorInfo(current),'user',target.id,{from:current.id,to:target.id});
  })();return {ok:true,ownerId:target.id};
});
app.post('/api/v1/invitations',{schema:{tags:['People'],summary:'Create single-use invitation'}},async(req)=>{
  const a=owner(req);const input=z.object({boundPlexId:z.string().optional(),role:z.enum(['viewer','editor','operator']),grants:z.array(grantSchema).optional(),days:z.number().int().min(1).max(30).default(7)}).parse(req.body);
  const id=uid(),secret=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+input.days*86400000).toISOString();
  db.transaction(()=>{run('INSERT INTO invitations(id,token_hash,bound_plex_id,role,grants,expires_at,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,hash(secret),input.boundPlexId??null,input.role,json(input.grants??preset(input.role)),expiresAt,'open',a.id,now());audit('invitation.created',actorInfo(a),'invitation',id,{boundPlexId:input.boundPlexId,role:input.role,expiresAt});})();return {id,token:secret,expiresAt};
});
app.get('/api/v1/invitations',{schema:{tags:['People']}},async(req)=>{owner(req);return all('SELECT id,bound_plex_id,role,grants,expires_at,redeemed_by,status,created_at FROM invitations ORDER BY created_at DESC');});
app.post('/api/v1/invitations/:id/approve',{schema:{tags:['People'],...paramSchema}},async(req)=>{
  const a=owner(req),inv=one('SELECT * FROM invitations WHERE id=?',idParam(req));if(!inv||inv.status!=='pending-approval'||!inv.redeemed_by)throw Object.assign(Error('Invitation not pending approval'),{statusCode:404});
  db.transaction(()=>{run('UPDATE users SET role=?,grants=?,status=? WHERE id=?',inv.role,inv.grants,'active',inv.redeemed_by);run('UPDATE invitations SET status=? WHERE id=?','accepted',inv.id);audit('invitation.approved',actorInfo(a),'user',inv.redeemed_by,{invitationId:inv.id});})();return {ok:true};
});
app.post('/api/v1/invitations/:id/revoke',{schema:{tags:['People'],...paramSchema}},async(req)=>{const a=owner(req);db.transaction(()=>{run('UPDATE invitations SET status=? WHERE id=?','revoked',idParam(req));audit('invitation.revoked',actorInfo(a),'invitation',idParam(req));})();return {ok:true};});

app.get('/api/v1/tokens',{schema:{tags:['API tokens'],summary:'List token metadata'}},async(req)=>{const a=actor(req);return a.role==='owner'?all('SELECT t.id,t.user_id,u.name AS owner_name,t.name,t.grants,t.expires_at,t.last_used_at,t.revoked_at,t.created_at FROM api_tokens t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC'):all('SELECT id,user_id,name,grants,expires_at,last_used_at,revoked_at,created_at FROM api_tokens WHERE user_id=? ORDER BY created_at DESC',a.id);});
app.post('/api/v1/tokens',{schema:{tags:['API tokens'],summary:'Create a token; secret returned once',body:tokenBodySchema}},async(req)=>{
  const a=need(req,'tokens.create');if(!sessionOnly(a))throw Object.assign(Error('Plex session required'),{statusCode:403});
  const input=z.object({name:z.string().trim().min(1).max(80),grants:z.array(z.object({capability:z.string(),rules:z.any().optional(),connections:z.any().optional(),destinations:z.any().optional(),roots:z.any().optional()})).min(1),expiresAt:z.string().datetime().nullable().optional()}).parse(req.body);
  const expiry=input.expiresAt===undefined?new Date(Date.now()+90*86400000).toISOString():input.expiresAt;
  if(a.role!=='owner' && (!expiry||new Date(expiry).getTime()>Date.now()+90*86400000))throw Error('Token expiry exceeds 90 days');
  if(expiry && expiry<=now())throw Error('Expiry must be in the future');
  validateTokenGrants(a,input.grants as Grant[]);
  const created=db.transaction(()=>{const result=createToken(a.id,input.name,input.grants as Grant[],expiry??null);audit('token.created',actorInfo(a),'token',result.id,{name:input.name,grants:input.grants,expiresAt:expiry});return result;})();return {...created,expiresAt:expiry};
});
app.post('/api/v1/tokens/:id/revoke',{schema:{tags:['API tokens'],...paramSchema}},async(req)=>{const a=actor(req),token=one('SELECT * FROM api_tokens WHERE id=?',idParam(req));if(!token||token.user_id!==a.id&&a.role!=='owner')throw Object.assign(Error('Token not found'),{statusCode:404});if(!sessionOnly(a))throw Object.assign(Error('Plex session required'),{statusCode:403});db.transaction(()=>{run('UPDATE api_tokens SET revoked_at=? WHERE id=?',now(),token.id);audit('token.revoked',actorInfo(a),'token',token.id);})();return {ok:true};});
app.post('/api/v1/tokens/:id/rotate',{schema:{tags:['API tokens'],...paramSchema,summary:'Create a replacement token without revoking the old one'}},async(req)=>{
  const a=need(req,'tokens.create'),old=one('SELECT * FROM api_tokens WHERE id=?',idParam(req));
  if(!sessionOnly(a))throw Object.assign(Error('Plex session required'),{statusCode:403});
  if(!old||old.user_id!==a.id||old.revoked_at)throw Object.assign(Error('Token not found'),{statusCode:404});
  const grants=JSON.parse(old.grants) as Grant[];validateTokenGrants(a,grants);
  const expiresAt=new Date(Date.now()+90*86400000).toISOString();
  const created=db.transaction(()=>{const replacement=createToken(a.id,`${old.name} replacement`,grants,expiresAt);audit('token.rotated',actorInfo(a),'token',replacement.id,{replaces:old.id});return replacement;})();
  return {...created,expiresAt,replaces:old.id};
});

app.get('/api/v1/connections',{schema:{tags:['Connections'],summary:'List available Sonarr and Radarr connections'}},async(req)=>{const a=need(req,'connections.view');return connections().filter(c=>allowed(a,'connections.view',{connectionId:c.id})).map(c=>({id:c.id,name:c.name,kind:c.kind,url:c.url,ratingRegion:c.rating_region}));});
app.post('/api/v1/connections/test',{schema:{tags:['Connections'],summary:'Detect whether a URL and API key belong to Sonarr or Radarr',body:{type:'object',required:['url','apiKey'],properties:{url:stringField,apiKey:stringField}}}},async(req)=>{
  owner(req);const input=z.object({url:z.string().url(),apiKey:z.string().min(1)}).parse(req.body);
  const detected=await detectArr(input.url,input.apiKey);
  const found=await roots({id:'test',kind:detected.kind,name:detected.appName,url:detected.url,api_key_cipher:encrypt(input.apiKey),rating_region:'US'});
  return {...detected,roots:found};
});
app.post('/api/v1/connections',{schema:{tags:['Connections'],body:{type:'object',required:['url','apiKey'],properties:{name:stringField,kind:{type:'string',enum:['movie','series']},url:stringField,apiKey:stringField,ratingRegion:stringField},description:'Example: http://radarr:7878 with its API key. Filtarr detects Sonarr or Radarr from the API; name defaults to the instance name.'}}},async(req)=>{
  const a=owner(req);const input=z.object({name:z.string().trim().optional(),kind:z.enum(['movie','series']).optional(),url:z.string().url(),apiKey:z.string().min(1),ratingRegion:z.string().length(2).default('US')}).parse(req.body);
  const detected=await detectArr(input.url,input.apiKey);
  if (input.kind&&input.kind!==detected.kind) throw Object.assign(Error(`That URL is ${detected.appName}, not ${input.kind==='movie'?'Radarr':'Sonarr'}`),{statusCode:400});
  const id=uid(),record={id,kind:detected.kind,name:input.name||detected.instanceName,url:detected.url,api_key_cipher:encrypt(input.apiKey),rating_region:input.ratingRegion};
  const result=await testConnection(record);db.transaction(()=>{run('INSERT INTO connections(id,kind,name,url,api_key_cipher,rating_region,created_at) VALUES(?,?,?,?,?,?,?)',id,record.kind,record.name,record.url,record.api_key_cipher,record.rating_region,now());audit('connection.created',actorInfo(a),'connection',id,{name:record.name,kind:record.kind,url:record.url});})();return {id,kind:record.kind,name:record.name,url:record.url,...result};
});
app.get('/api/v1/connections/:id/roots',{schema:{tags:['Connections'],...paramSchema}},async(req)=>{const a=need(req,'connections.view',{connectionId:idParam(req)}),c=getConnection(idParam(req));if(!c)throw Object.assign(Error('Connection not found'),{statusCode:404});return (await roots(c)).filter(root=>allowed(a,'connections.view',{connectionId:c.id,root:root.path}));});
app.post('/api/v1/connections/:id/test',{schema:{tags:['Connections'],...paramSchema}},async(req)=>{const a=need(req,'connections.view',{connectionId:idParam(req)});const c=getConnection(idParam(req));if(!c)throw Object.assign(Error('Connection not found'),{statusCode:404});const result=await testConnection(c);return {...result,roots:result.roots.filter(root=>allowed(a,'connections.view',{connectionId:c.id,root:root.path}))};});
app.delete('/api/v1/connections/:id',{schema:{tags:['Connections'],...paramSchema}},async(req)=>{const a=owner(req);db.transaction(()=>{run('DELETE FROM connections WHERE id=?',idParam(req));audit('connection.deleted',actorInfo(a),'connection',idParam(req));})();return {ok:true};});
app.get('/api/v1/destinations',{schema:{tags:['Destinations']}},async(req)=>{
  const a=need(req,'destinations.view');
  return all('SELECT * FROM destinations').filter(d=>allowed(a,'destinations.view',{destinationId:d.id})).map(d=>{
    const mappings=JSON.parse(d.mappings) as Record<string,Record<string,string>>;
    const visible:Record<string,Record<string,string>>={};
    for(const [connectionId,kinds] of Object.entries(mappings)){
      const permitted=Object.fromEntries(Object.entries(kinds).filter(([,root])=>allowed(a,'destinations.view',{destinationId:d.id,connectionId,root})));
      if(Object.keys(permitted).length)visible[connectionId]=permitted;
    }
    return {...d,mappings:visible};
  });
});
app.post('/api/v1/destinations',{schema:{tags:['Destinations'],body:{type:'object',required:['name','mappings'],properties:{name:stringField,mappings:{type:'object',additionalProperties:true}},description:'Example: Kids destination maps a Radarr connection to /media/kids/movies.'}}},async(req)=>{const a=owner(req);const input=destinationInput.parse(req.body);const id=uid();db.transaction(()=>{run('INSERT INTO destinations(id,name,mappings,created_at) VALUES(?,?,?,?)',id,input.name,json(input.mappings),now());audit('destination.created',actorInfo(a),'destination',id,input);})();return {id,...input};});
const destinationInput=z.object({name:z.string().trim().min(1).max(80),mappings:z.record(z.string(),z.partialRecord(z.enum(['movie','series']),z.string()))}).transform(d=>{
  // Drop unchosen root folders so "Choose root folder" never saves an empty mapping.
  const mappings:Record<string,Record<string,string>>={};
  for(const [connectionId,kinds] of Object.entries(d.mappings)){const set=Object.fromEntries(Object.entries(kinds as Record<string,string>).filter(([,path])=>path));if(Object.keys(set).length)mappings[connectionId]=set;}
  return {name:d.name,mappings};
});
/** Active rules (draft or published revision) that mention a destination in an action or condition. */
function rulesUsingDestination(id:string):string[]{return all("SELECT r.name FROM rules r LEFT JOIN rule_revisions v ON v.rule_id=r.id AND v.revision=r.published_revision WHERE r.archived=0 AND (instr(r.draft,?)>0 OR instr(coalesce(v.document,''),?)>0)",JSON.stringify(id),JSON.stringify(id)).map(r=>String(r.name));}
app.put('/api/v1/destinations/:id',{schema:{tags:['Destinations'],...paramSchema}},async(req)=>{const a=owner(req);const input=destinationInput.parse(req.body);const before=one('SELECT name,mappings FROM destinations WHERE id=?',idParam(req));if(!before)throw Object.assign(Error('Destination not found'),{statusCode:404});db.transaction(()=>{run('UPDATE destinations SET name=?,mappings=? WHERE id=?',input.name,json(input.mappings),idParam(req));audit('destination.updated',actorInfo(a),'destination',idParam(req),{before:{name:before.name,mappings:JSON.parse(before.mappings)},after:input});})();return {id:idParam(req),...input};});
app.delete('/api/v1/destinations/:id',{schema:{tags:['Destinations'],...paramSchema,summary:'Delete a destination that no active rule uses; titles pinned to it go back to following rules'}},async(req)=>{const a=owner(req),row=one('SELECT * FROM destinations WHERE id=?',idParam(req));if(!row)throw Object.assign(Error('Destination not found'),{statusCode:404});
  const used=rulesUsingDestination(row.id);if(used.length)throw Object.assign(Error(`${row.name} is used by ${used.map(n=>`“${n}”`).join(', ')}. Change or delete ${used.length===1?'that rule':'those rules'} first.`),{statusCode:409});
  let unpinned=0;db.transaction(()=>{unpinned=run('DELETE FROM destination_overrides WHERE destination_id=?',row.id).changes;run('DELETE FROM destinations WHERE id=?',row.id);audit('destination.deleted',actorInfo(a),'destination',row.id,{name:row.name,mappings:JSON.parse(row.mappings),unpinned});})();return {ok:true,unpinned};});
app.get('/api/v1/destinations/:id/usage',{schema:{tags:['Destinations'],...paramSchema}},async(req)=>{owner(req);return {rules:rulesUsingDestination(idParam(req)),pins:Number(one('SELECT count(*) AS n FROM destination_overrides WHERE destination_id=?',idParam(req))?.n??0)};});
app.post('/api/v1/starter-rules',{schema:{tags:['Rules'],summary:'Create editable Kids and Regular starter rules'}},async(req)=>{
  const a=owner(req);const kids=one('SELECT id FROM destinations WHERE name=?','Kids'),regular=one('SELECT id FROM destinations WHERE name=?','Regular');if(!kids||!regular)throw Error('Create Kids and Regular destinations first');
  const docs=starterRules(kids.id,regular.id);const position=Number(one('SELECT MAX(position) AS value FROM rules')?.value??0);
  db.transaction(()=>{docs.forEach((doc,i)=>{run('INSERT INTO rules(id,name,draft,position,created_by,creator_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',doc.id,doc.name,json(doc),position+i+1,a.id,a.name,now(),now());audit('rule.created',actorInfo(a),'rule',doc.id,{name:doc.name,starter:true});});})();return docs;
});
const conditionSchema:z.ZodType<any>=z.lazy(()=>z.discriminatedUnion('kind',[
  z.object({kind:z.literal('predicate'),field:z.string().refine(key=>fieldByKey.has(key),{message:'Unknown field'}),operator:z.enum(operators),value:z.union([z.string(),z.number(),z.boolean(),z.array(z.string())]).optional()}),
  z.object({kind:z.enum(['all','any']),children:z.array(conditionSchema).min(1)}),
  z.object({kind:z.literal('not'),child:conditionSchema})
]));
const ruleSchema=z.object({name:z.string().trim().min(1).max(100),condition:conditionSchema,actions:z.array(z.discriminatedUnion('type',[
  z.object({type:z.literal('move'),destinationId:z.string()}),z.object({type:z.literal('addTag'),tag:z.string().min(1)}),z.object({type:z.literal('removeTag'),tag:z.string().min(1)}),z.object({type:z.literal('monitor'),value:z.boolean()})
])).min(1),stopProcessing:z.boolean().default(false),connectionIds:z.array(z.string()).optional(),mediaTypes:z.array(z.enum(['movie','series'])).optional()});
function ruleResource(a:Actor,row:Row,capability:Capability) {if(!allowed(a,capability,{ruleId:row.id,ruleCreatorId:row.created_by}))throw Object.assign(Error('Permission denied'),{statusCode:403});}
function ruleRow(id:string){const row=one('SELECT * FROM rules WHERE id=? AND archived=0',id);if(!row)throw Object.assign(Error('Rule not found'),{statusCode:404});return row;}
function parsedRule(row:Row){const publisher=row.published_revision?one('SELECT publisher_name,publisher_id FROM rule_revisions WHERE rule_id=? AND revision=?',row.id,row.published_revision):null;return {...safe(row),draft:JSON.parse(row.draft),sourceProvenance:row.source_provenance?JSON.parse(row.source_provenance):null,publisherName:publisher?.publisher_name??null,publisherId:publisher?.publisher_id??null,enabled:!!row.enabled,publishedRevision:row.published_revision};}
app.get('/api/v1/rules',{schema:{tags:['Rules'],summary:'List visible rules',description:'Example: `GET /api/v1/rules?limit=20&offset=0` with `Authorization: Bearer filtarr_<id>_<secret>`. Results are filtered by current grants before pagination.',...listSchema}},async(req)=>{const a=need(req,'rules.view');const {limit,offset}=paging(req);return all('SELECT * FROM rules WHERE archived=0 ORDER BY position').filter(r=>allowed(a,'rules.view',{ruleId:r.id,ruleCreatorId:r.created_by})).slice(offset,offset+limit).map(parsedRule);});
app.get('/api/v1/rules/:id',{schema:{tags:['Rules'],...paramSchema}},async(req)=>{const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.view');return parsedRule(row);});
app.post('/api/v1/rules',{schema:{tags:['Rules'],summary:'Create a disabled rule draft',body:ruleDocumentSchema}},async(req)=>{
  const a=need(req,'rules.create');const input=ruleSchema.parse(req.body);const id=uid();const doc:RuleDocument={id,...input};const pos=Number(one('SELECT MAX(position) AS value FROM rules')?.value??0)+1;
  db.transaction(()=>{run('INSERT INTO rules(id,name,draft,position,created_by,creator_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,input.name,json(doc),pos,a.id,a.name,now(),now());audit('rule.created',actorInfo(a),'rule',id,{name:input.name});})();return {id,draftVersion:1};
});
app.put('/api/v1/rules/:id/draft',{schema:{tags:['Rules'],...paramSchema,summary:'Edit a draft using its expected version',body:{type:'object',required:['expectedVersion','document'],properties:{expectedVersion:{type:'integer'},document:ruleDocumentSchema}}}},async(req)=>{
  const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.edit');const input=z.object({expectedVersion:z.number().int(),document:ruleSchema}).parse(req.body);
  if(input.expectedVersion!==row.draft_version)throw Object.assign(Error('Draft version conflict'),{statusCode:409});const doc={id:row.id,...input.document};
  db.transaction(()=>{run('UPDATE rules SET name=?,draft=?,draft_version=draft_version+1,edited_by=?,editor_name=?,updated_at=? WHERE id=?',doc.name,json(doc),a.id,a.name,now(),row.id);audit('rule.edited',actorInfo(a),'rule',row.id,{version:row.draft_version+1,before:JSON.parse(row.draft),after:doc});})();return {id:row.id,draftVersion:row.draft_version+1};
});
app.get('/api/v1/rules/:id/revisions',{schema:{tags:['Rules'],...paramSchema}},async(req)=>{const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.view');return all('SELECT * FROM rule_revisions WHERE rule_id=? ORDER BY revision DESC',row.id).map(r=>({...r,document:JSON.parse(r.document)}));});
app.post('/api/v1/rules/:id/publish',{schema:{tags:['Rules'],...paramSchema}},async(req)=>{
  const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.publish');const doc=ruleSchema.parse(JSON.parse(row.draft));
  const targetConnections=doc.connectionIds?.length?doc.connectionIds:connections().map(c=>c.id);
  for(const connectionId of targetConnections){
    const connection=getConnection(connectionId);if(!connection)throw Error('Rule includes an unknown connection');
    for(const action of doc.actions){
      if(action.type==='move'&&parseRootTarget(action.destinationId)&&parseRootTarget(action.destinationId)?.connectionId!==connectionId)continue;
      const cap=action.type==='move'?'actions.move':action.type==='monitor'?'actions.monitor':'actions.tags';
      if(!allowed(a,cap,{ruleId:row.id,ruleCreatorId:row.created_by,connectionId,destinationId:action.type==='move'?action.destinationId:undefined}))throw Object.assign(Error(`Cannot publish ${action.type} action for ${connection.name}`),{statusCode:403});
      if(action.type==='move'&&!targetPath(action.destinationId,connectionId,connection.kind))throw Error(`Destination is not mapped for ${connection.name}`);
    }
  }
  for(const action of doc.actions){
    const target=action.type==='move'?parseRootTarget(action.destinationId):null;if(!target)continue;
    const connection=getConnection(target.connectionId);
    if(!connection||!targetConnections.includes(target.connectionId))throw Error('A move targets a root folder on a connection this rule does not use');
    if(!(await roots(connection)).some(r=>r.path===target.path))throw Error(`${connection.name} has no root folder ${target.path}`);
  }
  const rev=Number(row.published_revision??0)+1;
  db.transaction(()=>{run('INSERT INTO rule_revisions(rule_id,revision,document,publisher_id,publisher_name,published_at) VALUES(?,?,?,?,?,?)',row.id,rev,json({id:row.id,...doc}),a.id,a.name,now());run('UPDATE rules SET published_revision=?,updated_at=? WHERE id=?',rev,now(),row.id);audit('rule.published',actorInfo(a),'rule',row.id,{revision:rev});})();return {id:row.id,revision:rev};
});
app.post('/api/v1/rules/:id/duplicate',{schema:{tags:['Rules'],...paramSchema,summary:'Create a disabled draft copy'}},async(req)=>{
  const a=need(req,'rules.create'),source=ruleRow(idParam(req));ruleResource(a,source,'rules.view');
  const id=uid(),sourceDoc=JSON.parse(source.draft),doc={...sourceDoc,id,name:`${source.name} copy`},position=Number(one('SELECT MAX(position) AS value FROM rules')?.value??0)+1;
  db.transaction(()=>{run('INSERT INTO rules(id,name,draft,position,created_by,creator_name,source_provenance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',id,doc.name,json(doc),position,a.id,a.name,json({kind:'duplicate',sourceRuleId:source.id,sourceName:source.name}),now(),now());audit('rule.duplicated',actorInfo(a),'rule',id,{sourceId:source.id});})();return {id,draftVersion:1};
});
app.post('/api/v1/rules/:id/preview-draft',{schema:{tags:['Rules'],...paramSchema,summary:'Preview an unpublished draft without mutating media',description:'Example: `POST /api/v1/rules/{id}/preview-draft` with an empty JSON body. Returns `202` and a completed preview run ID. Inspect its plan at the returned status URL.'}},async(req,reply)=>{
  const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.preview');const doc=ruleSchema.parse(JSON.parse(row.draft));
  const keys=ruleFields([{id:row.id,...doc}]),items=(await inventory(keys)).filter(item=>allowed(a,'media.view',{connectionId:item.connectionId,root:item.rootFolderPath??undefined}));
  const result=compactPlans(plan(items,[{id:row.id,...doc}]),keys);for(const item of result)item.blocked=preflight(item,a);
  const id=uid();db.transaction(()=>{run('INSERT INTO runs(id,mode,scope,rule_id,status,actor_id,actor_name,token_id,plan,total,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,'preview','one',row.id,'completed',a.id,a.name,a.tokenId??null,json(result),result.length,now(),now(),now());audit('rule.draft_previewed',actorInfo(a),'rule',row.id,{runId:id,draftVersion:row.draft_version});})();
  return reply.code(202).send({id,status:'completed',statusUrl:`/api/v1/runs/${id}`});
});
app.post('/api/v1/rules/:id/enabled',{schema:{tags:['Rules'],...paramSchema}},async(req)=>{
  const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.enable');ruleResource(a,row,'rules.publish');const {enabled}=z.object({enabled:z.boolean()}).parse(req.body);
  if(enabled&&!row.published_revision)throw Error('Publish this rule before enabling it');
  db.transaction(()=>{run('UPDATE rules SET enabled=?,updated_at=? WHERE id=?',enabled?1:0,now(),row.id);audit(enabled?'rule.enabled':'rule.disabled',actorInfo(a),'rule',row.id);})();return {enabled};
});
app.delete('/api/v1/rules/:id',{schema:{tags:['Rules'],...paramSchema}},async(req)=>{const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.delete');if(row.enabled)ruleResource(a,row,'rules.publish');db.transaction(()=>{run('UPDATE rules SET archived=1,enabled=0,updated_at=? WHERE id=?',now(),row.id);audit('rule.archived',actorInfo(a),'rule',row.id);})();return {ok:true};});
app.post('/api/v1/rules/reorder',{schema:{tags:['Rules']}},async(req)=>{const a=owner(req);const {ids}=z.object({ids:z.array(z.string())}).parse(req.body);const existing=all('SELECT id FROM rules WHERE archived=0 ORDER BY position').map(r=>r.id);if(ids.length!==existing.length||new Set(ids).size!==ids.length||ids.some(id=>!existing.includes(id)))throw Error('Supply every active rule once');db.transaction(()=>{ids.forEach((id,i)=>run('UPDATE rules SET position=? WHERE id=?',i+1,id));audit('rules.reordered',actorInfo(a),'rules',undefined,{ids});})();return {ok:true};});

app.get('/api/v1/media',{schema:{tags:['Media'],summary:'List media visible to this account'}},async(req)=>{const a=need(req,'media.view');const {limit,offset}=paging(req);const q=req.query as any;const list=(await inventory()).filter(i=>allowed(a,'media.view',{connectionId:i.connectionId,root:i.rootFolderPath??undefined}));const filtered=q.search?list.filter(i=>i.title.toLowerCase().includes(String(q.search).toLowerCase())):list;return {total:filtered.length,items:filtered.slice(offset,offset+limit).map(i=>({...i,ageRating:ageRating(i.certification)}))};});
app.post('/api/v1/media/refresh',{schema:{tags:['Media']}},async(req)=>{const a=need(req,'media.refresh');const items=(await inventory()).filter(item=>allowed(a,'media.view',{connectionId:item.connectionId,root:item.rootFolderPath??undefined}));audit('media.refreshed',actorInfo(a),'media',undefined,{count:items.length});return {count:items.length};});
app.post('/api/v1/media/:id/metadata-override',{schema:{tags:['Media'],...paramSchema}},async(req)=>{const a=need(req,'media.override');const input=z.object({certification:z.string().nullable()}).parse(req.body);const mediaId=idParam(req);const media=(await inventory()).find(item=>item.id===mediaId);if(!media||!allowed(a,'media.override',{connectionId:media.connectionId,root:media.rootFolderPath??undefined}))throw Object.assign(Error('Media not found'),{statusCode:404});db.transaction(()=>{run('INSERT INTO metadata_overrides(media_id,certification,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET certification=excluded.certification,updated_by=excluded.updated_by,updated_at=excluded.updated_at',mediaId,input.certification,a.id,now());audit('media.metadata_override',actorInfo(a),'media',mediaId,{...input,root:media.rootFolderPath});})();return {ok:true};});

app.put('/api/v1/media/:id/destination-override',{schema:{tags:['Media'],...paramSchema,summary:'Pin a title to a destination so rules cannot move it, or clear the pin with null',body:{type:'object',required:['destinationId'],properties:{destinationId:{type:['string','null']}}}}},async(req)=>{
  const a=need(req,'media.override');const input=z.object({destinationId:z.string().nullable()}).parse(req.body);const mediaId=idParam(req);
  const media=(await inventory()).find(item=>item.id===mediaId);if(!media||!allowed(a,'media.override',{connectionId:media.connectionId,root:media.rootFolderPath??undefined}))throw Object.assign(Error('Media not found'),{statusCode:404});
  if(input.destinationId&&!targetPath(input.destinationId,media.connectionId,media.mediaType))throw Error('That destination has no folder for this title\'s connection');
  db.transaction(()=>{if(input.destinationId)run('INSERT INTO destination_overrides(media_id,destination_id,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET destination_id=excluded.destination_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at',mediaId,input.destinationId,a.id,now());else run('DELETE FROM destination_overrides WHERE media_id=?',mediaId);audit('media.destination_override',actorInfo(a),'media',mediaId,{title:media.title,destinationId:input.destinationId});})();
  return {ok:true,destinationId:input.destinationId};
});
app.post('/api/v1/runs',{schema:{tags:['Runs'],summary:'Submit preview or live run; returns a durable run ID',description:'Example: `POST /api/v1/runs` with `{"mode":"apply","scope":"one","ruleId":"rule-id"}` and `Idempotency-Key: unique-client-key`. The `202` response contains `id` and `statusUrl`. Reusing the key with different input returns `409`; poll the status URL until completed, partial, failed, or cancelled.',body:{type:'object',required:['mode','scope'],properties:{mode:{type:'string',enum:['preview','apply']},scope:{type:'string',enum:['all','one']},ruleId:{type:'string'},previewRunId:{type:'string'}}},response:{202:{type:'object',properties:{id:stringField,status:stringField,statusUrl:stringField}}}}},async(req,reply)=>{
  const a=actor(req),input=z.object({mode:z.enum(['preview','apply']),scope:z.enum(['all','one']),ruleId:z.string().optional(),previewRunId:z.string().optional()}).parse(req.body);if(input.scope==='one'&&!input.ruleId)throw Error('ruleId required for single-rule runs');
  const item=createRun(a,input.mode,input.scope,input.ruleId,typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined,input.previewRunId);
  return reply.code(202).send({id:item.id,status:item.status,statusUrl:`/api/v1/runs/${item.id}`});
});
function visibleRun(a:Actor,row:Row,details=false):Row|null {
  if(a.role!=='owner' && row.rule_id && !allowed(a,'runs.view',{ruleId:row.rule_id}))return null;
  if(a.role!=='owner' && !row.rule_id && row.actor_id!==a.id)return null;
  if(a.role!=='owner' && row.rule_id && !allowed(a,'rules.view',{ruleId:row.rule_id}))return null;
  const planItems=row.plan?JSON.parse(row.plan) as {item:{id:string;connectionId:string;rootFolderPath?:string};blocked?:string}[]:null;
  if(a.role!=='owner' && planItems?.some(p=>(p as any).trace?.some((step:{ruleId:string})=>step.ruleId!=='manual-override'&&(!allowed(a,'rules.view',{ruleId:step.ruleId})||!allowed(a,'runs.view',{ruleId:step.ruleId})))))return null;
  const visible=planItems?.filter(p=>a.role==='owner'||allowed(a,'media.view',{connectionId:p.item.connectionId,root:p.item.rootFolderPath||undefined}))??null;
  if(a.role!=='owner' && planItems?.length && !visible?.length)return null;
  const ids=new Set(visible?.map(p=>p.item.id)??[]);
  const attempts=details||a.role!=='owner'?all('SELECT * FROM action_attempts WHERE run_id=?',row.id).filter(at=>a.role==='owner'||ids.has(at.media_id)):[];
  const changed=new Set(attempts.filter(at=>at.status==='verified').map(at=>at.media_id)).size;
  const failed=new Set(attempts.filter(at=>at.status==='failed'||at.status==='uncertain').map(at=>at.media_id));
  visible?.forEach(p=>{if(p.blocked)failed.add(p.item.id);});
  const {plan:_plan,token_id:_tokenId,...summary}=row;
  const planned=visible?.filter(p=>!p.blocked&&(p as any).changes?.length).length??0;
  return {...summary,planned,total:a.role==='owner'?row.total:visible?.length??0,changed:a.role==='owner'?row.changed:changed,failed:a.role==='owner'?row.failed:failed.size,error:a.role==='owner'?row.error:null,...(details?{plan:visible,attempts}:{}),...(a.role==='owner'?{token_id:row.token_id}:{})};
}
app.get('/api/v1/runs',{schema:{tags:['Runs'],...listSchema}},async(req)=>{const a=need(req,'runs.view');const {limit,offset}=paging(req);return all('SELECT * FROM runs ORDER BY created_at DESC').map(r=>visibleRun(a,r)).filter((r):r is Row=>!!r).slice(offset,offset+limit);});
app.get('/api/v1/runs/:id',{schema:{tags:['Runs'],...paramSchema,description:'Example: `GET /api/v1/runs/{id}` to poll status and inspect visible plan items and action attempts. Submitted moves and verified moves have different attempt statuses.'}},async(req)=>{const a=need(req,'runs.view'),row=one('SELECT * FROM runs WHERE id=?',idParam(req));const visible=row&&visibleRun(a,row,true);if(!visible)throw Object.assign(Error('Run not found'),{statusCode:404});return visible;});
app.post('/api/v1/runs/:id/cancel',{schema:{tags:['Runs'],...paramSchema}},async(req)=>{const a=need(req,'runs.cancel'),row=one('SELECT * FROM runs WHERE id=?',idParam(req));if(!row)throw Object.assign(Error('Run not found'),{statusCode:404});const permitted=row.rule_id?allowed(a,'runs.cancel',{ruleId:row.rule_id}):a.role==='owner'||row.actor_id===a.id&&publishedRules('all').every(r=>allowed(a,'runs.cancel',{ruleId:r.rule.id,ruleCreatorId:r.creatorId}));if(!permitted)throw Object.assign(Error('Run not found'),{statusCode:404});db.transaction(()=>{run("UPDATE runs SET status='cancelled',finished_at=? WHERE id=? AND status IN ('queued','running')",now(),row.id);audit('run.cancelled',actorInfo(a),'run',row.id);})();return {ok:true};});
app.get('/api/v1/runs/:id/events',{schema:{tags:['Runs'],...paramSchema}},async(req,reply)=>{const a=need(req,'runs.view'),row=one('SELECT * FROM runs WHERE id=?',idParam(req));if(!row||!visibleRun(a,row))throw Object.assign(Error('Run not found'),{statusCode:404});reply.raw.setHeader('Content-Type','text/event-stream');reply.raw.setHeader('Cache-Control','no-cache');reply.raw.flushHeaders();const interval=setInterval(()=>{const current=one('SELECT * FROM runs WHERE id=?',row.id),fresh=actorById(a.id,a.tokenId);const safe=fresh&&allowed(fresh,'runs.view')&&current?visibleRun(fresh,current):null;if(!safe){clearInterval(interval);reply.raw.end();return;}reply.raw.write(`data: ${json({id:safe.id,status:safe.status,total:safe.total,changed:safe.changed,failed:safe.failed})}\n\n`);if(['completed','partial','failed','cancelled'].includes(String(safe.status))){clearInterval(interval);reply.raw.end();}},1000);req.raw.on('close',()=>clearInterval(interval));return reply;});

app.get('/api/v1/schedules',{schema:{tags:['Schedules']}},async(req)=>{need(req,'schedules.view');return all('SELECT * FROM schedules ORDER BY created_at');});
app.post('/api/v1/schedules',{schema:{tags:['Schedules'],body:{type:'object',required:['name','expression','timezone'],properties:{name:stringField,expression:stringField,timezone:stringField,enabled:{type:'boolean'}},description:'Example: Daily, 0 3 * * *, America/Chicago, initially disabled.'}}},async(req)=>{const a=owner(req),input=z.object({name:z.string().min(1),expression:z.string().min(1),timezone:z.string().min(1),enabled:z.boolean().default(false)}).parse(req.body);const next=nextScheduleRun(input.expression,input.timezone);const id=uid();db.transaction(()=>{run('INSERT INTO schedules(id,name,expression,timezone,enabled,configured_by,next_at,created_at) VALUES(?,?,?,?,?,?,?,?)',id,input.name,input.expression,input.timezone,input.enabled?1:0,a.id,next?.toISOString()??null,now());audit('schedule.created',actorInfo(a),'schedule',id,input);})();return {id,nextAt:next};});
app.put('/api/v1/schedules/:id',{schema:{tags:['Schedules'],...paramSchema}},async(req)=>{const a=owner(req),input=z.object({name:z.string().min(1),expression:z.string().min(1),timezone:z.string().min(1),enabled:z.boolean()}).parse(req.body);const next=nextScheduleRun(input.expression,input.timezone);db.transaction(()=>{run('UPDATE schedules SET name=?,expression=?,timezone=?,enabled=?,next_at=?,configured_by=? WHERE id=?',input.name,input.expression,input.timezone,input.enabled?1:0,next?.toISOString()??null,a.id,idParam(req));audit('schedule.updated',actorInfo(a),'schedule',idParam(req),input);})();return {nextAt:next};});
app.delete('/api/v1/schedules/:id',{schema:{tags:['Schedules'],...paramSchema}},async(req)=>{const a=owner(req),row=one('SELECT * FROM schedules WHERE id=?',idParam(req));if(!row)throw Object.assign(Error('Schedule not found'),{statusCode:404});db.transaction(()=>{run('DELETE FROM schedules WHERE id=?',row.id);audit('schedule.deleted',actorInfo(a),'schedule',row.id,{name:row.name,expression:row.expression});})();return {ok:true};});
function auditVisible(a:Actor,event:Row):boolean {
  if(a.role==='owner')return true;
  if(['access.','invitation.','ownership.','connection.','destination.','schedule.'].some(prefix=>event.type.startsWith(prefix)))return false;
  if(event.resource_type==='rule')return allowed(a,'rules.view',{ruleId:event.resource_id});
  if(event.resource_type==='media'){const root=JSON.parse(event.details).root as string|undefined;return !!root&&allowed(a,'media.view',{connectionId:String(event.resource_id).split(':')[0],root});}
  if(event.resource_type==='run'){
    const record=one('SELECT * FROM runs WHERE id=?',event.resource_id);
    if(!record||!visibleRun(a,record))return false;
    if(event.type==='action.verified'){
      const mediaId=JSON.parse(event.details).mediaId as string;
      return !!mediaId && (JSON.parse(record.plan??'[]') as {item:{id:string;connectionId:string;rootFolderPath?:string}}[]).some(p=>p.item.id===mediaId&&allowed(a,'media.view',{connectionId:p.item.connectionId,root:p.item.rootFolderPath||undefined}));
    }
    return true;
  }
  return event.actor_id===a.id;
}
function presentAudit(event:Row){return {...event,tokenName:event.token_id?one('SELECT name FROM api_tokens WHERE id=?',event.token_id)?.name??null:null,details:JSON.parse(event.details)};}
app.get('/api/v1/activity',{schema:{tags:['Activity'],summary:'Scoped audit history',description:'Example: `GET /api/v1/activity?limit=20&offset=0` to retrieve the most recent audit records visible to the token owner.'}},async(req)=>{const a=need(req,'activity.view'),{limit,offset}=paging(req);return all('SELECT * FROM audit ORDER BY created_at DESC LIMIT 10000').filter(e=>auditVisible(a,e)).slice(offset,offset+limit).map(presentAudit);});
app.get('/api/v1/logs',{schema:{tags:['Activity'],summary:'Recent operational logs (owner only)',...listSchema}},async(req)=>{owner(req);const {limit,offset}=paging(req);return all('SELECT * FROM operational_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',limit,offset).map(e=>({...e,details:JSON.parse(e.details)}));});
app.get('/api/v1/metrics',{schema:{tags:['Activity'],summary:'Run and action metrics'}},async(req)=>{
  const a=need(req,'metrics.view');
  const visible=all('SELECT * FROM runs').map(r=>visibleRun(a,r,true)).filter((r):r is Row=>!!r);
  const grouped=new Map<string,{mode:string;status:string;count:number;total:number;changed:number;failed:number}>();
  const actions=new Map<string,{type:string;status:string;count:number}>();
  const summary={evaluated:0,matched:0,changed:0,verifiedMoves:0,tagChanges:0,monitoringChanges:0,pendingReconciliation:0,averageQueueWaitMs:0,averageDurationMs:0,providerFailures:0};
  let queueSamples=0,durationSamples=0;
  for(const item of visible){
    const key=`${item.mode}:${item.status}`,current=grouped.get(key)??{mode:String(item.mode),status:String(item.status),count:0,total:0,changed:0,failed:0};
    current.count++;current.total+=Number(item.total)||0;current.changed+=Number(item.changed)||0;current.failed+=Number(item.failed)||0;grouped.set(key,current);
    if(item.mode==='apply'){summary.evaluated+=Number(item.total)||0;summary.changed+=Number(item.changed)||0;summary.matched+=(item.plan as {trace:{matched:boolean}[]}[]??[]).filter(p=>p.trace.some(t=>t.matched===true)).length;}
    if(item.started_at){summary.averageQueueWaitMs+=Math.max(0,Date.parse(item.started_at)-Date.parse(item.created_at));queueSamples++;}
    if(item.started_at&&item.finished_at){summary.averageDurationMs+=Math.max(0,Date.parse(item.finished_at)-Date.parse(item.started_at));durationSamples++;}
    for(const attempt of item.attempts as Row[]){
      const type=JSON.parse(attempt.action).type as string,actionKey=`${type}:${attempt.status}`,aggregate=actions.get(actionKey)??{type,status:String(attempt.status),count:0};aggregate.count++;actions.set(actionKey,aggregate);
      if(attempt.status==='uncertain')summary.pendingReconciliation++;
      if(attempt.status==='verified'&&item.mode==='apply'){
        if(type==='move')summary.verifiedMoves++;
        if(type==='addTag'||type==='removeTag')summary.tagChanges++;
        if(type==='monitor')summary.monitoringChanges++;
      }
    }
  }
  summary.averageQueueWaitMs=queueSamples?Math.round(summary.averageQueueWaitMs/queueSamples):0;
  summary.averageDurationMs=durationSamples?Math.round(summary.averageDurationMs/durationSamples):0;
  const scopedConnections=connections().filter(c=>allowed(a,'connections.view',{connectionId:c.id}));
  const cutoff=new Date(Date.now()-30*86400000).toISOString();
  summary.providerFailures=all("SELECT resource_id FROM audit WHERE type IN ('inventory.error','metadata.provider_failure') AND created_at>=?",cutoff).filter(e=>scopedConnections.some(c=>c.id===e.resource_id)).length;
  const connectionHealth=await Promise.all(scopedConnections.map(async c=>{
    try{const status=await arrRequest<Row>(c,'system/status',{signal:AbortSignal.timeout(4000)});return {id:c.id,name:c.name,status:'healthy',version:status.version};}
    catch{return {id:c.id,name:c.name,status:'unreachable'};}
  }));
  const requests=a.role==='owner'?all('SELECT day,SUM(requests) requests,SUM(errors) errors,SUM(rate_limited) rateLimited FROM api_metrics GROUP BY day ORDER BY day DESC LIMIT 30'):all('SELECT day,SUM(requests) requests,SUM(errors) errors,SUM(rate_limited) rateLimited FROM api_metrics WHERE actor_id=? GROUP BY day ORDER BY day DESC LIMIT 30',a.id);
  return {runs:[...grouped.values()],actions:[...actions.values()],summary,requests,connections:scopedConnections.length,connectionHealth,...(a.role==='owner'?{upcoming:all('SELECT id,name,next_at FROM schedules WHERE enabled=1')}: {})};
});
app.get('/api/v1/activity/export',{schema:{tags:['Activity'],summary:'Export visible audit events as JSON or CSV'}},async(req,reply)=>{
  const a=need(req,'activity.export');const format=String((req.query as any).format??'json');
  const rows=all('SELECT * FROM audit ORDER BY created_at DESC LIMIT 10000').filter(e=>auditVisible(a,e)).map(presentAudit);
  audit('activity.exported',actorInfo(a),'audit',undefined,{count:rows.length,format});
  if(format==='csv'){const columns=['created_at','actor_name','type','resource_type','resource_id','details'];const escape=(value:unknown)=>{const text=String(value??'');return `"${(/^[=+\-@\t\r]/.test(text)?`'${text}`:text).replaceAll('"','""')}"`;};reply.type('text/csv');return [columns.join(','),...rows.map(row=>columns.map(column=>escape(column==='details'?json(row.details):(row as Row)[column])).join(','))].join('\n');}
  return rows;
});
app.get('/api/v1/rules/:id/export',{schema:{tags:['Rules'],...paramSchema,summary:'Export a rule without credentials'}},async(req)=>{const a=actor(req),row=ruleRow(idParam(req));ruleResource(a,row,'rules.view');return {format:'filtarr-rule',version:1,rule:JSON.parse(row.draft),source:{id:row.id,creator:row.creator_name}};});
app.post('/api/v1/rules/import',{schema:{tags:['Rules'],summary:'Import a disabled rule draft'}},async(req)=>{const a=need(req,'rules.create');const input=z.object({format:z.literal('filtarr-rule'),version:z.literal(1),rule:ruleSchema,source:z.any().optional()}).parse(req.body);const id=uid(),doc={id,...input.rule};const pos=Number(one('SELECT MAX(position) AS value FROM rules')?.value??0)+1;db.transaction(()=>{run('INSERT INTO rules(id,name,draft,position,created_by,creator_name,source_provenance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',id,doc.name,json(doc),pos,a.id,a.name,json({kind:'import',source:input.source??null}),now(),now());audit('rule.imported',actorInfo(a),'rule',id,{sourceId:input.source?.id??null});})();return {id,draftVersion:1};});
app.post('/api/v1/access-requests/:id/decline',{schema:{tags:['People'],...paramSchema}},async(req)=>{const a=owner(req),request=one('SELECT * FROM access_requests WHERE id=?',idParam(req));if(!request)throw Object.assign(Error('Request not found'),{statusCode:404});db.transaction(()=>{run('UPDATE access_requests SET status=? WHERE id=?','declined',request.id);audit('access.declined',actorInfo(a),'user',request.user_id);})();return {ok:true};});
app.get('/api/v1/settings',{schema:{tags:['Settings']}},async(req)=>{owner(req);return {tmdbConfigured:!!getSetting('tmdb_key_cipher'),omdbConfigured:!!getSetting('omdb_key_cipher'),tautulliUrl:tautulliSettings().url,publicOrigin:configuredOrigin??requestOrigin(req)};});
function plexStatus(){const p=plexSettings();return {scanEnabled:p.scanEnabled,configured:!!(p.url&&p.token),serverName:p.name,url:p.url,accountLinked:!!getSetting('plex_account_token_cipher')};}
async function plexLibraries(url:string,token:string){
  const sections=await plexSections(url,token);
  const roots=all('SELECT name,mappings FROM destinations').flatMap(d=>Object.entries(JSON.parse(d.mappings) as Record<string,Record<string,string>>).flatMap(([,kinds])=>Object.entries(kinds).map(([kind,root])=>({destination:d.name,kind,root}))));
  const matches=roots.map(r=>{const found=locate({mediaType:r.kind as any,arrRoot:r.root,arrPath:r.root},sections);return {...r,library:found?.section.title??null,plexPath:found?.path??null};});
  return {libraries:sections.filter(s=>s.type==='movie'||s.type==='show').map(s=>({title:s.title,type:s.type,locations:s.locations})),matches};
}
app.get('/api/v1/settings/plex',{schema:{tags:['Settings'],summary:'Plex server and scan-after-move settings'}},async(req)=>{owner(req);const status=plexStatus();const p=plexSettings();return {...status,...(p.url&&p.token?await plexLibraries(p.url,p.token).catch(e=>({error:String(e.message??e)})):{})};});
app.get('/api/v1/settings/plex/servers',{schema:{tags:['Settings'],summary:'Plex servers available to the owner account'}},async(req)=>{owner(req);const cipher=getSetting('plex_account_token_cipher');if(!cipher)throw Error('Sign out and sign back in with Plex so Filtarr can find your servers');return (await discoverServers(decrypt(cipher))).map(({accessToken:_t,...server})=>server);});
app.put('/api/v1/settings/plex',{schema:{tags:['Settings'],summary:'Choose a Plex server or toggle scanning after moves',body:{type:'object',properties:{scanEnabled:{type:'boolean'},clientIdentifier:stringField,url:stringField,token:stringField}}}},async(req)=>{
  const a=owner(req);const input=z.object({scanEnabled:z.boolean().optional(),clientIdentifier:z.string().optional(),url:z.string().url().optional(),token:z.string().min(1).optional()}).parse(req.body??{});
  let chosen:{name:string,url:string,token:string}|null=null;
  if(input.clientIdentifier){
    const cipher=getSetting('plex_account_token_cipher');if(!cipher)throw Error('Sign out and sign back in with Plex so Filtarr can find your servers');
    const server=(await discoverServers(decrypt(cipher))).find(s=>s.clientIdentifier===input.clientIdentifier);if(!server)throw Error('Plex server not found');
    const candidates=[...server.connections].sort((x,y)=>Number(x.relay)-Number(y.relay)||Number(y.local)-Number(x.local)).map(c=>c.uri);
    for(const uri of input.url?[input.url,...candidates]:candidates){try{await plexSections(uri,server.accessToken);chosen={name:server.name,url:uri,token:server.accessToken};break;}catch{}}
    if(!chosen)throw Object.assign(Error(`Could not reach ${server.name} at any of its addresses`),{statusCode:502});
  } else if(input.url||input.token){
    if(!input.url||!input.token)throw Error('Enter both the Plex URL and token');
    await plexSections(input.url,input.token);chosen={name:new URL(input.url).host,url:input.url.replace(/\/$/,''),token:input.token};
  }
  db.transaction(()=>{
    if(input.scanEnabled!==undefined)setSetting('plex_scan_enabled',input.scanEnabled?'1':'0');
    if(chosen){setSetting('plex_server_name',chosen.name);setSetting('plex_server_url',chosen.url);setSetting('plex_server_token_cipher',encrypt(chosen.token));}
    audit('plex.settings_updated',actorInfo(a),'settings','plex',{scanEnabled:input.scanEnabled,server:chosen?.name,url:chosen?.url});
  })();
  const p=plexSettings();return {...plexStatus(),...(p.url&&p.token?await plexLibraries(p.url,p.token):{})};
});
app.put('/api/v1/settings/tmdb',{schema:{tags:['Settings']}},async(req)=>{const a=owner(req),input=z.object({apiToken:z.string().min(1)}).parse(req.body);db.transaction(()=>{setSetting('tmdb_key_cipher',encrypt(input.apiToken));audit('metadata.tmdb.updated',actorInfo(a),'settings','tmdb');})();return {ok:true};});
app.delete('/api/v1/settings/tmdb',{schema:{tags:['Settings']}},async(req)=>{const a=owner(req);db.transaction(()=>{run("DELETE FROM settings WHERE key='tmdb_key_cipher'");audit('metadata.tmdb.removed',actorInfo(a),'settings','tmdb');})();return {ok:true};});
app.put('/api/v1/settings/omdb',{schema:{tags:['Settings'],summary:'Save and verify an OMDb API key'}},async(req)=>{const a=owner(req),input=z.object({apiKey:z.string().trim().min(1)}).parse(req.body);await omdbTest(input.apiKey);db.transaction(()=>{setSetting('omdb_key_cipher',encrypt(input.apiKey));audit('metadata.omdb.updated',actorInfo(a),'settings','omdb');})();return {ok:true};});
app.delete('/api/v1/settings/omdb',{schema:{tags:['Settings']}},async(req)=>{const a=owner(req);db.transaction(()=>{run("DELETE FROM settings WHERE key='omdb_key_cipher'");audit('metadata.omdb.removed',actorInfo(a),'settings','omdb');})();return {ok:true};});
app.put('/api/v1/settings/tautulli',{schema:{tags:['Settings'],summary:'Save and verify a Tautulli connection for watch history'}},async(req)=>{const a=owner(req),input=z.object({url:z.string().trim().url(),apiKey:z.string().trim().min(1)}).parse(req.body);const url=input.url.replace(/\/+$/,'');const info=await tautulliCall(url,input.apiKey,'get_tautulli_info') as Row;db.transaction(()=>{setSetting('tautulli_url',url);setSetting('tautulli_key_cipher',encrypt(input.apiKey));audit('watch.tautulli.updated',actorInfo(a),'settings','tautulli',{url});})();clearSourceCache();return {ok:true,version:info?.tautulli_version??null};});
app.delete('/api/v1/settings/tautulli',{schema:{tags:['Settings']}},async(req)=>{const a=owner(req);db.transaction(()=>{run("DELETE FROM settings WHERE key IN ('tautulli_url','tautulli_key_cipher')");audit('watch.tautulli.removed',actorInfo(a),'settings','tautulli');})();clearSourceCache();return {ok:true};});
let warming: Promise<unknown>|undefined;
/** Loads library values (genres, networks, Plex users…) in the background so the rule editor can suggest them; skips per-title providers like TMDB. */
const warmSuggestions=()=>{warming??=inventory(fields.filter(f=>f.sources.every(s=>s==='arr'||s==='plex'||s==='watch')).map(f=>f.key)).catch(()=>undefined).finally(()=>{warming=undefined;});};
app.get('/api/v1/fields',{schema:{tags:['Rules'],summary:'Fields rules can filter on, which providers are set up, and values seen in the library'}},async(req)=>{actor(req);if(!Object.keys(suggestions()).length)warmSuggestions();const plex=plexSettings();return {fields,providers:{plex:!!(plex.url&&plex.token),watch:!!(plex.url&&plex.token)||!!tautulliSettings().url,tmdb:!!getSetting('tmdb_key_cipher'),omdb:!!getSetting('omdb_key_cipher')},watchSource:tautulliSettings().url?'Tautulli':'Plex',suggestions:suggestions()};});

// Serve the compiled web app in the single-image deployment.
if(process.env.FILTARR_WEB_DIST){
  const {default:staticPlugin}=await import('@fastify/static');
  const {join}=await import('node:path');
  await app.register(staticPlugin,{root:process.env.FILTARR_WEB_DIST,prefix:'/'});
  app.setNotFoundHandler((req,reply)=>{if(req.url.startsWith('/api')||req.url.startsWith('/auth'))return reply.code(404).send({error:'Not found'});return reply.sendFile('index.html');});
}
const setup=ensureSetupToken();if(setup)app.log.warn(`First-run setup token: ${setup}`);
startWorker();
const port=Number(process.env.PORT??3001);
await app.listen({port,host:'0.0.0.0'});
process.on('SIGTERM',()=>{stopWorker();void app.close();});
