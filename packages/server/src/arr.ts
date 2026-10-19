import { parseRootTarget, type Action, MediaItem, MediaType, type MetaValue } from '@filtarr/core';
import { all, one, type Row } from './db.js';
import { decrypt } from './security.js';

export interface ArrConnection { id: string; kind: MediaType; name: string; url: string; api_key_cipher: string; rating_region: string }
export interface Root { id: number; path: string; freeSpace?: number }
const endpoint=(connection: ArrConnection, path: string)=>`${connection.url.replace(/\/$/,'')}/api/v3/${path.replace(/^\//,'')}`;
export async function arrRequest<T>(connection: ArrConnection, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response=await fetch(endpoint(connection,path),{...init,headers:{'X-Api-Key':decrypt(connection.api_key_cipher),'Accept':'application/json',...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers??{})},signal:AbortSignal.timeout(30000)}); }
  catch (error) { throw Object.assign(Error(`${connection.name}: could not reach ${connection.url} (${(error as Error).message})`),{statusCode:502}); }
  if (!response.ok) throw Error(`${connection.name}: ${response.status} ${response.statusText}`);
  const data=await response.text(); if (!data) return {} as T;
  try { return JSON.parse(data) as T; } catch { throw Error(`${connection.name}: response from ${connection.url} was not JSON; check the URL points at the Arr base address`); }
}
const appKinds: Record<string, MediaType> = { radarr: 'movie', sonarr: 'series' };
// Users often paste a page URL (e.g. /settings/general), so try the given path and then each parent until an Arr API answers.
function baseCandidates(raw: string): string[] {
  const url=new URL(raw);const parts=url.pathname.split('/').filter(Boolean);
  return parts.map((_,i)=>`${url.origin}/${parts.slice(0,parts.length-i).join('/')}`).concat(url.origin);
}
export async function detectArr(rawUrl: string, apiKey: string) {
  for (const base of baseCandidates(rawUrl)) {
    let response: Response;
    try { response=await fetch(`${base}/api/v3/system/status`,{headers:{'X-Api-Key':apiKey,'Accept':'application/json'},signal:AbortSignal.timeout(10000)}); }
    catch (error) { throw Object.assign(Error(`Could not reach ${new URL(rawUrl).origin}: ${(error as Error).message}`),{statusCode:400}); }
    if (response.status===401) throw Object.assign(Error('The server rejected the API key. Copy it from Settings → General in Sonarr or Radarr.'),{statusCode:400});
    if (!response.ok) continue;
    let status: Row; try { status=await response.json() as Row; } catch { continue; }
    const kind=appKinds[String(status.appName??'').toLowerCase()];
    if (!kind) throw Object.assign(Error(`${String(status.appName??'This server')} is not supported; connect Sonarr or Radarr.`),{statusCode:400});
    return {kind,url:base,appName:String(status.appName),instanceName:String(status.instanceName??status.appName),version:String(status.version??'')};
  }
  throw Object.assign(Error('No Sonarr or Radarr API found at that URL. Use the address you open in your browser, e.g. http://10.0.1.52:8989.'),{statusCode:400});
}
export async function testConnection(connection: ArrConnection) { const [status,roots]=await Promise.all([arrRequest<Row>(connection,'system/status'),arrRequest<Root[]>(connection,'rootfolder')]); return {version:status.version,roots}; }
export async function roots(connection: ArrConnection): Promise<Root[]> { return arrRequest<Root[]>(connection,'rootfolder'); }
/** Root folder a move target resolves to for one connection: a named destination's mapping, or a direct `root:` target on that connection. */
export function targetPath(destinationId: string, connectionId: string, kind: MediaType): string | null {
  const root=parseRootTarget(destinationId);
  if (root) return root.connectionId===connectionId?root.path:null;
  const destination=one('SELECT mappings FROM destinations WHERE id=?',destinationId);
  return destination?JSON.parse(destination.mappings)[connectionId]?.[kind]??null:null;
}
export async function rawMedia(connection: ArrConnection): Promise<Row[]> { return arrRequest<Row[]>(connection,connection.kind==='movie'?'movie':'series'); }
export async function rawTags(connection: ArrConnection): Promise<Row[]> { return arrRequest<Row[]>(connection,'tag'); }
export async function getOne(connection: ArrConnection,id: number): Promise<Row> { return arrRequest<Row>(connection,`${connection.kind==='movie'?'movie':'series'}/${id}`); }
export async function move(connection: ArrConnection, id: number, root: string) {
  const kind=connection.kind==='movie'?'movie':'series';
  const body=connection.kind==='movie'?{movieIds:[id],rootFolderPath:root,moveFiles:true}:{seriesIds:[id],rootFolderPath:root,moveFiles:true};
  return arrRequest(connection,`${kind}/editor`,{method:'PUT',body:JSON.stringify(body)});
}
export async function updateItem(connection: ArrConnection, id: number, action: Action) {
  const kind=connection.kind==='movie'?'movie':'series';
  if (action.type==='move') throw Error('Use move method');
  const body: Row=connection.kind==='movie'?{movieIds:[id]}:{seriesIds:[id]};
  if (action.type==='monitor') body.monitored=action.value;
  else {
    const tags=await rawTags(connection);
    const tag=tags.find(t=>String(t.label).toLowerCase()===action.tag.toLowerCase());
    if (!tag) throw Error(`Tag does not exist in ${connection.name}: ${action.tag}`);
    body.tags=[tag.id]; body.applyTags=action.type==='addTag'?'add':'remove';
  }
  return arrRequest(connection,`${kind}/editor`,{method:'PUT',body:JSON.stringify(body)});
}
const num=(v: unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const text=(v: unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
const date=(v: unknown)=>{const s=text(v);return s&&!s.startsWith('0001')?s:null;};
const names=(v: unknown, key='name')=>Array.isArray(v)?v.map(x=>typeof x==='string'?x:x?.[key]).filter((x): x is string=>typeof x==='string'&&!!x.trim()):[];
const splitLanguages=(v: unknown)=>typeof v==='string'?v.split(/[\/,]/).map(x=>x.trim()).filter(Boolean):[];
const gb=(bytes: unknown)=>typeof bytes==='number'?Math.round(bytes/1e7)/100:null;
/** Catalog fields Sonarr/Radarr already return in their list endpoints, so no extra requests are needed. */
export function arrMeta(connection: ArrConnection, row: Row, root: string, profiles: Map<number,string>): Record<string, MetaValue> {
  const movie=connection.kind==='movie',ratings=row.ratings??{},file=row.movieFile,info=file?.mediaInfo??{},stats=row.statistics??{};
  const hdr=text(info.videoDynamicRangeType)??text(info.videoDynamicRange);
  const common: Record<string, MetaValue>={
    originalTitle:text(row.originalTitle),alternateTitles:names(row.alternateTitles,'title'),overview:text(row.overview),keywords:names(row.keywords),
    originalLanguage:text(row.originalLanguage?.name),status:text(row.status),runtime:num(row.runtime)||null,
    qualityProfile:profiles.get(row.qualityProfileId)??null,path:text(row.path),rootFolder:root||null,
    imdbId:text(row.imdbId),tmdbId:row.tmdbId?String(row.tmdbId):null,sizeOnDisk:gb(row.sizeOnDisk??stats.sizeOnDisk),
    releaseGroups:movie?(text(file?.releaseGroup)?[file.releaseGroup]:names(stats.releaseGroups)):names(stats.releaseGroups),
  };
  if (movie) return {...common,
    imdbRating:num(ratings.imdb?.value)||null,imdbVotes:num(ratings.imdb?.votes)||null,tmdbRating:num(ratings.tmdb?.value)||null,tmdbVotes:num(ratings.tmdb?.votes)||null,
    rottenTomatoes:ratings.rottenTomatoes?.value?num(ratings.rottenTomatoes.value):null,metacritic:ratings.metacritic?.value?num(ratings.metacritic.value):null,traktRating:num(ratings.trakt?.value)||null,
    popularity:num(row.popularity),studio:text(row.studio),collection:text(row.collection?.title),
    releaseDate:date(row.digitalRelease)??date(row.physicalRelease)??date(row.inCinemas),inCinemas:date(row.inCinemas),digitalRelease:date(row.digitalRelease),physicalRelease:date(row.physicalRelease),
    isAvailable:!!row.isAvailable,minimumAvailability:text(row.minimumAvailability),
    quality:text(file?.quality?.quality?.name),resolution:num(file?.quality?.quality?.resolution)||null,videoCodec:text(info.videoCodec),audioCodec:text(info.audioCodec),audioChannels:num(info.audioChannels)||null,
    hdr,isHdr:file?!!hdr:null,audioLanguages:splitLanguages(info.audioLanguages),subtitleLanguages:splitLanguages(info.subtitles),edition:text(file?.edition),
    qualityCutoffNotMet:file?!!file.qualityCutoffNotMet:null,
  };
  const seasons: Row[]=Array.isArray(row.seasons)?row.seasons.filter((s: Row)=>s.seasonNumber>0):[];
  return {...common,
    communityRating:num(ratings.value)||null,networks:text(row.network)?[row.network]:[],
    releaseDate:date(row.firstAired),firstAired:date(row.firstAired),lastAired:date(row.lastAired),previousAiring:date(row.previousAiring),nextAiring:date(row.nextAiring),ended:!!row.ended,
    seasonCount:num(stats.seasonCount),monitoredSeasons:seasons.filter(s=>s.monitored).length,totalEpisodeCount:num(stats.totalEpisodeCount),episodeCount:num(stats.episodeCount),episodeFileCount:num(stats.episodeFileCount),
    missingEpisodes:Math.max(0,Number(stats.episodeCount??0)-Number(stats.episodeFileCount??0)),percentOfEpisodes:num(stats.percentOfEpisodes),
    seriesType:text(row.seriesType),monitorNewItems:text(row.monitorNewItems),tvdbId:row.tvdbId?String(row.tvdbId):null,
  };
}
export async function qualityProfiles(connection: ArrConnection): Promise<Map<number,string>> { return new Map((await arrRequest<Row[]>(connection,'qualityprofile')).map(p=>[Number(p.id),String(p.name)])); }
export async function normalizeMedia(connection: ArrConnection, rootList?: Root[], rawRows?: Row[]): Promise<MediaItem[]> {
  const [rows,tagRows,rootRows,profiles]=await Promise.all([rawRows?Promise.resolve(rawRows):rawMedia(connection),rawTags(connection),rootList?Promise.resolve(rootList):roots(connection),qualityProfiles(connection).catch(()=>new Map<number,string>())]);
  const destinations=all('SELECT id,mappings FROM destinations');
  const tagNames=new Map(tagRows.map(t=>[t.id,String(t.label)]));
  return rows.map(row=>{
    const path=String(row.path??'');
    const root=String(row.rootFolderPath??'') || rootRows.map(r=>r.path).filter(p=>path===p || path.startsWith(p.replace(/[\\/]$/,'')+(p.includes('\\')?'\\':'/'))).sort((a,b)=>b.length-a.length)[0] || '';
    const destination=destinations.find(d=>{ const mapping=JSON.parse(d.mappings)[connection.id]; return mapping?.[connection.kind]===root; })?.id;
    const override=one<{certification:string|null}>('SELECT certification FROM metadata_overrides WHERE media_id=?',`${connection.id}:${connection.kind}:${row.id}`);
    const pinned=one<{destination_id:string}>('SELECT destination_id FROM destination_overrides WHERE media_id=?',`${connection.id}:${connection.kind}:${row.id}`);
    return {id:`${connection.id}:${connection.kind}:${row.id}`,connectionId:connection.id,upstreamId:Number(row.id),mediaType:connection.kind,title:String(row.title),certification:override?override.certification:(row.certification||null),certificationStatus:'resolved' as const,genre:Array.isArray(row.genres)?row.genres:[],year:row.year,destination:destination??null,tags:(row.tags??[]).map((id:number)=>tagNames.get(id)).filter(Boolean) as string[],monitored:!!row.monitored,hasFile:connection.kind==='movie'?!!(row.hasFile||row.movieFileId):Number(row.statistics?.episodeFileCount??0)>0,added:row.added,rootFolderPath:root,path,destinationOverride:pinned?.destination_id??null,meta:arrMeta(connection,row,root,profiles)};
  });
}
export function getConnection(id: string): ArrConnection | undefined { return one<ArrConnection>('SELECT * FROM connections WHERE id=?',id); }
export function connections(): ArrConnection[] { return all<ArrConnection>('SELECT * FROM connections ORDER BY created_at'); }
