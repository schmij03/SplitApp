/**
 * Richtet die Cloudflare-Ressourcen beim Deployment automatisch ein:
 * D1-Datenbank "splitapp" und KV-Namespace "splitapp-oauth" werden gesucht oder angelegt,
 * ihre IDs werden in wrangler.jsonc eingetragen (nur in der CI-Arbeitskopie, nicht im Repo).
 * Benötigt CLOUDFLARE_API_TOKEN und CLOUDFLARE_ACCOUNT_ID.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const DB_NAME = 'splitapp';
const KV_NAME = 'splitapp-oauth';

const wrangler = (...args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const json = (out) => JSON.parse(out.slice(out.search(/[[{]/)));

function d1Id() {
  return json(wrangler('d1', 'list', '--json')).find((d) => d.name === DB_NAME)?.uuid;
}
function kvId() {
  return json(wrangler('kv', 'namespace', 'list')).find((n) => n.title === KV_NAME || n.title.endsWith(`-${KV_NAME}`))?.id;
}

let db = d1Id();
if (!db) {
  console.log(`D1-Datenbank «${DB_NAME}» wird angelegt …`);
  wrangler('d1', 'create', DB_NAME);
  db = d1Id();
}
let kv = kvId();
if (!kv) {
  console.log(`KV-Namespace «${KV_NAME}» wird angelegt …`);
  wrangler('kv', 'namespace', 'create', KV_NAME);
  kv = kvId();
}
if (!db || !kv) throw new Error(`Ressourcen konnten nicht eingerichtet werden (D1: ${db}, KV: ${kv}).`);

const file = 'wrangler.jsonc';
const config = fs
  .readFileSync(file, 'utf8')
  .replace('"00000000-0000-0000-0000-000000000000"', JSON.stringify(db))
  .replace('"00000000000000000000000000000000"', JSON.stringify(kv));
fs.writeFileSync(file, config);
console.log(`D1: ${db}\nKV: ${kv}`);
