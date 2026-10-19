import { randomUUID } from 'node:crypto';
export type MediaType = 'movie' | 'series';
import { fieldByKey, fieldsIn, type FieldSource, type MetaValue, type Operator } from './fields.js';
export * from './fields.js';
/** A key from the field catalog in fields.ts. */
export type Field = string;
export type Condition = { kind: 'predicate'; field: Field; operator: Operator; value?: string | number | boolean | string[] }
  | { kind: 'all'; children: Condition[] } | { kind: 'any'; children: Condition[] }
  | { kind: 'not'; child: Condition };
export type Action = { type: 'move'; destinationId: string } | { type: 'addTag' | 'removeTag'; tag: string } | { type: 'monitor'; value: boolean };
export interface RuleDocument { id: string; name: string; condition: Condition; actions: Action[]; stopProcessing: boolean; connectionIds?: string[]; mediaTypes?: MediaType[] }
export interface MediaItem { id: string; connectionId: string; upstreamId: number; mediaType: MediaType; title: string; certification?: string | null; certificationStatus?: 'resolved' | 'lookup-error'; genre: string[]; year?: number; destination?: string | null; tags: string[]; monitored: boolean; hasFile: boolean; added?: string; rootFolderPath?: string; path?: string; destinationOverride?: string | null;
  /** Catalog field values beyond the core ones above. */
  meta?: Record<string, MetaValue>;
  /** Providers that could not supply data for this item, with a reason; their fields evaluate as unknown. */
  sourceIssues?: Partial<Record<FieldSource, string>> }
