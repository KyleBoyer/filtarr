import { fieldByKey, type FieldSource, type MediaItem, type MetaValue } from '@filtarr/core';
import { all, getSetting, now, one, operationLog, run, type Row } from './db.js';
import { plexSettings } from './plex.js';
import { decrypt } from './security.js';

// Optional providers behind the rule field catalog. Each is queried only when a rule uses one of its fields.
const empty=(v: MetaValue|undefined)=>v==null||v===''||(Array.isArray(v)&&!v.length);
const uniq=(values: (string|null|undefined)[])=>[...new Set(values.filter((v): v is string=>!!v&&!!v.trim()))];
const tags=(v: unknown)=>Array.isArray(v)?uniq(v.map((t: Row)=>t?.tag)):[];
const titleKey=(title: unknown)=>String(title??'').toLowerCase().replace(/\s*\(\d{4}\)\s*$/,'').replace(/[^a-z0-9]+/g,'');
const yearOf=(v: unknown)=>{const m=/^(\d{4})/.exec(String(v??''));return m?Number(m[1]):undefined;};
const iso=(seconds: unknown)=>typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>0?new Date(seconds*1000).toISOString():null;
async function pool<T>(items: T[], size: number, work: (item: T)=>Promise<void>) {
  let next=0;await Promise.all(Array.from({length:Math.min(size,items.length)},async()=>{while(next<items.length)await work(items[next++]!);}));
}
function cached<T>(key: string): T|undefined { const row=one<{value:string,expires_at:string}>('SELECT value,expires_at FROM metadata_cache WHERE key=?',key);return row&&row.expires_at>now()?JSON.parse(row.value) as T:undefined; }
function cache(key: string, value: unknown, days: number) { run('INSERT INTO metadata_cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at',key,JSON.stringify(value),new Date(Date.now()+days*86400000).toISOString()); }

