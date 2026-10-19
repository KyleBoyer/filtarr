import type { MediaType } from '@filtarr/core';
import { audit, getSetting, operationLog } from './db.js';
import { decrypt } from './security.js';

export interface PlexSection { key: string; title: string; type: string; locations: string[] }
export interface PlexServer { clientIdentifier: string; name: string; owned: boolean; connections: { uri: string; local: boolean; relay: boolean }[] }
export interface ScanTarget { mediaType: MediaType; arrRoot: string; arrPath: string }

const plexHeaders=(token: string)=>({Accept:'application/json','X-Plex-Token':token,'X-Plex-Client-Identifier':getSetting('plex_client_id')??'filtarr','X-Plex-Product':'Filtarr'});
async function plexFetch(url: string, token: string, timeout=10000): Promise<any> {
  let response: Response;
  try { response=await fetch(url,{headers:plexHeaders(token),signal:AbortSignal.timeout(timeout)}); }
  catch (error) { throw Object.assign(Error(`Could not reach Plex at ${new URL(url).origin} (${(error as Error).message})`),{statusCode:502}); }
  if (response.status===401) throw Object.assign(Error('Plex rejected the token'),{statusCode:400});
  if (!response.ok) throw Object.assign(Error(`Plex: ${response.status} ${response.statusText}`),{statusCode:502});
  const text=await response.text(); return text?JSON.parse(text):{};
}
export function plexSettings() {
  const cipher=getSetting('plex_server_token_cipher');
  return {scanEnabled:getSetting('plex_scan_enabled')!=='0',url:getSetting('plex_server_url')??null,name:getSetting('plex_server_name')??null,token:cipher?decrypt(cipher):null};
}
export async function discoverServers(accountToken: string): Promise<(PlexServer & { accessToken: string })[]> {
  const data=await plexFetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1',accountToken,15000) as any[];
  return data.filter(r=>String(r.provides??'').split(',').includes('server')).map(r=>({clientIdentifier:String(r.clientIdentifier),name:String(r.name),owned:!!r.owned,accessToken:String(r.accessToken??accountToken),connections:(r.connections??[]).map((c:any)=>({uri:String(c.uri),local:!!c.local,relay:!!c.relay}))}));
}
export async function plexSections(url: string, token: string): Promise<PlexSection[]> {
  const data=await plexFetch(`${url.replace(/\/$/,'')}/library/sections`,token);
  return (data.MediaContainer?.Directory??[]).map((d:any)=>({key:String(d.key),title:String(d.title),type:String(d.type),locations:(d.Location??[]).map((l:any)=>String(l.path))}));
}
const segments=(path: string)=>path.replace(/\\/g,'/').split('/').filter(Boolean);
const under=(path: string, root: string)=>{const p=segments(path),r=segments(root);return r.every((s,i)=>p[i]===s);};
// Arr and Plex often see the same share under different mount points (e.g. /Plex/Plex/Movies vs /Volumes/Plex/Plex/Movies).
// Use an exact location when one matches; otherwise pair the Arr root with the library folder sharing the most trailing path segments.
export function locate(target: ScanTarget, sections: PlexSection[]): { section: PlexSection; path: string } | null {
  const typed=sections.filter(s=>s.type===(target.mediaType==='movie'?'movie':'show'));
  for (const section of typed) if (section.locations.some(l=>under(target.arrPath,l))) return {section,path:target.arrPath};
  const root=segments(target.arrRoot),rest=segments(target.arrPath).slice(root.length);
  if (!under(target.arrPath,target.arrRoot)) return null;
  const scored=typed.flatMap(section=>section.locations.map(location=>{const l=segments(location);let n=0;while(n<root.length&&n<l.length&&root[root.length-1-n]===l[l.length-1-n])n++;return {section,location,score:n};})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score);
  const [best,next]=scored; if (!best || (next && next.score===best.score)) return null;
  const separator=best.location.includes('\\')?'\\':'/';
  return {section:best.section,path:[best.location.replace(/[\\/]$/,''),...rest].join(separator)};
}
export async function scanAfterMoves(runId: string, targets: ScanTarget[]) {
  const settings=plexSettings();
  if (!targets.length || !settings.scanEnabled || !settings.url || !settings.token) return;
  try {
    const sections=await plexSections(settings.url,settings.token);
    const partial=new Map<string,Set<string>>(),full=new Set<string>();
    for (const target of targets) {
      const found=locate(target,sections);
      if (found) { const paths=partial.get(found.section.key)??new Set<string>(); paths.add(found.path); partial.set(found.section.key,paths); }
      else sections.filter(s=>s.type===(target.mediaType==='movie'?'movie':'show')).forEach(s=>full.add(s.key));
    }
    const base=settings.url.replace(/\/$/,'');
    for (const key of full) { partial.delete(key); await plexFetch(`${base}/library/sections/${key}/refresh`,settings.token); }
    for (const [key,paths] of partial) for (const path of paths) await plexFetch(`${base}/library/sections/${key}/refresh?path=${encodeURIComponent(path)}`,settings.token);
    const details={runId,folders:[...partial.values()].reduce((n,p)=>n+p.size,0),fullLibraries:[...full].map(key=>sections.find(s=>s.key===key)?.title)};
    if (full.size) operationLog('warn','Plex paths did not match; scanned whole libraries',details); else operationLog('info','Plex scan requested',details);
    audit('plex.scan_requested',null,'run',runId,details);
  } catch (error) { operationLog('warn','Plex scan failed; moves are complete but Plex may not show them until its next scan',{runId,error:String(error)}); }
}
