// Every field a rule can filter on. Shared by the server (validation, deciding which providers to query) and the web editor.
// Kept free of Node imports so the browser can load it.
export type MediaKind = 'movie' | 'series';
export type FieldType = 'text' | 'number' | 'date' | 'bool' | 'list' | 'enum';
/** arr: Sonarr/Radarr (always loaded). plex: Plex library metadata. watch: play history (Tautulli when configured, otherwise Plex). tmdb/omdb: optional metadata providers. */
export type FieldSource = 'arr' | 'plex' | 'watch' | 'tmdb' | 'omdb';
export type FieldGroup = 'Basics' | 'Ratings & reviews' | 'Release & airing' | 'Episodes & seasons' | 'People & companies' | 'Watch activity' | 'Plex' | 'File & quality' | 'Sonarr / Radarr' | 'Streaming & money';
export type MetaValue = string | number | boolean | string[] | null;
export interface FieldDef {
  key: string; label: string; group: FieldGroup; type: FieldType;
  /** Providers that can supply the value, in order of preference. */
  sources: FieldSource[];
  /** Only meaningful for this media type. */
  media?: MediaKind;
  unit?: string; hint?: string;
  /** Known values for enum fields. */
  options?: string[];
}
export const fieldGroups: FieldGroup[] = ['Basics', 'Watch activity', 'Ratings & reviews', 'Release & airing', 'Episodes & seasons', 'People & companies', 'File & quality', 'Plex', 'Streaming & money', 'Sonarr / Radarr'];
const f = (key: string, label: string, group: FieldGroup, type: FieldType, sources: FieldSource[], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, group, type, sources, ...extra });
export const fields: FieldDef[] = [
  f('mediaType', 'Type', 'Basics', 'enum', ['arr'], { options: ['movie', 'series'] }),
  f('title', 'Title', 'Basics', 'text', ['arr']),
  f('originalTitle', 'Original title', 'Basics', 'text', ['arr']),
  f('alternateTitles', 'Also known as', 'Basics', 'list', ['arr'], { hint: 'Alternate and foreign titles' }),
  f('overview', 'Plot description', 'Basics', 'text', ['arr']),
  f('tagline', 'Tagline', 'Basics', 'text', ['plex', 'tmdb']),
  f('year', 'Release year', 'Basics', 'number', ['arr']),
  f('genre', 'Genres', 'Basics', 'list', ['arr']),
  f('keywords', 'Keywords', 'Basics', 'list', ['arr', 'tmdb'], { hint: 'TMDB keywords such as “based on novel” or “christmas”' }),
  f('ageRating', 'Age rating', 'Basics', 'number', ['arr']),
  f('certification', 'Rating label (PG, TV-14…)', 'Basics', 'text', ['arr']),
  f('originalLanguage', 'Original language', 'Basics', 'text', ['arr']),
  f('countries', 'Country of origin', 'Basics', 'list', ['plex', 'tmdb']),
  f('status', 'Status', 'Basics', 'enum', ['arr'], { options: ['released', 'inCinemas', 'announced', 'tba', 'continuing', 'ended', 'upcoming', 'deleted'] }),
  f('runtime', 'Runtime', 'Basics', 'number', ['arr'], { unit: 'minutes', hint: 'Per episode for TV' }),
  f('collection', 'Movie collection', 'Basics', 'text', ['arr'], { media: 'movie', hint: 'e.g. “The Fast and the Furious Collection”' }),
  f('tag', 'Tags', 'Basics', 'list', ['arr']),
  f('destination', 'Current library', 'Basics', 'text', ['arr']),
  f('connectionId', 'Source app', 'Basics', 'text', ['arr']),
  f('added', 'Added to Sonarr/Radarr', 'Basics', 'date', ['arr']),

  f('watched', 'Watched by anyone', 'Watch activity', 'bool', ['watch']),
  f('playCount', 'Times played', 'Watch activity', 'number', ['watch'], { hint: 'All users; each episode play counts for TV' }),
  f('lastWatched', 'Last watched', 'Watch activity', 'date', ['watch'], { hint: 'Empty when nobody has watched it' }),
  f('daysSinceWatched', 'Days since anyone watched', 'Watch activity', 'number', ['watch'], { unit: 'days', hint: 'Never-watched titles count from the day they were added' }),
  f('watchedBy', 'Watched by', 'Watch activity', 'list', ['watch'], { hint: 'Plex user names' }),
  f('viewerCount', 'Number of people who watched', 'Watch activity', 'number', ['watch']),
  f('watchedEpisodes', 'Episodes watched', 'Watch activity', 'number', ['watch'], { media: 'series', hint: 'Distinct episodes anyone has watched' }),
  f('watchedPercent', 'Percent of episodes watched', 'Watch activity', 'number', ['watch'], { media: 'series', unit: '%' }),
  f('inProgress', 'Partly watched (server owner)', 'Watch activity', 'bool', ['plex'], { hint: 'Started but not finished on the owner’s account' }),

  f('imdbRating', 'IMDb rating', 'Ratings & reviews', 'number', ['arr', 'omdb'], { unit: '/10', hint: 'TV needs OMDb' }),
  f('imdbVotes', 'IMDb votes', 'Ratings & reviews', 'number', ['arr', 'omdb']),
  f('tmdbRating', 'TMDB rating', 'Ratings & reviews', 'number', ['arr', 'tmdb'], { unit: '/10' }),
  f('tmdbVotes', 'TMDB votes', 'Ratings & reviews', 'number', ['arr', 'tmdb']),
  f('rottenTomatoes', 'Rotten Tomatoes', 'Ratings & reviews', 'number', ['arr', 'omdb'], { unit: '%', hint: 'TV needs OMDb' }),
  f('metacritic', 'Metascore', 'Ratings & reviews', 'number', ['arr', 'omdb'], { unit: '/100' }),
  f('traktRating', 'Trakt rating', 'Ratings & reviews', 'number', ['arr'], { media: 'movie', unit: '/10' }),
  f('communityRating', 'TVDB rating', 'Ratings & reviews', 'number', ['arr'], { media: 'series', unit: '/10' }),
  f('popularity', 'TMDB popularity', 'Ratings & reviews', 'number', ['arr', 'tmdb'], { hint: 'Trending score; higher is more popular right now' }),
  f('plexAudienceRating', 'Plex audience rating', 'Ratings & reviews', 'number', ['plex'], { unit: '/10' }),
  f('plexCriticRating', 'Plex critic rating', 'Ratings & reviews', 'number', ['plex'], { unit: '/10' }),
  f('userRating', 'Your Plex star rating', 'Ratings & reviews', 'number', ['plex'], { unit: '/10', hint: 'Server owner’s rating; 5 stars = 10' }),
  f('awards', 'Awards', 'Ratings & reviews', 'text', ['omdb'], { hint: 'e.g. “Won 2 Oscars. 45 wins & 60 nominations”' }),
  f('oscarWins', 'Oscars won', 'Ratings & reviews', 'number', ['omdb']),
  f('awardWins', 'Award wins (all)', 'Ratings & reviews', 'number', ['omdb']),

  f('releaseDate', 'Release date', 'Release & airing', 'date', ['arr'], { hint: 'Movies: digital, then disc, then cinema release. TV: first aired' }),
  f('inCinemas', 'Cinema release', 'Release & airing', 'date', ['arr'], { media: 'movie' }),
  f('digitalRelease', 'Digital release', 'Release & airing', 'date', ['arr'], { media: 'movie' }),
  f('physicalRelease', 'Disc release', 'Release & airing', 'date', ['arr'], { media: 'movie' }),
  f('isAvailable', 'Released / available', 'Release & airing', 'bool', ['arr'], { media: 'movie' }),
  f('firstAired', 'First aired', 'Release & airing', 'date', ['arr'], { media: 'series' }),
  f('lastAired', 'Last aired', 'Release & airing', 'date', ['arr'], { media: 'series' }),
  f('previousAiring', 'Latest episode aired', 'Release & airing', 'date', ['arr'], { media: 'series' }),
  f('nextAiring', 'Next episode airs', 'Release & airing', 'date', ['arr'], { media: 'series', hint: 'Empty when nothing is scheduled' }),
  f('ended', 'Show has ended', 'Release & airing', 'bool', ['arr'], { media: 'series' }),
  f('inProduction', 'Still in production', 'Release & airing', 'bool', ['tmdb'], { media: 'series' }),

  f('seasonCount', 'Seasons', 'Episodes & seasons', 'number', ['arr'], { media: 'series' }),
  f('monitoredSeasons', 'Monitored seasons', 'Episodes & seasons', 'number', ['arr'], { media: 'series' }),
  f('totalEpisodeCount', 'Total episodes', 'Episodes & seasons', 'number', ['arr'], { media: 'series' }),
  f('episodeCount', 'Monitored episodes', 'Episodes & seasons', 'number', ['arr'], { media: 'series' }),
  f('episodeFileCount', 'Episodes downloaded', 'Episodes & seasons', 'number', ['arr'], { media: 'series' }),
  f('missingEpisodes', 'Missing episodes', 'Episodes & seasons', 'number', ['arr'], { media: 'series', hint: 'Monitored, aired and not downloaded' }),
  f('percentOfEpisodes', 'Percent downloaded', 'Episodes & seasons', 'number', ['arr'], { media: 'series', unit: '%' }),
  f('seriesType', 'Series type', 'Episodes & seasons', 'enum', ['arr'], { media: 'series', options: ['standard', 'daily', 'anime'] }),
  f('showType', 'Show format', 'Episodes & seasons', 'enum', ['tmdb'], { media: 'series', options: ['Scripted', 'Reality', 'Documentary', 'Miniseries', 'Talk Show', 'News', 'Video'] }),

  f('studio', 'Studio', 'People & companies', 'text', ['arr', 'plex']),
  f('networks', 'Network', 'People & companies', 'list', ['arr', 'tmdb'], { hint: 'e.g. HBO, Netflix, PBS Kids' }),
  f('productionCompanies', 'Production companies', 'People & companies', 'list', ['tmdb']),
  f('directors', 'Directors', 'People & companies', 'list', ['plex', 'tmdb']),
  f('writers', 'Writers', 'People & companies', 'list', ['plex', 'tmdb']),
  f('creators', 'Created by', 'People & companies', 'list', ['tmdb'], { media: 'series' }),
  f('cast', 'Cast', 'People & companies', 'list', ['tmdb', 'plex'], { hint: 'Top-billed actors' }),

  f('quality', 'Quality', 'File & quality', 'text', ['arr'], { hint: 'e.g. Bluray-1080p, WEBDL-2160p' }),
  f('resolution', 'Resolution', 'File & quality', 'number', ['arr', 'plex'], { unit: 'p', hint: '480, 720, 1080, 2160' }),
  f('videoCodec', 'Video codec', 'File & quality', 'text', ['arr', 'plex'], { hint: 'e.g. h265, h264, av1' }),
  f('hdr', 'HDR format', 'File & quality', 'text', ['arr'], { media: 'movie', hint: 'e.g. HDR10, DV; empty for SDR' }),
  f('isHdr', 'Is HDR', 'File & quality', 'bool', ['arr'], { media: 'movie' }),
  f('audioCodec', 'Audio codec', 'File & quality', 'text', ['arr', 'plex']),
  f('audioChannels', 'Audio channels', 'File & quality', 'number', ['arr', 'plex'], { hint: '2 = stereo, 5.1, 7.1' }),
  f('audioLanguages', 'Audio languages', 'File & quality', 'list', ['arr'], { media: 'movie', hint: 'Language codes, e.g. eng, spa' }),
  f('subtitleLanguages', 'Subtitle languages', 'File & quality', 'list', ['arr'], { media: 'movie' }),
  f('releaseGroups', 'Release group', 'File & quality', 'list', ['arr']),
  f('edition', 'Edition', 'File & quality', 'text', ['arr', 'plex'], { media: 'movie', hint: 'e.g. Director’s Cut' }),
  f('qualityCutoffNotMet', 'Upgrade wanted', 'File & quality', 'bool', ['arr'], { media: 'movie', hint: 'Below the quality profile’s cutoff' }),
  f('sizeOnDisk', 'Size on disk', 'File & quality', 'number', ['arr'], { unit: 'GB' }),
  f('bitrate', 'Bitrate', 'File & quality', 'number', ['plex'], { media: 'movie', unit: 'kbps' }),
  f('container', 'File container', 'File & quality', 'text', ['plex'], { media: 'movie', hint: 'e.g. mkv, mp4' }),
  f('hasFile', 'Downloaded', 'File & quality', 'bool', ['arr']),

  f('inPlex', 'In Plex', 'Plex', 'bool', ['plex']),
  f('plexLibrary', 'Plex library', 'Plex', 'list', ['plex']),
  f('plexAdded', 'Added to Plex', 'Plex', 'date', ['plex']),
  f('plexLabels', 'Plex labels', 'Plex', 'list', ['plex']),
  f('plexCollections', 'Plex collections', 'Plex', 'list', ['plex']),
  f('plexContentRating', 'Plex content rating', 'Plex', 'text', ['plex']),

  f('streamingOn', 'Streaming on', 'Streaming & money', 'list', ['tmdb'], { hint: 'Subscription services in your rating region, e.g. Netflix, Disney Plus' }),
  f('rentBuyOn', 'Rent or buy on', 'Streaming & money', 'list', ['tmdb']),
  f('budget', 'Budget', 'Streaming & money', 'number', ['tmdb'], { media: 'movie', unit: '$M' }),
  f('revenue', 'Box office', 'Streaming & money', 'number', ['tmdb'], { media: 'movie', unit: '$M' }),
  f('spokenLanguages', 'Spoken languages', 'Streaming & money', 'list', ['tmdb']),
  f('adult', 'Adult content', 'Streaming & money', 'bool', ['tmdb']),

  f('monitored', 'Monitored', 'Sonarr / Radarr', 'bool', ['arr']),
  f('qualityProfile', 'Quality profile', 'Sonarr / Radarr', 'text', ['arr']),
  f('minimumAvailability', 'Minimum availability', 'Sonarr / Radarr', 'enum', ['arr'], { media: 'movie', options: ['announced', 'inCinemas', 'released'] }),
  f('monitorNewItems', 'Monitor new seasons', 'Sonarr / Radarr', 'enum', ['arr'], { media: 'series', options: ['all', 'none'] }),
  f('path', 'Folder path', 'Sonarr / Radarr', 'text', ['arr']),
  f('rootFolder', 'Root folder', 'Sonarr / Radarr', 'text', ['arr']),
  f('imdbId', 'IMDb ID', 'Sonarr / Radarr', 'text', ['arr'], { hint: 'e.g. tt0322259' }),
  f('tmdbId', 'TMDB ID', 'Sonarr / Radarr', 'text', ['arr']),
  f('tvdbId', 'TVDB ID', 'Sonarr / Radarr', 'text', ['arr'], { media: 'series' }),
];
export const fieldByKey = new Map(fields.map(field => [field.key, field]));
export type Operator = 'is' | 'isNot' | 'in' | 'notIn' | 'contains' | 'notContains' | 'greaterThan' | 'lessThan' | 'atMost' | 'atLeast' | 'withinDays' | 'olderThanDays' | 'isMissing';
export const operators: Operator[] = ['is', 'isNot', 'in', 'notIn', 'contains', 'notContains', 'greaterThan', 'lessThan', 'atMost', 'atLeast', 'withinDays', 'olderThanDays', 'isMissing'];
/** Operators that make sense for each kind of field, with how they read in a sentence. */
export const operatorsByType: Record<FieldType, [Operator, string][]> = {
  text: [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is exactly'], ['isNot', 'is not'], ['in', 'is one of'], ['isMissing', 'is empty']],
  number: [['atLeast', 'is at least'], ['atMost', 'is at most'], ['greaterThan', 'is more than'], ['lessThan', 'is less than'], ['is', 'is exactly'], ['isMissing', 'is unknown']],
  date: [['withinDays', 'is within the last'], ['olderThanDays', 'is more than'], ['greaterThan', 'is after'], ['lessThan', 'is before'], ['isMissing', 'is empty']],
  bool: [['is', 'is']],
  list: [['is', 'includes'], ['isNot', 'does not include'], ['in', 'includes any of'], ['notIn', 'includes none of'], ['contains', 'has one containing'], ['isMissing', 'is empty']],
  enum: [['is', 'is'], ['isNot', 'is not'], ['in', 'is one of'], ['notIn', 'is none of']],
};
type ConditionLike = { kind: string; field?: string; children?: ConditionLike[]; child?: ConditionLike };
export function fieldsIn(condition: ConditionLike, out = new Set<string>()): Set<string> {
  if (condition.kind === 'predicate' && condition.field) out.add(condition.field);
  condition.children?.forEach(child => fieldsIn(child, out));
  if (condition.child) fieldsIn(condition.child, out);
  return out;
}
/** Providers needed to evaluate a set of rule conditions; Sonarr/Radarr data is always loaded. */
export function sourcesFor(conditions: ConditionLike[]): Set<FieldSource> {
  const out = new Set<FieldSource>();
  for (const condition of conditions) for (const key of fieldsIn(condition)) for (const source of fieldByKey.get(key)?.sources ?? []) if (source !== 'arr') out.add(source);
  if (out.has('watch')) out.add('plex');
  return out;
}
