import { createHash } from 'node:crypto';
import { nextScheduleRun } from './schedule.js';
import { fieldByKey, fieldsIn, plan, type MediaItem, type RuleDocument, type ItemPlan, type Action } from '@filtarr/core';
import { all, audit, db, now, one, operationLog, run, uid, type Row } from './db.js';
import { arrRequest, connections, getConnection, getOne, move, normalizeMedia, rawMedia, roots, targetPath, updateItem, type ArrConnection } from './arr.js';
import { enrich } from './metadata.js';
import { enrichSources } from './sources.js';
import { scanAfterMoves, type ScanTarget } from './plex.js';
import { allowed, type Actor } from './security.js';

export function publishedRules(scope: 'all'|'one', ruleId?: string): {rule: RuleDocument; publisherId: string; creatorId: string}[] {
  const rows=all('SELECT r.*,v.document,v.publisher_id FROM rules r JOIN rule_revisions v ON v.rule_id=r.id AND v.revision=r.published_revision WHERE r.enabled=1 AND r.archived=0 ORDER BY r.position');
  return rows.filter(row=>scope==='all'||row.id===ruleId).map(row=>({rule:JSON.parse(row.document),publisherId:row.publisher_id,creatorId:row.created_by}));
}
/** Every media item from Sonarr/Radarr, plus values from the optional providers that the given rule fields need. */
export async function inventory(fieldKeys: Iterable<string>=[]): Promise<MediaItem[]> {
  const out: MediaItem[]=[];
  for (const connection of connections()) {
    try {
      const raw=await rawMedia(connection);
      const base=await normalizeMedia(connection,undefined,raw);
      const byId=new Map(raw.map(r=>[r.id,r]));
      for (const item of base) out.push(await enrich(item,connection,byId.get(item.upstreamId)??{}));
    } catch (error) { audit('inventory.error',null,'connection',connection.id,{message:String(error)});operationLog('error','Inventory refresh failed',{connectionId:connection.id,error:String(error)});throw error; }
  }
  await enrichSources(out,fieldKeys,item=>getConnection(item.connectionId)?.rating_region??'US');
  rememberValues(out);
  return out;
}
const seenValues=new Map<string,Map<string,number>>();
/** Remembers values seen in the latest inventory so the rule editor can suggest them (e.g. genres, networks, Plex users). */
function rememberValues(items: MediaItem[]) {
  const add=(key: string, value: unknown)=>{if (typeof value!=='string'||!value.trim()) return;const counts=seenValues.get(key)??new Map<string,number>();counts.set(value,(counts.get(value)??0)+1);seenValues.set(key,counts);};
  const keys=new Set<string>(['genre','tag']);for (const item of items) for (const key of Object.keys(item.meta??{})) keys.add(key);
  for (const key of keys) seenValues.delete(key);
  for (const item of items) {
    item.genre.forEach(g=>add('genre',g));item.tags.forEach(t=>add('tag',t));if (item.certification) add('certification',item.certification);
    for (const [key,value] of Object.entries(item.meta??{})) (Array.isArray(value)?value:[value]).forEach(v=>add(key,v));
  }
}
export function suggestions(): Record<string,string[]> {
  return Object.fromEntries([...seenValues].filter(([key])=>{const type=fieldByKey.get(key)?.type;return type==='list'||type==='enum'||(type==='text'&&!['title','originalTitle','alternateTitles','overview','path','tagline','awards','imdbId','tmdbId','tvdbId'].includes(key));})
    .map(([key,counts])=>[key,[...counts].sort((a,b)=>b[1]-a[1]).slice(0,200).map(([v])=>v).sort((a,b)=>a.localeCompare(b))]));
}
export function ruleFields(rules: RuleDocument[]): Set<string> { const keys=new Set<string>();for (const rule of rules) fieldsIn(rule.condition,keys);return keys; }
/** Stored plans keep only the field values the rules looked at, so runs stay small and still show why items matched. */
export function compactPlans(plans: ItemPlan[], keys: Set<string>): ItemPlan[] {
  return plans.map(p=>({...p,item:{...p.item,meta:p.item.meta?Object.fromEntries(Object.entries(p.item.meta).filter(([k])=>keys.has(k))):undefined}}));
}
/** What a plan would do, ignoring field values that drift between a preview and its apply (e.g. days since watched). */
const planOutcome=(plans: ItemPlan[])=>JSON.stringify(plans.map(p=>[p.item.id,p.changes,p.blocked??null]));
export function actorById(id: string, tokenId?: string): Actor | null {
  const u=one('SELECT * FROM users WHERE id=?',id); if (!u) return null;
  const token=tokenId?one('SELECT * FROM api_tokens WHERE id=?',tokenId):undefined;
  if (tokenId && (!token || token.revoked_at || (token.expires_at && token.expires_at<=now()))) return null;
  return {id:u.id,name:u.name,role:u.role,status:u.status,grants:JSON.parse(u.grants),via:token?'token':'session',tokenId:token?.id,tokenGrants:token?JSON.parse(token.grants):undefined};
}
function canUse(actor: Actor, item: MediaItem, action: Action): boolean {
  const resource={connectionId:item.connectionId,root:item.rootFolderPath??undefined,destinationId:action.type==='move'?action.destinationId:undefined};
  return allowed(actor,action.type==='move'?'actions.move':action.type==='monitor'?'actions.monitor':'actions.tags',resource);
}
export function preflight(planItem: ItemPlan, actor: Actor): string | undefined {
  if (planItem.blocked) return planItem.blocked;
  for (const action of planItem.changes) {
    if (!canUse(actor,planItem.item,action)) return `No permission for ${action.type}`;
    if (action.type==='move') {
      if (!targetPath(action.destinationId,planItem.item.connectionId,planItem.item.mediaType)) return 'Destination has no root folder mapping';
    }
  }
}
export function authorizeRules(actor: Actor, scope: 'all'|'one', ruleId?: string, capability: 'rules.preview'|'rules.run'='rules.run') {
  const rules=publishedRules(scope,ruleId);
  if (scope==='one' && !rules.length) throw Error('No published enabled rule');
  for (const r of rules) if (!allowed(actor,capability,{ruleId:r.rule.id,ruleCreatorId:r.creatorId})) throw Error('Access denied for participating rules');
  return rules;
}
export async function makePlan(actor: Actor, scope: 'all'|'one', ruleId?: string) {
  const rules=authorizeRules(actor,scope,ruleId,'rules.preview');
  const allItems=await inventory(ruleFields(rules.map(r=>r.rule)));
  const items=allItems.filter(item=>allowed(actor,'media.view',{connectionId:item.connectionId,root:item.rootFolderPath??undefined}));
  if (scope==='all' && items.length !== allItems.length) throw Error('Full run requires access to all sources');
  const result=plan(items,rules.map(r=>r.rule));
  for (const item of result) item.blocked=preflight(item,actor);
  return result;
}
export function createRun(actor: Actor, mode: 'preview'|'apply', scope: 'all'|'one', ruleId?: string, idempotencyKey?: string, previewRunId?: string, scheduleId?: string): Row {
  const participating=authorizeRules(actor,scope,ruleId,mode==='preview'?'rules.preview':'rules.run');
  if (previewRunId) { const preview=one('SELECT * FROM runs WHERE id=? AND mode=? AND status=?',previewRunId,'preview','completed'); if (!preview || preview.actor_id!==actor.id || preview.scope!==scope || preview.rule_id!==(ruleId??null)) throw Error('Preview is unavailable for this run'); }
  const payload=JSON.stringify({mode,scope,ruleId,previewRunId});
  const fingerprint=createHash('sha256').update(payload).digest('hex');
  if (idempotencyKey) {
    const existing=one('SELECT * FROM idempotency WHERE key=? AND actor_id=?',idempotencyKey,actor.id);
    if (existing) { if (existing.payload_hash!==fingerprint) throw Error('Idempotency key conflict'); return one('SELECT * FROM runs WHERE id=?',existing.run_id)!; }
  }
  const id=uid();
  const publishers=[...new Set(participating.map(r=>one('SELECT publisher_name FROM rule_revisions WHERE rule_id=? AND publisher_id=? ORDER BY revision DESC LIMIT 1',r.rule.id,r.publisherId)?.publisher_name).filter(Boolean))];
  db.transaction(()=>{
    run('INSERT INTO runs(id,mode,scope,rule_id,status,actor_id,actor_name,token_id,preview_run_id,run_origin,schedule_id,publisher_names,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,mode,scope,ruleId??null,'queued',actor.id,actor.name,actor.tokenId??null,previewRunId??null,scheduleId?'scheduler':'manual',scheduleId??null,JSON.stringify(publishers),now());
    if (idempotencyKey) run('INSERT INTO idempotency(key,actor_id,payload_hash,run_id) VALUES(?,?,?,?)',idempotencyKey,actor.id,fingerprint,id);
    audit('run.queued',{id:actor.id,name:actor.name,tokenId:actor.tokenId},'run',id,{mode,scope,ruleId,origin:scheduleId?'scheduler':'manual',scheduleId,publishers});
  })();
  return one('SELECT * FROM runs WHERE id=?',id)!;
}
async function verifyMove(connection: ArrConnection, id: number, target: string, hadFile: boolean): Promise<boolean> {
  const inside=(path:string)=>path===target || path.startsWith(target.replace(/[\\/]$/,'')+(target.includes('\\')?'\\':'/'));
  for (let i=0;i<30;i++) {
    const current=await getOne(connection,id);
    if (inside(String(current.path??'')) && !current.pendingPath) {
      if (!hadFile) return true;
      let paths:string[]=[];
      if (connection.kind==='movie') {
        const record=current.movieFile??(current.movieFileId?await arrRequest<Record<string,any>>(connection,`moviefile/${current.movieFileId}`):null);
        if (record?.path) paths=[String(record.path)];
      } else {
        const files=await arrRequest<Record<string,any>[]>(connection,`episodefile?seriesId=${id}`);
        paths=files.map(file=>String(file.path??'')).filter(Boolean);
      }
      if (paths.length>0 && paths.every(inside)) return true;
    }
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  return false;
}
async function executeItem(runId: string, itemPlan: ItemPlan, actor: Actor, scanTargets: ScanTarget[] = []) {
  if (itemPlan.blocked) return {changed:false,failed:true};
  if (!itemPlan.changes.length) return {changed:false,failed:false};
  const connection=getConnection(itemPlan.item.connectionId); if (!connection) return {changed:false,failed:true};
  let expectedPath=String(itemPlan.item.path??'');
  for (const action of itemPlan.changes) {
    if (one('SELECT status FROM runs WHERE id=?',runId)?.status==='cancelled') return {changed:false,failed:false};
    const refreshed=actorById(actor.id,actor.tokenId);
    if (!refreshed || !canUse(refreshed,itemPlan.item,action)) return {changed:false,failed:true};
    const live=await getOne(connection,itemPlan.item.upstreamId);
    if (String(live.path??'')!==expectedPath) return {changed:false,failed:true};
    const attemptId=uid();
    run('INSERT INTO action_attempts(id,run_id,media_id,action,status,before_value,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',attemptId,runId,itemPlan.item.id,JSON.stringify(action),'pending',JSON.stringify(itemPlan.item),now(),now());
    try {
      if (action.type==='move') {
        const path=targetPath(action.destinationId,connection.id,connection.kind);
        if (!path) throw Error('Destination mapping removed');
        const current=await getOne(connection,itemPlan.item.upstreamId);
        if (String(current.path??'').startsWith(path)) {
          const verified=await verifyMove(connection,itemPlan.item.upstreamId,path,itemPlan.item.hasFile);
          run('UPDATE action_attempts SET status=?,updated_at=? WHERE id=?',verified?'verified':'uncertain',now(),attemptId);
          if (!verified) return {changed:false,failed:true};
          expectedPath=String(current.path??'');
          continue;
        }
        await move(connection,itemPlan.item.upstreamId,path);
        run('UPDATE action_attempts SET status=?,updated_at=? WHERE id=?','submitted',now(),attemptId);
        const verified=await verifyMove(connection,itemPlan.item.upstreamId,path,itemPlan.item.hasFile);
        if (!verified) { run('UPDATE action_attempts SET status=?,error=?,updated_at=? WHERE id=?','uncertain','Move was accepted but has not been verified',now(),attemptId);operationLog('warn','Move needs reconciliation',{runId,mediaId:itemPlan.item.id,attemptId});return {changed:true,failed:true}; }
        const previousPath=expectedPath;expectedPath=String((await getOne(connection,itemPlan.item.upstreamId)).path??'');
        scanTargets.push({mediaType:connection.kind,arrRoot:String(itemPlan.item.rootFolderPath??''),arrPath:previousPath},{mediaType:connection.kind,arrRoot:path,arrPath:expectedPath});
      } else { await updateItem(connection,itemPlan.item.upstreamId,action); run('UPDATE action_attempts SET status=?,updated_at=? WHERE id=?','submitted',now(),attemptId); }
      run('UPDATE action_attempts SET status=?,after_value=?,updated_at=? WHERE id=?','verified',JSON.stringify(action),now(),attemptId);
      audit('action.verified',{id:actor.id,name:actor.name,tokenId:actor.tokenId},'run',runId,{mediaId:itemPlan.item.id,action});
    } catch (error) {
      const failed=/\b(400|401|403|404|422)\b/.test(String(error));
      run('UPDATE action_attempts SET status=?,error=?,updated_at=? WHERE id=?',failed?'failed':'uncertain',String(error),now(),attemptId);
      operationLog('error','Action failed',{runId,mediaId:itemPlan.item.id,attemptId,status:failed?'failed':'uncertain',error:String(error)});
      return {changed:false,failed:true};
    }
  }
  return {changed:true,failed:false};
}
let busy=false;
export async function workOnce() {
  if (busy) return; busy=true;
  try {
    const job=one('SELECT * FROM runs WHERE status=? ORDER BY created_at LIMIT 1','queued'); if (!job) return;
    run('UPDATE runs SET status=?,started_at=? WHERE id=?','running',now(),job.id);
    const actor=job.actor_id?actorById(job.actor_id,job.token_id):null;
    if (!actor) throw Error('Initiating user or token is no longer authorized');
    const ruleSet=authorizeRules(actor,job.scope,job.rule_id,job.mode==='preview'?'rules.preview':'rules.run');
    const keys=ruleFields(ruleSet.map(r=>r.rule));
    const allItems=await inventory(keys);
    if (job.scope==='all' && allItems.some(item=>!allowed(actor,'media.view',{connectionId:item.connectionId,root:item.rootFolderPath??undefined}))) throw Error('Full run requires access to all sources');
    const items=allItems.filter(item=>allowed(actor,'media.view',{connectionId:item.connectionId,root:item.rootFolderPath??undefined}));
    const plans=compactPlans(plan(items,ruleSet.map(r=>r.rule)),keys);
    for (const p of plans) p.blocked=preflight(p,actor);
    if (job.preview_run_id) { const preview=one('SELECT plan FROM runs WHERE id=?',job.preview_run_id); if (!preview?.plan || planOutcome(JSON.parse(preview.plan))!==planOutcome(plans)) throw Error('Preview is stale; refresh it before applying'); }
    run('UPDATE runs SET plan=?,total=? WHERE id=?',JSON.stringify(plans),plans.length,job.id);
    if (job.mode==='apply') {
      let changed=0,failed=0;const scanTargets:ScanTarget[]=[];
      for (const item of plans) {
        if (one('SELECT status FROM runs WHERE id=?',job.id)?.status==='cancelled') break;
        const initiator=actorById(actor.id,actor.tokenId);
        if (!initiator || ruleSet.some(r=>!allowed(initiator,'rules.run',{ruleId:r.rule.id,ruleCreatorId:r.creatorId}))) { failed++; continue; }
        const matched=ruleSet.filter(r=>item.trace.some(t=>t.ruleId===r.rule.id&&t.matched===true));
        const publisherInvalid=matched.some(r=>{
          const publisher=actorById(r.publisherId);
          if (!publisher || !allowed(publisher,'rules.publish',{ruleId:r.rule.id,ruleCreatorId:r.creatorId})) return true;
          return r.rule.actions.some(action=>!canUse(publisher,item.item,action));
        });
        if (publisherInvalid) { failed++; continue; }
        const result=await executeItem(job.id,item,initiator,scanTargets); if(result.changed)changed++; if(result.failed)failed++;
        run('UPDATE runs SET changed=?,failed=? WHERE id=?',changed,failed,job.id);
      }
      await scanAfterMoves(job.id,scanTargets);
    }
    const status=one('SELECT status,failed FROM runs WHERE id=?',job.id);
    if (status?.status!=='cancelled') run('UPDATE runs SET status=?,finished_at=? WHERE id=?',Number(status?.failed)>0?'partial':'completed',now(),job.id);
    audit('run.finished',{id:actor.id,name:actor.name,tokenId:actor.tokenId},'run',job.id,{status:one('SELECT status FROM runs WHERE id=?',job.id)?.status});
  } catch (error) {
    operationLog('error','Run worker failed',{error:String(error)});
    const active=one('SELECT id FROM runs WHERE status=? ORDER BY started_at DESC LIMIT 1','running');
    if (active) run('UPDATE runs SET status=?,error=?,finished_at=? WHERE id=?','failed',String(error),now(),active.id);
  } finally { busy=false; }
}
let timer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
function pruneHistory(){
  const auditCutoff=new Date(Date.now()-365*86400000).toISOString();
  const runCutoff=new Date(Date.now()-90*86400000).toISOString();
  const logCutoff=new Date(Date.now()-14*86400000).toISOString();
  db.transaction(()=>{
    run('DELETE FROM audit WHERE created_at<?',auditCutoff);
    run('DELETE FROM operational_logs WHERE created_at<?',logCutoff);
    const old=all("SELECT id FROM runs WHERE created_at<? AND status IN ('completed','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM action_attempts a WHERE a.run_id=runs.id AND a.status='uncertain')",runCutoff);
    for(const item of old){run('DELETE FROM action_attempts WHERE run_id=?',item.id);run('DELETE FROM idempotency WHERE run_id=?',item.id);run('DELETE FROM runs WHERE id=?',item.id);}
    run('DELETE FROM api_metrics WHERE day<?',auditCutoff.slice(0,10));
    run('DELETE FROM metadata_cache WHERE expires_at<?',now());
    run('DELETE FROM sessions WHERE expires_at<?',now());
    run('DELETE FROM plex_attempts WHERE expires_at<?',now());
  })();
}
export function startWorker() {
  for (const interrupted of all("SELECT id FROM runs WHERE status='running'")) {
    run("UPDATE runs SET status='partial',error=?,finished_at=? WHERE id=?",'Interrupted by restart; inspect outcomes before rerunning',now(),interrupted.id);
    run("UPDATE action_attempts SET status='uncertain',error=?,updated_at=? WHERE run_id=? AND status IN ('pending','submitted')",'Restart interrupted verification',now(),interrupted.id);
    audit('run.interrupted',null,'run',interrupted.id);
    operationLog('warn','Run interrupted by restart',{runId:interrupted.id});
  }
  timer=setInterval(()=>{void workOnce();void scheduleDue();},2500);
  retentionTimer=setInterval(pruneHistory,6*3600000);
  pruneHistory();
  void workOnce();
}
export function stopWorker() { if(timer)clearInterval(timer); if(retentionTimer)clearInterval(retentionTimer); }
export async function scheduleDue() {
  for (const schedule of all('SELECT * FROM schedules WHERE enabled=1 AND next_at<=?',now())) {
    const actor=actorById(schedule.configured_by);
    if (actor && !one("SELECT id FROM runs WHERE status IN ('queued','running') AND scope='all' LIMIT 1")) {
      try { createRun(actor,'apply','all',undefined,undefined,undefined,schedule.id); } catch(error) { audit('schedule.error',{id:actor.id,name:actor.name},'schedule',schedule.id,{error:String(error)});operationLog('error','Scheduled run could not be queued',{scheduleId:schedule.id,error:String(error)}); }
    }
    const next=nextScheduleRun(schedule.expression,schedule.timezone);
    run('UPDATE schedules SET next_at=? WHERE id=?',next?.toISOString()??null,schedule.id);
  }
}
