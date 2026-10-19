import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { starterRules } from '@filtarr/core';
process.env.FILTARR_SECRET_KEY='2'.repeat(64);
process.env.FILTARR_DB=`/tmp/filtarr-worker-${randomUUID()}.db`;
const { db, run, one, now }=await import('./db.js');
const { encrypt,createToken,authenticate }=await import('./security.js');
const { createRun, preflight, workOnce }=await import('./worker.js');
let server:Server,port:number,moveCount=0;
let movie:any={id:1,title:'Family Movie',path:'/media/regular/Family Movie',rootFolderPath:'/media/regular',certification:'PG',genres:['Family'],tags:[],monitored:true,hasFile:true,movieFileId:11,movieFile:{id:11,path:'/media/regular/Family Movie/movie.mkv'}};
const actor={id:'owner',name:'Test Owner',role:'owner',status:'active',grants:[],via:'session' as const};
beforeAll(async()=>{
  server=createServer(async(req,res)=>{
    let data:unknown;
    if(req.url==='/api/v3/movie/editor' && req.method==='PUT'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if (body.rootFolderPath) moveCount++;
      if (body.rootFolderPath) movie={...movie,path:`${body.rootFolderPath}/Family Movie`,rootFolderPath:body.rootFolderPath,movieFile:{id:11,path:`${body.rootFolderPath}/Family Movie/movie.mkv`}};
      if (body.tags) movie.tags=body.applyTags==='add'?[...new Set([...movie.tags,...body.tags])]:movie.tags.filter((id:number)=>!body.tags.includes(id));
      data=[movie];
    } else if(req.url==='/api/v3/movie')data=[movie];
    else if(req.url==='/api/v3/movie/1')data=movie;
    else if(req.url==='/api/v3/moviefile/11')data=movie.movieFile;
    else if(req.url==='/api/v3/tag')data=[{id:1,label:'family'}];
    else if(req.url==='/api/v3/rootfolder')data=[{id:1,path:'/media/regular'},{id:2,path:'/media/kids'}];
    else if(req.url==='/api/v3/system/status')data={version:'5.0.0'};
    else {res.statusCode=404;data={error:'unknown path',path:req.url};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address() as any).port;
  run('INSERT INTO users(id,plex_id,name,role,status,grants,created_at) VALUES(?,?,?,?,?,?,?)','owner','plex-owner','Test Owner','owner','active','[]',now());
  run('INSERT INTO connections(id,kind,name,url,api_key_cipher,rating_region,created_at) VALUES(?,?,?,?,?,?,?)','radarr','movie','Fake Radarr',`http://127.0.0.1:${port}`,encrypt('fake-api-key'),'US',now());
  run('INSERT INTO destinations(id,name,mappings,created_at) VALUES(?,?,?,?)','kids','Kids',JSON.stringify({radarr:{movie:'/media/kids'}}),now());
  run('INSERT INTO destinations(id,name,mappings,created_at) VALUES(?,?,?,?)','regular','Regular',JSON.stringify({radarr:{movie:'/media/regular'}}),now());
  for(const [position,rule] of starterRules('kids','regular').entries()){
    run('INSERT INTO rules(id,name,draft,published_revision,enabled,position,created_by,creator_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',rule.id,rule.name,JSON.stringify(rule),1,1,position+1,'owner','Test Owner',now(),now());
    run('INSERT INTO rule_revisions(rule_id,revision,document,publisher_id,publisher_name,published_at) VALUES(?,?,?,?,?,?)',rule.id,1,JSON.stringify(rule),'owner','Test Owner',now());
  }
});
afterAll(async()=>{server.close();await once(server,'close');db.close();});
describe('preview and Arr movement',()=>{
  it('previews without calling the Arr editor',async()=>{const queued=createRun(actor,'preview','all');await workOnce();const result=one('SELECT * FROM runs WHERE id=?',queued.id)!;expect(result.status).toBe('completed');expect(JSON.parse(result.plan)[0].changes).toEqual([{type:'move',destinationId:'kids'}]);expect(moveCount).toBe(0);});
  it('submits and verifies a root folder move, then becomes idempotent',async()=>{const queued=createRun(actor,'apply','all');await workOnce();const result=one('SELECT * FROM runs WHERE id=?',queued.id)!;expect(result.status).toBe('completed');expect(result.changed).toBe(1);expect(moveCount).toBe(1);expect(one('SELECT status FROM action_attempts WHERE run_id=?',queued.id)?.status).toBe('verified');const second=createRun(actor,'apply','all');await workOnce();expect(one('SELECT changed FROM runs WHERE id=?',second.id)?.changed).toBe(0);expect(moveCount).toBe(1);});
  it('can apply a tag after a verified move',async()=>{
    movie={...movie,path:'/media/regular/Family Movie',rootFolderPath:'/media/regular',movieFile:{id:11,path:'/media/regular/Family Movie/movie.mkv'},tags:[]};
    const rule=one('SELECT * FROM rules WHERE name=?','Kids')!;const document=JSON.parse(rule.draft);document.actions.push({type:'addTag',tag:'family'});
    run('UPDATE rules SET published_revision=2 WHERE id=?',rule.id);
    run('INSERT INTO rule_revisions(rule_id,revision,document,publisher_id,publisher_name,published_at) VALUES(?,?,?,?,?,?)',rule.id,2,JSON.stringify(document),'owner','Test Owner',now());
    const queued=createRun(actor,'apply','all');await workOnce();
    expect(one('SELECT status FROM runs WHERE id=?',queued.id)?.status).toBe('completed');expect(movie.tags).toContain(1);expect(moveCount).toBe(2);
  });
  it('rejects applying a stale preview',async()=>{const preview=createRun(actor,'preview','all');await workOnce();movie={...movie,path:'/media/regular/Family Movie',rootFolderPath:'/media/regular',movieFile:{id:11,path:'/media/regular/Family Movie/movie.mkv'},tags:[]};const submitted=createRun(actor,'apply','all',undefined,undefined,preview.id);await workOnce();expect(one('SELECT status,error FROM runs WHERE id=?',submitted.id)?.status).toBe('failed');expect(moveCount).toBe(2);});
  it('requires the granted source root and target destination for a move',()=>{
    const item={id:'radarr:movie:1',connectionId:'radarr',upstreamId:1,mediaType:'movie' as const,title:'Family Movie',certification:'PG',genre:[],tags:[],monitored:true,hasFile:true,rootFolderPath:'/media/regular'};
    const proposal={item,trace:[],desired:{destination:'kids',tags:[],monitored:true},changes:[{type:'move' as const,destinationId:'kids'}]};
    const limited={...actor,role:'operator',grants:[{capability:'actions.move' as const,connections:['radarr'],roots:['/media/regular'],destinations:['regular']}]} ;
    expect(preflight(proposal,limited)).toMatch(/permission/);
    limited.grants[0]!.destinations=['kids'];limited.grants[0]!.roots=['/media/other'];
    expect(preflight(proposal,limited)).toMatch(/permission/);
    limited.grants[0]!.roots=['/media/regular'];
    expect(preflight(proposal,limited)).toBeUndefined();
  });
  it('does not start queued work after its initiating token is revoked',async()=>{
    const id=randomUUID(),kids=one('SELECT id FROM rules WHERE name=?','Kids')!;
    const grants=[{capability:'rules.run',rules:[kids.id],connections:'all',destinations:'all',roots:'all'},{capability:'media.view',rules:'all',connections:'all',destinations:'all',roots:'all'},{capability:'actions.move',rules:'all',connections:'all',destinations:'all',roots:'all'}];
    run('INSERT INTO users(id,plex_id,name,role,status,grants,created_at) VALUES(?,?,?,?,?,?,?)',id,randomUUID(),'Automation','operator','active',JSON.stringify(grants),now());
    const token=createToken(id,'Test automation',grants as any,new Date(Date.now()+86400000).toISOString());
    const initiated=authenticate({headers:{authorization:`Bearer ${token.token}`},cookies:{}} as any)!;
    const queued=createRun(initiated,'apply','one',kids.id),before=moveCount;
    run('UPDATE api_tokens SET revoked_at=? WHERE id=?',now(),token.id);
    await workOnce();
    expect(one('SELECT status FROM runs WHERE id=?',queued.id)?.status).toBe('failed');expect(moveCount).toBe(before);
  });
  it('records scheduler, configuring user, and publisher attribution',()=>{
    const kids=one('SELECT id FROM rules WHERE name=?','Kids')!;
    const queued=createRun(actor,'apply','one',kids.id,undefined,undefined,'schedule-1');
    const record=one('SELECT run_origin,schedule_id,actor_name,publisher_names FROM runs WHERE id=?',queued.id)!;
    expect(record.run_origin).toBe('scheduler');expect(record.schedule_id).toBe('schedule-1');
    expect(record.actor_name).toBe('Test Owner');expect(JSON.parse(record.publisher_names)).toContain('Test Owner');
  });
  it('deduplicates run submissions by idempotency key and rejects changed input',()=>{
    const key=randomUUID(),first=createRun(actor,'preview','all',undefined,key);
    expect(createRun(actor,'preview','all',undefined,key).id).toBe(first.id);
    expect(()=>createRun(actor,'apply','all',undefined,key)).toThrow(/conflict/i);
  });
});