// ---------- Plex library and watch history ----------
interface PlexEntry { ratingKey: string; library: string; kind: 'movie'|'series'; titleKey: string; year?: number; guids: string[]; raw: Row }
interface Play { key: string; titleKey: string; year?: number; episode?: string; at: number; user: string; watched: boolean }
interface PlexIndex { entries: PlexEntry[]; byGuid: Map<string,PlexEntry[]>; plays: Map<string,Play[]>; orphanPlays: Map<string,Play[]>; error?: string }
let plexMemo: { at: number; withHistory: boolean; index: PlexIndex }|undefined;
async function plexGet(url: string, token: string, path: string): Promise<Row> {
  const response=await fetch(`${url.replace(/\/$/,'')}${path}`,{headers:{Accept:'application/json','X-Plex-Token':token},signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw Error(`Plex ${response.status} ${response.statusText}`);
  return await response.json() as Row;
}
async function plexPaged(url: string, token: string, path: string, size: number, limit=100000): Promise<Row[]> {
  const out: Row[]=[];
  for (let start=0;start<limit;start+=size) {
    const container=(await plexGet(url,token,`${path}${path.includes('?')?'&':'?'}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`)).MediaContainer??{};
    const rows=(container.Metadata??[]) as Row[];out.push(...rows);
    if (rows.length<size || out.length>=Number(container.totalSize??0)) break;
  }
  return out;
}
/** Plex user names by account id: the server's own list, then plex.tv friends, then people who signed in to Filtarr. */
async function plexAccounts(url: string, token: string): Promise<Map<string,string>> {
  const names=new Map<string,string>();
  for (const account of (await plexGet(url,token,'/accounts').catch(()=>({}) as Row)).MediaContainer?.Account??[]) if (account.name) names.set(String(account.id),String(account.name));
  const accountCipher=getSetting('plex_account_token_cipher');
  if (accountCipher) {
    const friends=await fetch('https://plex.tv/api/v2/friends',{headers:{Accept:'application/json','X-Plex-Token':decrypt(accountCipher),'X-Plex-Client-Identifier':getSetting('plex_client_id')??'filtarr'},signal:AbortSignal.timeout(15000)}).then(r=>r.ok?r.json():[]).catch(()=>[]) as Row[];
    for (const friend of Array.isArray(friends)?friends:[]) if (!names.has(String(friend.id))) names.set(String(friend.id),String(friend.title||friend.username||friend.id));
  }
  for (const user of all('SELECT plex_id,name FROM users')) if (!names.has(String(user.plex_id))) names.set(String(user.plex_id),String(user.name));
  return names;
}
async function plexPlays(url: string, token: string): Promise<Play[]> {
  const [rows,names]=await Promise.all([plexPaged(url,token,'/status/sessions/history/all?sort=viewedAt:desc',2000),plexAccounts(url,token)]);
  return rows.filter(r=>r.type==='movie'||r.type==='episode').map(r=>{
    const episode=r.type==='episode';
    return {key:episode?String(r.grandparentKey??'').split('/').pop()!:String(r.ratingKey),titleKey:titleKey(episode?r.grandparentTitle:r.title),year:episode?undefined:yearOf(r.originallyAvailableAt),
      episode:episode?`${r.parentIndex}:${r.index}`:undefined,at:Number(r.viewedAt)*1000,user:names.get(String(r.accountID))??`Plex user ${r.accountID}`,watched:true};
  });
}
async function tautulliPlays(): Promise<Play[]> {
  const { url, key }=tautulliSettings();
  const out: Play[]=[];
  for (let start=0;;start+=5000) {
    const data=(await tautulliCall(url!,key!,'get_history',{length:'5000',start:String(start),order_column:'date',order_dir:'desc'})) as Row;
    const rows=(data.data??[]) as Row[];
    for (const r of rows) {
      const episode=r.media_type==='episode';if (!episode && r.media_type!=='movie') continue;
      out.push({key:String(episode?r.grandparent_rating_key:r.rating_key),titleKey:titleKey(episode?r.grandparent_title:r.title),year:episode?undefined:Number(r.year)||undefined,
        episode:episode?`${r.parent_media_index}:${r.media_index}`:undefined,at:Number(r.date)*1000,user:String(r.friendly_name||r.user||'Unknown'),watched:Number(r.watched_status)>=1});
    }
    if (rows.length<5000 || out.length>=Number(data.recordsFiltered??0)) break;
  }
  return out;
}
async function plexIndex(withHistory: boolean): Promise<PlexIndex> {
  if (plexMemo && Date.now()-plexMemo.at<120000 && (plexMemo.withHistory||!withHistory)) return plexMemo.index;
  const { url, token }=plexSettings();
  if (!url || !token) throw Error('Plex is not connected (Settings → Plex)');
  const sections=((await plexGet(url,token,'/library/sections')).MediaContainer?.Directory??[]) as Row[];
  const entries: PlexEntry[]=[];
  for (const section of sections.filter(s=>s.type==='movie'||s.type==='show')) {
    for (const raw of await plexPaged(url,token,`/library/sections/${section.key}/all?includeGuids=1`,1000))
      entries.push({ratingKey:String(raw.ratingKey),library:String(section.title),kind:section.type==='movie'?'movie':'series',titleKey:titleKey(raw.title),year:Number(raw.year)||undefined,guids:(raw.Guid??[]).map((g: Row)=>String(g.id)),raw});
  }
  const byGuid=new Map<string,PlexEntry[]>();
  for (const entry of entries) for (const guid of entry.guids) byGuid.set(`${entry.kind}:${guid}`,[...(byGuid.get(`${entry.kind}:${guid}`)??[]),entry]);
  const plays=new Map<string,Play[]>(),orphanPlays=new Map<string,Play[]>();let error: string|undefined;
  if (withHistory) {
    try {
      const known=new Set(entries.map(e=>e.ratingKey));
      for (const play of tautulliSettings().url?await tautulliPlays():await plexPlays(url,token)) {
        // History for items Plex has since replaced (e.g. after a move between libraries) is matched by title instead.
        const map=known.has(play.key)?plays:orphanPlays,key=known.has(play.key)?play.key:`${play.episode?'series':'movie'}:${play.titleKey}`;
        map.set(key,[...(map.get(key)??[]),play]);
      }
    } catch (e) { error=`${tautulliSettings().url?'Tautulli':'Plex'} watch history could not be loaded: ${(e as Error).message}`; }
  }
  const index={entries,byGuid,plays,orphanPlays,error};
  plexMemo={at:Date.now(),withHistory,index};
  return index;
}
function matchPlex(index: PlexIndex, item: MediaItem): PlexEntry[] {
  const meta=item.meta??{},ids=[meta.tmdbId&&`tmdb://${meta.tmdbId}`,meta.tvdbId&&`tvdb://${meta.tvdbId}`,meta.imdbId&&`imdb://${meta.imdbId}`].filter(Boolean) as string[];
  const found=new Set<PlexEntry>();for (const id of ids) for (const entry of index.byGuid.get(`${item.mediaType}:${id}`)??[]) found.add(entry);
  if (found.size) return [...found];
  const key=titleKey(item.title);
  return index.entries.filter(e=>e.kind===item.mediaType&&e.titleKey===key&&(item.mediaType==='series'||!item.year||!e.year||Math.abs(e.year-item.year)<=1));
}
function applyPlex(item: MediaItem, matches: PlexEntry[], index: PlexIndex, withHistory: boolean) {
  const meta=item.meta??={};
  const fill=(key: string, value: MetaValue)=>{if (empty(meta[key])&&!empty(value)) meta[key]=value;};
  const first=matches[0]?.raw;
  meta.inPlex=!!matches.length;
  meta.plexLibrary=uniq(matches.map(m=>m.library));
  meta.plexAdded=iso(Math.min(...matches.map(m=>Number(m.raw.addedAt)||Infinity)));
  meta.plexLabels=uniq(matches.flatMap(m=>tags(m.raw.Label)));
  meta.plexCollections=uniq(matches.flatMap(m=>tags(m.raw.Collection)));
  if (first) {
    const media=first.Media?.[0]??{};
    meta.plexContentRating=first.contentRating??null;meta.plexAudienceRating=first.audienceRating??null;meta.plexCriticRating=first.rating??null;meta.userRating=first.userRating??null;
    meta.bitrate=media.bitrate??null;meta.container=media.container??null;
    const leaves=Number(first.leafCount??0),viewedLeaves=Number(first.viewedLeafCount??0);
    meta.inProgress=item.mediaType==='movie'?Number(first.viewOffset??0)>0:viewedLeaves>0&&viewedLeaves<leaves;
    fill('tagline',first.tagline??null);fill('countries',tags(first.Country));fill('directors',tags(first.Director));fill('writers',tags(first.Writer));fill('cast',tags(first.Role));fill('studio',first.studio??null);
    fill('resolution',media.videoResolution?(media.videoResolution==='4k'?2160:Number(media.videoResolution)||null):null);fill('videoCodec',media.videoCodec??null);fill('audioCodec',media.audioCodec??null);fill('audioChannels',media.audioChannels??null);fill('edition',first.editionTitle??null);
  } else meta.inProgress=false;
  if (!withHistory) return;
  const plays=[...matches.flatMap(m=>index.plays.get(m.ratingKey)??[]),...(index.orphanPlays.get(`${item.mediaType}:${titleKey(item.title)}`)??[]).filter(p=>item.mediaType==='series'||!p.year||!item.year||Math.abs(p.year-item.year)<=1)];
  const last=plays.length?Math.max(...plays.map(p=>p.at)):null;
  meta.watched=plays.length>0;meta.playCount=plays.length;meta.lastWatched=last?new Date(last).toISOString():null;
  meta.watchedBy=uniq(plays.map(p=>p.user)).sort();meta.viewerCount=meta.watchedBy.length;
  const since=last??Date.parse(String(meta.plexAdded??item.added??''));
  meta.daysSinceWatched=Number.isNaN(since)?null:Math.floor((Date.now()-since)/86400000);
  if (item.mediaType==='series') {
    const episodes=new Set(plays.filter(p=>p.watched&&p.episode).map(p=>p.episode));
    const total=Math.max(...matches.map(m=>Number(m.raw.leafCount)||0),0)||Number(meta.episodeFileCount??0);
    meta.watchedEpisodes=episodes.size;meta.watchedPercent=total?Math.min(100,Math.round(episodes.size/total*100)):null;
  }
}

// ---------- TMDB and OMDb ----------
const tmdbFields=['tagline','keywords','countries','popularity','tmdbRating','tmdbVotes','productionCompanies','directors','writers','cast','creators','networks','inProduction','showType','budget','revenue','spokenLanguages','adult','streamingOn','rentBuyOn'];
async function tmdbMeta(kind: 'movie'|'series', id: string, region: string, token: string): Promise<Record<string,MetaValue>> {
  const key=`tmdb-details:${kind}:${id}:${region}`,hit=cached<Record<string,MetaValue>>(key);if (hit) return hit;
  const response=await fetch(`https://api.themoviedb.org/3/${kind==='movie'?'movie':'tv'}/${id}?append_to_response=credits,keywords,watch/providers`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if (response.status===404) { cache(key,{},7);return {}; }
  if (!response.ok) throw Error(`TMDB ${response.status}`);
  const d=await response.json() as Row,crew=(d.credits?.crew??[]) as Row[],providers=d['watch/providers']?.results?.[region]??{};
  const names=(v: unknown, field='name')=>Array.isArray(v)?uniq(v.map((x: Row)=>x?.[field])):[];
  const meta: Record<string,MetaValue>={
    tagline:d.tagline||null,keywords:names(d.keywords?.keywords??d.keywords?.results),countries:names(d.production_countries),popularity:d.popularity??null,tmdbRating:d.vote_average||null,tmdbVotes:d.vote_count||null,
    productionCompanies:names(d.production_companies),directors:uniq(crew.filter(c=>c.job==='Director').map(c=>c.name)),writers:uniq(crew.filter(c=>c.department==='Writing').map(c=>c.name)),
    cast:names((d.credits?.cast??[]).slice(0,15)),spokenLanguages:names(d.spoken_languages,'english_name'),adult:!!d.adult,
    streamingOn:names(providers.flatrate,'provider_name'),rentBuyOn:uniq([...(providers.rent??[]),...(providers.buy??[])].map((p: Row)=>p.provider_name)),
    ...(kind==='movie'?{budget:d.budget?Math.round(d.budget/1e5)/10:null,revenue:d.revenue?Math.round(d.revenue/1e5)/10:null}
      :{creators:names(d.created_by),networks:names(d.networks),inProduction:!!d.in_production,showType:d.type||null}),
  };
  cache(key,meta,7);return meta;
}
const omdbFields=['imdbRating','imdbVotes','rottenTomatoes','metacritic','awards','oscarWins','awardWins'];
async function omdbMeta(imdbId: string, apiKey: string): Promise<Record<string,MetaValue>> {
  const key=`omdb:${imdbId}`,hit=cached<Record<string,MetaValue>>(key);if (hit) return hit;
  const response=await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbId)}`,{signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw Error(`OMDb ${response.status}`);
  const d=await response.json() as Row;
  if (d.Response==='False') { if (/not found/i.test(String(d.Error))) { cache(key,{},14);return {}; } throw Error(`OMDb: ${d.Error}`); }
  const number=(v: unknown)=>{const n=Number(String(v??'').replace(/[^0-9.]/g,''));return String(v??'N/A')==='N/A'||Number.isNaN(n)?null:n;};
  const awards=d.Awards&&d.Awards!=='N/A'?String(d.Awards):null;
  const meta: Record<string,MetaValue>={imdbRating:number(d.imdbRating),imdbVotes:number(d.imdbVotes),rottenTomatoes:number((d.Ratings??[]).find((r: Row)=>r.Source==='Rotten Tomatoes')?.Value),metacritic:number(d.Metascore),
    awards,oscarWins:awards?Number(/Won (\d+) Oscars?/i.exec(awards)?.[1]??0):0,awardWins:awards?Number(/(\d+) wins?/i.exec(awards)?.[1]??0)+Number(/Won (\d+) Oscars?/i.exec(awards)?.[1]??0):0};
  cache(key,meta,14);return meta;
}

// ---------- Settings ----------
export function tautulliSettings() { const cipher=getSetting('tautulli_key_cipher');return {url:getSetting('tautulli_url')??null,key:cipher?decrypt(cipher):null}; }
export async function tautulliCall(url: string, key: string, cmd: string, params: Record<string,string>={}): Promise<unknown> {
  let response: Response;
  try { response=await fetch(`${url.replace(/\/$/,'')}/api/v2?${new URLSearchParams({apikey:key,cmd,...params})}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)}); }
  catch (e) { throw Object.assign(Error(`Could not reach Tautulli at ${url} (${(e as Error).message})`),{statusCode:400}); }
  const body=await response.json().catch(()=>null) as Row|null;
  if (!response.ok || body?.response?.result!=='success') throw Object.assign(Error(`Tautulli: ${body?.response?.message??`${response.status} ${response.statusText}`}`),{statusCode:400});
  return body.response.data;
}
export async function omdbTest(apiKey: string) { const d=await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&i=tt0111161`,{signal:AbortSignal.timeout(15000)}).then(r=>r.json()).catch(e=>({Response:'False',Error:String(e)})) as Row;if (d.Response==='False') throw Object.assign(Error(`OMDb: ${d.Error}`),{statusCode:400}); }
export function clearSourceCache() { plexMemo=undefined; }

/** Adds catalog fields from the providers the given rule fields need, marking items whose provider couldn't answer. */
export async function enrichSources(items: MediaItem[], fieldKeys: Iterable<string>, ratingRegion: (item: MediaItem)=>string) {
  const keys=[...fieldKeys],sources=new Set<FieldSource>();
  for (const key of keys) for (const source of fieldByKey.get(key)?.sources??[]) sources.add(source);
  const mark=(item: MediaItem, source: FieldSource, issue: string)=>{(item.sourceIssues??={})[source]=issue;};
  if (sources.has('plex')||sources.has('watch')) {
    const withHistory=sources.has('watch');
    try {
      const index=await plexIndex(withHistory);
      for (const item of items) { applyPlex(item,matchPlex(index,item),index,withHistory); if (index.error) mark(item,'watch',index.error); }
    } catch (e) { const issue=(e as Error).message.startsWith('Plex is not')?(e as Error).message:`Plex could not be reached: ${(e as Error).message}`;for (const item of items){mark(item,'plex',issue);mark(item,'watch',issue);} }
  }
  const wanted=(names: string[])=>keys.filter(k=>names.includes(k));
  const tmdbWanted=wanted(tmdbFields).filter(k=>fieldByKey.get(k)?.sources.includes('tmdb'));
  if (tmdbWanted.length) {
    const cipher=getSetting('tmdb_key_cipher'),todo=items.filter(i=>tmdbWanted.some(k=>empty(i.meta?.[k])));
    if (!cipher) todo.forEach(i=>mark(i,'tmdb','TMDB is not set up (Settings → Data sources)'));
    else {
      const token=decrypt(cipher);let failures=0;
      await pool(todo.filter(i=>i.meta?.tmdbId),8,async item=>{
        try { const extra=await tmdbMeta(item.mediaType,String(item.meta!.tmdbId),ratingRegion(item),token);for (const [k,v] of Object.entries(extra)) if (empty(item.meta![k])) item.meta![k]=v; }
        catch (e) { failures++;mark(item,'tmdb',`TMDB lookup failed: ${(e as Error).message}`); }
      });
      if (failures) operationLog('warn','TMDB details lookups failed',{failures});
    }
  }
  const omdbWanted=wanted(omdbFields);
  if (omdbWanted.length) {
    const cipher=getSetting('omdb_key_cipher'),todo=items.filter(i=>omdbWanted.some(k=>empty(i.meta?.[k])));
    if (!cipher) todo.forEach(i=>mark(i,'omdb','OMDb is not set up (Settings → Data sources)'));
    else {
      const apiKey=decrypt(cipher);let failures=0;
      await pool(todo.filter(i=>i.meta?.imdbId),4,async item=>{
        try { const extra=await omdbMeta(String(item.meta!.imdbId),apiKey);for (const [k,v] of Object.entries(extra)) if (empty(item.meta![k])) item.meta![k]=v; }
        catch (e) { failures++;mark(item,'omdb',`OMDb lookup failed: ${(e as Error).message}`); }
      });
      if (failures) operationLog('warn','OMDb lookups failed',{failures});
    }
  }
}
