import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const validKey = (value: string) => /^[a-f\d]{64}$/i.test(value);

function hasEncryptedCredentials(databasePath: string): boolean {
  if (!existsSync(databasePath)) return false;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = (name: string) => !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return (hasTable('connections') && !!database.prepare('SELECT 1 FROM connections WHERE api_key_cipher IS NOT NULL LIMIT 1').get())
      || (hasTable('settings') && !!database.prepare("SELECT 1 FROM settings WHERE key='tmdb_key_cipher' LIMIT 1").get());
  } finally {
    database.close();
  }
}

/** Use an explicit key, a persisted key, or a new first-run key in that order. */
export function ensureSecretKey(databaseFile: string, suppliedKey?: string, secretFile?: string): string {
  const databasePath = resolve(databaseFile);
  const keyPath = resolve(secretFile ?? `${databasePath}.key`);
  const explicit = suppliedKey?.trim() || undefined;
  if (explicit && !validKey(explicit)) throw Error('FILTARR_SECRET_KEY must contain exactly 64 hexadecimal characters');

  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, 'utf8').trim();
    if (!validKey(stored)) throw Error(`Invalid Filtarr secret file at ${keyPath}; restore the original key`);
    if (explicit && explicit.toLowerCase() !== stored.toLowerCase()) throw Error(`FILTARR_SECRET_KEY differs from ${keyPath}; restore the matching key before starting`);
    return explicit ?? stored;
  }
  if (explicit) return explicit;
  if (hasEncryptedCredentials(databasePath)) throw Error(`Encrypted credentials exist in ${databasePath}, but ${keyPath} is missing. Restore the original secret file or set FILTARR_SECRET_KEY.`);

  mkdirSync(dirname(keyPath), { recursive: true });
  const generated = randomBytes(32).toString('hex');
  let handle: number | undefined;
  try {
    handle = openSync(keyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(handle, `${generated}\n`);
    fsyncSync(handle);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stored = readFileSync(keyPath, 'utf8').trim();
    if (!validKey(stored)) throw Error(`Invalid Filtarr secret file at ${keyPath}; restore the original key`);
    return stored;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