export type Truth = true | false | 'unknown';
export interface RuleTrace { ruleId: string; name: string; matched: Truth; stopped: boolean; actions: Action[]; reason?: string }
export interface ItemPlan { item: MediaItem; trace: RuleTrace[]; desired: { destination?: string | null; tags: string[]; monitored: boolean }; changes: Action[]; blocked?: string }
// Minimum suitable age for common rating systems. Arr apps pass through the origin country's rating (e.g. Brazil "L", Canada "C", Netflix-style "7"/"12+"), so map them onto one age scale.
const ratingAges: Record<string, number> = {
  'G': 0, 'TV-Y': 0, 'TV-G': 0, 'E': 0, 'U': 0, 'L': 0, 'AL': 0, 'C': 0, 'TP': 0, 'ALL': 0, 'A.L.': 0,
  'TV-Y7': 7, 'TV-Y7-FV': 7, 'C8': 8, 'PG': 8, 'TV-PG': 8, 'UC': 8,
  '12A': 12, 'PG-13': 13, 'TV-14': 14, '14A': 14, 'M': 15, 'MA15+': 15, '18A': 18,
  'R': 17, 'TV-MA': 17, 'NC-17': 18, 'X': 18, 'R18+': 18, 'R18': 18
};
export function ageRating(certification?: string | null): number | null {
  const value = certification?.trim().toUpperCase(); if (!value) return null;
  const known = ratingAges[value]; if (known !== undefined) return known;
  const numeric = /^(?:[A-Z]{1,4}[\s-]?)?(\d{1,2})\+?$/.exec(value);
  return numeric ? Number(numeric[1]) : null;
}
const norm = (v: unknown) => typeof v === 'string' ? v.trim().toLowerCase() : v;
export function predicate(item: MediaItem, condition: Extract<Condition, { kind: 'predicate' }>): Truth {
  let actual: unknown;
  switch (condition.field) {
    case 'mediaType': actual = item.mediaType; break;
    case 'title': actual = item.title; break;
    case 'certification': if (item.certificationStatus === 'lookup-error') return 'unknown'; actual = item.certification; break;
    case 'ageRating': if (item.certificationStatus === 'lookup-error') return 'unknown'; actual = ageRating(item.certification); break;
    case 'genre': actual = item.genre; break;
    case 'year': actual = item.year; break;
    case 'destination': {
      const wantsRoot = typeof condition.value === 'string' && condition.value.startsWith('root:');
      actual = !wantsRoot || item.destination?.startsWith('root:') ? item.destination : item.rootFolderPath ? rootTargetId(item.connectionId, item.rootFolderPath) : null;
      break;
    }
    case 'tag': actual = item.tags; break;
    case 'monitored': actual = item.monitored; break;
    case 'hasFile': actual = item.hasFile; break;
    case 'connectionId': actual = item.connectionId; break;
    case 'added': actual = item.added; break;
    default: {
      const def = fieldByKey.get(condition.field);
      actual = item.meta?.[condition.field];
      // A provider that failed or isn't set up can't answer, unless another provider already did.
      const empty = actual == null || actual === '' || (Array.isArray(actual) && !actual.length);
      if (empty && def?.sources.some(source => item.sourceIssues?.[source])) return 'unknown';
      if (empty) {
        if (condition.operator === 'isMissing') return true;
        // Known-empty values: lists and text behave as empty, so negative checks pass and everything else fails.
        return condition.operator === 'isNot' || condition.operator === 'notIn' || condition.operator === 'notContains';
      }
      if (def?.type === 'number' && typeof condition.value !== 'number' && condition.operator !== 'in' && condition.operator !== 'notIn') condition = { ...condition, value: Number(condition.value) };
    }
  }
  if (condition.operator === 'isMissing') return actual == null || actual === '';
  if (condition.field === 'certification' && item.certificationStatus === 'resolved' && (actual == null || actual === '') && condition.operator === 'in') return false;
  // Unrated or unrecognized ratings never match an age comparison, rather than blocking the item.
  if (condition.field === 'ageRating' && item.certificationStatus === 'resolved' && actual == null) return false;
  if (actual == null || actual === '') return 'unknown';
  const expected = condition.value;
  if (condition.operator === 'withinDays' || condition.operator === 'olderThanDays') {
    const age = (Date.now() - Date.parse(String(actual))) / 86400000, days = Number(expected);
    if (Number.isNaN(age) || Number.isNaN(days)) return 'unknown';
    return condition.operator === 'withinDays' ? age <= days : age > days;
  }
  if (condition.operator === 'is') return Array.isArray(actual) ? actual.some(v => norm(v) === norm(expected)) : norm(actual) === norm(expected);
  if (condition.operator === 'isNot') return Array.isArray(actual) ? !actual.some(v => norm(v) === norm(expected)) : norm(actual) !== norm(expected);
  if (condition.operator === 'notIn') { if (!Array.isArray(expected)) return true; const unwanted = expected.map(norm); return Array.isArray(actual) ? !actual.some(v => unwanted.includes(norm(v))) : !unwanted.includes(norm(actual)); }
  if (condition.operator === 'notContains') return Array.isArray(actual) ? !actual.some(v => String(norm(v)).includes(String(norm(expected)))) : !String(norm(actual)).includes(String(norm(expected)));
  if (condition.operator === 'in') { if (!Array.isArray(expected)) return false; const wanted = expected.map(norm); return Array.isArray(actual) ? actual.some(v => wanted.includes(norm(v))) : wanted.includes(norm(actual)); }
  // Dates (e.g. added) arrive as ISO strings; compare them as instants.
  if ((condition.operator === 'greaterThan' || condition.operator === 'lessThan') && typeof actual === 'string' && typeof expected === 'string' && !Number.isNaN(Date.parse(actual)) && !Number.isNaN(Date.parse(expected))) return condition.operator === 'greaterThan' ? Date.parse(actual) > Date.parse(expected) : Date.parse(actual) < Date.parse(expected);
  if (condition.operator === 'contains') return Array.isArray(actual) ? actual.some(v => String(norm(v)).includes(String(norm(expected)))) : String(norm(actual)).includes(String(norm(expected)));
  if (condition.operator === 'greaterThan') return typeof actual === 'number' && typeof expected === 'number' ? actual > expected : 'unknown';
  if (condition.operator === 'lessThan') return typeof actual === 'number' && typeof expected === 'number' ? actual < expected : 'unknown';
  if (condition.operator === 'atMost' || condition.operator === 'atLeast') { const limit = Number(expected); if (typeof actual !== 'number' || Number.isNaN(limit)) return 'unknown'; return condition.operator === 'atMost' ? actual <= limit : actual >= limit; }
  return 'unknown';
}
export function evaluate(item: MediaItem, condition: Condition): Truth {
  if (condition.kind === 'predicate') return predicate(item, condition);
  if (condition.kind === 'not') { const result = evaluate(item, condition.child); return result === 'unknown' ? result : !result; }
  const results = condition.children.map(child => evaluate(item, child));
  if (condition.kind === 'all') return results.includes(false) ? false : results.includes('unknown') ? 'unknown' : true;
  return results.includes(true) ? true : results.includes('unknown') ? 'unknown' : false;
}
/** Destinations are optional: a move can target one Arr root folder directly with `root:<connectionId>:<path>`. */
export function rootTargetId(connectionId: string, path: string): string { return `root:${connectionId}:${path}`; }
export function parseRootTarget(id: string): { connectionId: string; path: string } | null {
  if (!id.startsWith('root:')) return null;
  const rest = id.slice(5), split = rest.indexOf(':');
  return split > 0 ? { connectionId: rest.slice(0, split), path: rest.slice(split + 1) } : null;
}
const samePath = (a?: string | null, b?: string | null) => !!a && !!b && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');
/** True when the target is already where the item lives (named destination id or a root folder target). */
function alreadyAt(item: MediaItem, target: string): boolean {
  if (target === item.destination) return true;
  const root = parseRootTarget(target);
  return !!root && root.connectionId === item.connectionId && samePath(root.path, item.rootFolderPath);
}
/** Explains an unknown result with the provider problems behind the fields the rule uses, when there are any. */
function unknownReason(item: MediaItem, condition: Condition): string {
  const issues = new Set<string>();
  for (const key of fieldsIn(condition)) for (const source of fieldByKey.get(key)?.sources ?? []) { const issue = item.sourceIssues?.[source]; if (issue) issues.add(issue); }
  return issues.size ? `Required metadata is unknown: ${[...issues].join('; ')}` : 'Required metadata is unknown';
}
export function planItem(source: MediaItem, rules: RuleDocument[]): ItemPlan {
  const projected: MediaItem = { ...source, tags: [...source.tags] };
  const trace: RuleTrace[] = [];
  let blocked: string | undefined;
  for (const rule of rules) {
    if (rule.connectionIds?.length && !rule.connectionIds.includes(source.connectionId)) continue;
    if (rule.mediaTypes?.length && !rule.mediaTypes.includes(source.mediaType)) continue;
    const matched = evaluate(projected, rule.condition);
    const reason = matched === 'unknown' ? unknownReason(source, rule.condition) : undefined;
    trace.push({ ruleId: rule.id, name: rule.name, matched, stopped: matched === true && rule.stopProcessing, actions: matched === true ? rule.actions : [], reason });
    if (matched === 'unknown') blocked = reason;
    if (matched !== true) continue;
    for (const action of rule.actions) {
      // A root folder target belongs to one connection, so a rule can list one per app and each item takes its own.
      if (action.type === 'move' && (parseRootTarget(action.destinationId)?.connectionId ?? source.connectionId) === source.connectionId) projected.destination = action.destinationId;
      if (action.type === 'addTag' && !projected.tags.includes(action.tag)) projected.tags.push(action.tag);
      if (action.type === 'removeTag') projected.tags = projected.tags.filter(tag => tag !== action.tag);
      if (action.type === 'monitor') projected.monitored = action.value;
    }
    if (rule.stopProcessing) break;
  }
  if (source.destinationOverride) {
    projected.destination = source.destinationOverride; blocked = undefined;
    trace.push({ ruleId: 'manual-override', name: 'Manual override', matched: true, stopped: true, actions: [{ type: 'move', destinationId: source.destinationOverride }], reason: 'Pinned to this destination; rules cannot move it' });
  }
  const changes: Action[] = [];
  if (projected.destination && !alreadyAt(source, projected.destination)) changes.push({ type: 'move', destinationId: projected.destination });
  for (const tag of projected.tags.filter(tag => !source.tags.includes(tag))) changes.push({ type: 'addTag', tag });
  for (const tag of source.tags.filter(tag => !projected.tags.includes(tag))) changes.push({ type: 'removeTag', tag });
  if (projected.monitored !== source.monitored) changes.push({ type: 'monitor', value: projected.monitored });
  return { item: source, trace, desired: { destination: projected.destination, tags: projected.tags, monitored: projected.monitored }, changes, blocked };
}
export function plan(items: MediaItem[], rules: RuleDocument[]): ItemPlan[] { return items.map(item => planItem(item, rules)); }
export function starterRules(kidsId: string, regularId: string): RuleDocument[] {
  return [
    { id: randomUUID(), name: 'Kids', condition: { kind: 'any', children: [
      { kind: 'all', children: [{ kind: 'predicate', field: 'mediaType', operator: 'is', value: 'movie' }, { kind: 'predicate', field: 'ageRating', operator: 'atMost', value: 8 }] },
      { kind: 'all', children: [{ kind: 'predicate', field: 'mediaType', operator: 'is', value: 'series' }, { kind: 'predicate', field: 'ageRating', operator: 'atMost', value: 7 }] }
    ] }, actions: [{ type: 'move', destinationId: kidsId }], stopProcessing: true },
    { id: randomUUID(), name: 'Everything else', condition: { kind: 'predicate', field: 'title', operator: 'contains', value: '' }, actions: [{ type: 'move', destinationId: regularId }], stopProcessing: true }
  ];
}
