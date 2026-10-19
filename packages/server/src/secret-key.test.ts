import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureSecretKey } from './secret-key.js';

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'filtarr-secret-'));
  directories.push(directory);
  return { database: join(directory, 'filtarr.db'), keyFile: join(directory, 'filtarr.db.key') };
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('persistent encryption key', () => {
  it('generates a private key once and reuses it across starts', () => {
    const { database, keyFile } = fixture();
    const first = ensureSecretKey(database);
    expect(first).toMatch(/^[a-f\d]{64}$/);
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(first);
    expect(statSync(keyFile).mode & 0o077).toBe(0);
    expect(ensureSecretKey(database)).toBe(first);
  });

  it('accepts an explicit key and detects a mismatch with a persisted key', () => {
    const { database, keyFile } = fixture();
    const explicit = 'a'.repeat(64);
    expect(ensureSecretKey(database, explicit)).toBe(explicit);
    expect(existsSync(keyFile)).toBe(false);
    expect(ensureSecretKey(database)).not.toBe(explicit);
    expect(() => ensureSecretKey(database, explicit)).toThrow(/differs/);
    expect(() => ensureSecretKey(database, 'not-hex')).toThrow(/64 hexadecimal/);
  });

  it('allows a database with no encrypted credentials to recover with a new key', () => {
    const { database } = fixture();
    const sqlite = new Database(database);
    sqlite.exec('CREATE TABLE connections (api_key_cipher TEXT); CREATE TABLE settings (key TEXT, value TEXT)');
    sqlite.close();
    expect(ensureSecretKey(database)).toMatch(/^[a-f\d]{64}$/);
  });

  it('refuses to replace a lost key when encrypted credentials exist', () => {
    const { database, keyFile } = fixture();
    const first = ensureSecretKey(database);
    const sqlite = new Database(database);
    sqlite.exec('CREATE TABLE connections (api_key_cipher TEXT); CREATE TABLE settings (key TEXT, value TEXT)');
    sqlite.prepare('INSERT INTO connections(api_key_cipher) VALUES(?)').run('encrypted-value');
    sqlite.close();
    unlinkSync(keyFile);
    expect(() => ensureSecretKey(database)).toThrow(/Encrypted credentials exist/);
    expect(existsSync(keyFile)).toBe(false);
    expect(ensureSecretKey(database, first)).toBe(first);
  });
});
