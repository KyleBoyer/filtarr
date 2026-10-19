import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export type Row = Record<string, any>;
const file = process.env.FILTARR_DB ?? './data/filtarr.db';
mkdirSync(dirname(file), { recursive: true });
const existingDatabase=existsSync(file);
export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
if (existingDatabase && Number(db.pragma('user_version',{simple:true}))<3) await db.backup(`${file}.pre-v3-${Date.now()}.bak`);
db.exec(`
CREATE TABLE IF NOT EXISTS metadata_overrides(media_id TEXT PRIMARY KEY, certification TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS destination_overrides(media_id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, plex_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', status TEXT NOT NULL DEFAULT 'pending', grants TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plex_attempts(state TEXT PRIMARY KEY, pin_id INTEGER NOT NULL, code TEXT NOT NULL, setup_hash TEXT, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS access_requests(id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id), status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, bound_plex_id TEXT, role TEXT NOT NULL, grants TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_by TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, secret_hash TEXT NOT NULL, grants TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, api_key_cipher TEXT NOT NULL, rating_region TEXT NOT NULL DEFAULT 'US', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS destinations(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, mappings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY, name TEXT NOT NULL, draft TEXT NOT NULL, draft_version INTEGER NOT NULL DEFAULT 1, published_revision INTEGER, enabled INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), creator_name TEXT NOT NULL, edited_by TEXT, editor_name TEXT, source_provenance TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_revisions(rule_id TEXT NOT NULL REFERENCES rules(id), revision INTEGER NOT NULL, document TEXT NOT NULL, publisher_id TEXT NOT NULL REFERENCES users(id), publisher_name TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY(rule_id, revision));
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, name TEXT NOT NULL, expression TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, configured_by TEXT NOT NULL REFERENCES users(id), next_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, mode TEXT NOT NULL, scope TEXT NOT NULL, rule_id TEXT, status TEXT NOT NULL, actor_id TEXT, actor_name TEXT, token_id TEXT, preview_run_id TEXT, run_origin TEXT NOT NULL DEFAULT 'manual', schedule_id TEXT, publisher_names TEXT NOT NULL DEFAULT '[]', plan TEXT, total INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS action_attempts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), media_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, before_value TEXT, after_value TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor_id TEXT, actor_name TEXT, token_id TEXT, type TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operational_logs(id TEXT PRIMARY KEY, level TEXT NOT NULL, message TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_metrics(day TEXT NOT NULL, actor_id TEXT NOT NULL, token_id TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rate_limited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,actor_id,token_id));
CREATE TABLE IF NOT EXISTS idempotency(key TEXT NOT NULL, actor_id TEXT NOT NULL, payload_hash TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(key, actor_id));
`);
if (!(db.pragma('table_info(runs)') as Array<{name:string}>).some(column=>column.name==='preview_run_id')) db.exec('ALTER TABLE runs ADD COLUMN preview_run_id TEXT');
if (!(db.pragma('table_info(runs)') as Array<{name:string}>).some(column=>column.name==='run_origin')) db.exec("ALTER TABLE runs ADD COLUMN run_origin TEXT NOT NULL DEFAULT 'manual'");
if (!(db.pragma('table_info(runs)') as Array<{name:string}>).some(column=>column.name==='schedule_id')) db.exec('ALTER TABLE runs ADD COLUMN schedule_id TEXT');
if (!(db.pragma('table_info(runs)') as Array<{name:string}>).some(column=>column.name==='publisher_names')) db.exec("ALTER TABLE runs ADD COLUMN publisher_names TEXT NOT NULL DEFAULT '[]'");
if (!(db.pragma('table_info(rules)') as Array<{name:string}>).some(column=>column.name==='source_provenance')) db.exec('ALTER TABLE rules ADD COLUMN source_provenance TEXT');
// Pins may target a root folder (`root:<connection>:<path>`), not only a named destination, so drop the old foreign key.
if (String((db.prepare("SELECT sql FROM sqlite_master WHERE name='destination_overrides'").get() as {sql?:string}|undefined)?.sql??'').includes('REFERENCES')) db.exec('ALTER TABLE destination_overrides RENAME TO destination_overrides_old; CREATE TABLE destination_overrides(media_id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO destination_overrides SELECT media_id,destination_id,updated_by,updated_at FROM destination_overrides_old; DROP TABLE destination_overrides_old;');
db.pragma('user_version = 3');
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const one = <T extends Row = Row>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined;
export const all = <T extends Row = Row>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
export const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
export const getSetting = (key: string) => one<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value;
export const setSetting = (key: string, value: string) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
export function audit(type: string, actor: { id?: string; name?: string; tokenId?: string } | null, resourceType?: string, resourceId?: string, details: Row = {}) {
  run('INSERT INTO audit(id,actor_id,actor_name,token_id,type,resource_type,resource_id,details,created_at) VALUES(?,?,?,?,?,?,?,?,?)', uid(), actor?.id ?? null, actor?.name ?? null, actor?.tokenId ?? null, type, resourceType ?? null, resourceId ?? null, JSON.stringify(details), now());
}
export function operationLog(level:'info'|'warn'|'error',message:string,details:Row={}){
  run('INSERT INTO operational_logs(id,level,message,details,created_at) VALUES(?,?,?,?,?)',uid(),level,message,JSON.stringify(details),now());
}
