import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { ensureSecretKey } from './secret-key.js';
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
process.env.FILTARR_SECRET_KEY = ensureSecretKey(
  process.env.FILTARR_DB ?? './data/filtarr.db',
  process.env.FILTARR_SECRET_KEY,
  process.env.FILTARR_SECRET_FILE
);
