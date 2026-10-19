import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PlexSection } from './plex.js';
process.env.FILTARR_SECRET_KEY='1'.repeat(64);
process.env.FILTARR_DB=`/tmp/filtarr-plex-${randomUUID()}.db`;
const { locate }=await import('./plex.js');
const sections:PlexSection[]=[
  {key:'1',title:'Movies',type:'movie',locations:['/Volumes/Plex/Plex/Movies']},
  {key:'2',title:'Kids Movies',type:'movie',locations:['/Volumes/Plex/Plex/Kids/Movies']},
  {key:'3',title:'TV Shows',type:'show',locations:['/Volumes/Plex/Plex/TV Shows']},
  {key:'4',title:'Kids TV',type:'show',locations:['/Volumes/Plex/Plex/Kids/TV Shows']}
];
describe('Plex path matching',()=>{
  it('translates Arr paths onto the Plex mount by trailing folders',()=>{
    expect(locate({mediaType:'movie',arrRoot:'/Plex/Plex/Kids/Movies',arrPath:"/Plex/Plex/Kids/Movies/A Bug's Life (1998)"},sections)).toEqual({section:sections[1],path:"/Volumes/Plex/Plex/Kids/Movies/A Bug's Life (1998)"});
    expect(locate({mediaType:'movie',arrRoot:'/Plex/Plex/Movies',arrPath:'/Plex/Plex/Movies/Star Wars (1977)'},sections)?.section.key).toBe('1');
    expect(locate({mediaType:'series',arrRoot:'/Plex/Plex/Kids/TV Shows',arrPath:'/Plex/Plex/Kids/TV Shows/Bluey'},sections)?.path).toBe('/Volumes/Plex/Plex/Kids/TV Shows/Bluey');
  });
  it('uses identical paths directly and refuses ambiguous matches',()=>{
    expect(locate({mediaType:'movie',arrRoot:'/Volumes/Plex/Plex/Movies',arrPath:'/Volumes/Plex/Plex/Movies/Up (2009)'},sections)?.path).toBe('/Volumes/Plex/Plex/Movies/Up (2009)');
    expect(locate({mediaType:'movie',arrRoot:'/media/Movies',arrPath:'/media/Movies/Up (2009)'},sections)).toBeNull();
  });
});
