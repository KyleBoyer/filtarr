import type { MediaItem } from '@filtarr/core';
import type { ArrConnection } from './arr.js';
import { audit, getSetting, one, operationLog, run, now } from './db.js';
import { decrypt } from './security.js';

export async function enrich(item: MediaItem, connection: ArrConnection, raw: Record<string, any>): Promise<MediaItem> {
  if (item.certification || one('SELECT media_id FROM metadata_overrides WHERE media_id=?',item.id)) return item;
  const cipher=getSetting('tmdb_key_cipher'); if (!cipher) return item;
  const tmdbId=Number(raw.tmdbId); if (!tmdbId) return item;
  const key=`tmdb:${connection.kind}:${tmdbId}:${connection.rating_region}`;
  const cached=one<{value:string,expires_at:string}>('SELECT value,expires_at FROM metadata_cache WHERE key=?',key);
  if (cached && cached.expires_at>now()) return {...item,certification:JSON.parse(cached.value)};
  try {
    const url=`https://api.themoviedb.org/3/${connection.kind==='movie'?'movie':'tv'}/${tmdbId}/${connection.kind==='movie'?'release_dates':'content_ratings'}`;
    const response=await fetch(url,{headers:{Authorization:`Bearer ${decrypt(cipher)}`},signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw Error(`TMDB ${response.status}`);
    const data=await response.json() as any;
    const entry=data.results?.find((r:any)=>r.iso_3166_1===connection.rating_region);
    const values=connection.kind==='movie'?entry?.release_dates?.map((r:any)=>String(r.certification??'').trim()).filter(Boolean):entry?.rating?[entry.rating]:[];
    const order=connection.kind==='movie'?['G','PG','PG-13','R','NC-17']:['TV-Y','TV-Y7','TV-Y7-FV','TV-G','TV-PG','TV-14','TV-MA'];
    const recognized=(values??[]).filter((v:string)=>order.includes(v));
    const certification=recognized.sort((a:string,b:string)=>order.indexOf(b)-order.indexOf(a))[0]??null;
    run('INSERT INTO metadata_cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at',key,JSON.stringify(certification),new Date(Date.now()+(certification?7:1)*86400000).toISOString());
    return {...item,certification};
  } catch (error) { audit('metadata.provider_failure',null,'connection',connection.id,{provider:'TMDB',mediaId:item.id,error:String(error)});operationLog('error','TMDB rating lookup failed',{connectionId:connection.id,mediaId:item.id,error:String(error)});return {...item,certificationStatus:'lookup-error'}; }
}
