/**
 * End-to-End: Benutzer registriert sich, ein MCP-Client (wie Claude/ChatGPT) verbindet sich per OAuth 2.1
 * (Dynamic Client Registration + PKCE) und liest/schreibt anschliessend über die MCP-Tools.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 40000 + Math.floor(Math.random() * 10000);
process.env.PUBLIC_URL = `http://localhost:${PORT}`;
process.env.DB_FILE = ':memory:';
process.env.WEB_DIR = '/nonexistent';

const BASE = process.env.PUBLIC_URL;
let server: import('node:http').Server;
let cookie = '';
let groupId = 0;
let tokens: { access_token: string; refresh_token: string };
const REDIRECT = 'http://localhost:9999/callback';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-splitapp': '1', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function parseToolJson(result: any) {
  const text = result.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf('{')));
}

before(async () => {
  const { openDb } = await import('../src/server/db.ts');
  const { createApp } = await import('../src/server/app.ts');
  const app = createApp(openDb(':memory:'));
  await new Promise<void>((resolve) => {
    server = app.listen(PORT, resolve);
  });
  assert.equal((server.address() as AddressInfo).port, PORT);
});

after(() => server?.close());

test('Registrierung und Gruppe über die Web-API', async () => {
  const reg = await api('POST', '/api/auth/register', { email: 'jan@example.com', name: 'Jan', password: 'geheim1234' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const g = await api('POST', '/api/groups', { name: 'Tessin-Ferien', currency: 'CHF', members: ['Anna', 'Ben'] });
  assert.equal(g.status, 200);
  groupId = g.body.group.id;
  assert.equal(g.body.group.members.length, 3);
});

test('MCP ohne Token antwortet mit 401 und Verweis auf die Metadaten', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="[^"]*oauth-protected-resource\/mcp"/);
});

test('OAuth 2.1: Discovery, Registrierung, Zustimmung, Token', async () => {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asMeta.registration_endpoint);

  const reg = await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${BASE}/mcp`,
  }).toString();
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(authRes.status, 302);
  const consentPath = authRes.headers.get('location')!;
  assert.match(consentPath, /^\/oauth\/consent\?request=/);

  // Zustimmungsseite mit Web-Session
  const consentHtml = await (await fetch(BASE + consentPath, { headers: { cookie } })).text();
  assert.match(consentHtml, /Claude verbinden\?/);
  const csrf = consentHtml.match(/name="csrf" value="([^"]+)"/)![1]!;
  const requestId = new URL(BASE + consentPath).searchParams.get('request')!;

  const approve = await fetch(`${BASE}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ request: requestId, csrf, action: 'approve' }),
  });
  assert.equal(approve.status, 302);
  const cb = new URL(approve.headers.get('location')!);
  assert.equal(cb.origin + cb.pathname, REDIRECT);
  assert.equal(cb.searchParams.get('state'), 'xyz');
  const code = cb.searchParams.get('code')!;

  // Falscher Verifier wird abgelehnt
  const bad = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'falsch', client_id: client.client_id, redirect_uri: REDIRECT }),
  });
  assert.equal(bad.status, 400);

  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }),
  });
  assert.equal(tokenRes.status, 200);
  tokens = await tokenRes.json();
  assert.ok(tokens.access_token.startsWith('sa_at_'));

  // Code ist nur einmal gültig
  const reuse = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id }),
  });
  assert.equal(reuse.status, 400);

  // Refresh-Token-Rotation
  const refresh = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
  });
  assert.equal(refresh.status, 200);
  const oldRefresh = tokens.refresh_token;
  tokens = await refresh.json();
  const replay = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: client.client_id }),
  });
  assert.equal(replay.status, 400);

  const conns = await api('GET', '/api/connections');
  assert.equal(conns.body.connections.length, 1);
  assert.equal(conns.body.connections[0].clientName, 'Claude');
});

test('MCP-Tools: Gruppen sehen, Einträge lesen, erfassen, ändern, löschen', async () => {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['list_groups', 'get_group', 'list_expenses', 'create_expense', 'update_expense', 'delete_expense', 'search', 'fetch']) {
    assert.ok(names.includes(n), `Tool ${n} fehlt`);
  }

  const groupsRes = parseToolJson(await client.callTool({ name: 'list_groups', arguments: {} }));
  assert.equal(groupsRes.groups[0].name, 'Tessin-Ferien');

  // Ich zahle 90 CHF, gleichmässig auf alle drei
  const created = parseToolJson(
    await client.callTool({ name: 'create_expense', arguments: { group_id: groupId, description: 'Abendessen', amount: 90, category: 'food' } }),
  );
  assert.equal(created.amount, 90);
  assert.deepEqual(created.split.map((s: any) => s.owes), [30, 30, 30]);

  // Anna zahlt Hotel, Aufteilung nach Nächten
  const hotel = parseToolJson(
    await client.callTool({
      name: 'create_expense',
      arguments: {
        group_id: groupId,
        description: 'Hotel',
        amount: 300,
        paid_by: 'anna',
        split_type: 'shares',
        split: [{ member: 'me', value: 2 }, { member: 'Anna', value: 1 }],
        date: '2026-08-01',
      },
    }),
  );
  assert.deepEqual(hotel.split.map((s: any) => s.owes), [200, 100]);

  // Betrag ändern: Anteile bleiben erhalten
  const updated = parseToolJson(await client.callTool({ name: 'update_expense', arguments: { expense_id: hotel.id, amount: 330 } }));
  assert.deepEqual(updated.split.map((s: any) => s.owes), [220, 110]);

  // Mehrdeutiger/unbekannter Name liefert hilfreichen Fehler
  const err = await client.callTool({ name: 'create_expense', arguments: { group_id: groupId, description: 'x', amount: 5, paid_by: 'Zoe' } });
  assert.equal(err.isError, true);
  assert.match((err.content as any)[0].text, /Kein Mitglied «Zoe»/);

  const list = parseToolJson(await client.callTool({ name: 'list_expenses', arguments: { group_id: groupId } }));
  assert.equal(list.total, 2);

  // Salden: Ich habe 90 bezahlt, schulde 30 + 220 = 250 -> -160. Anna hat 330 bezahlt, schuldet 30 + 110 -> +190. Ben -30.
  const group = parseToolJson(await client.callTool({ name: 'get_group', arguments: { group_id: groupId } }));
  const bal = Object.fromEntries(group.members.map((m: any) => [m.name, m.balances[0]?.amount ?? 0]));
  assert.deepEqual(bal, { Jan: -160, Anna: 190, Ben: -30 });

  // Ausgleichszahlung
  const pay = parseToolJson(await client.callTool({ name: 'record_payment', arguments: { group_id: groupId, to: 'Anna', amount: 160 } }));
  assert.equal(pay.type, 'payment');
  const overall = parseToolJson(await client.callTool({ name: 'get_balances', arguments: {} }));
  assert.equal(overall.overall.length, 0);

  // Löschen und Wiederherstellen
  await client.callTool({ name: 'delete_expense', arguments: { expense_id: created.id } });
  const afterDelete = parseToolJson(await client.callTool({ name: 'list_expenses', arguments: { group_id: groupId } }));
  assert.equal(afterDelete.total, 2);
  await client.callTool({ name: 'restore_expense', arguments: { expense_id: created.id } });
  const afterRestore = parseToolJson(await client.callTool({ name: 'list_expenses', arguments: { group_id: groupId } }));
  assert.equal(afterRestore.total, 3);

  // ChatGPT-kompatibles search/fetch
  const search = parseToolJson(await client.callTool({ name: 'search', arguments: { query: 'hotel' } }));
  assert.equal(search.results[0].id, `expense:${hotel.id}`);
  const doc = parseToolJson(await client.callTool({ name: 'fetch', arguments: { id: search.results[0].id } }));
  assert.equal(doc.title, 'Hotel');

  // Aktivität zeigt, dass die Änderungen über MCP kamen
  const act = await api('GET', `/api/groups/${groupId}/activity`);
  assert.ok(act.body.activity.some((a: any) => a.via === 'mcp:Claude'));

  await client.close();
});

test('Fremde Gruppen sind nicht zugänglich und Widerruf sperrt den Token', async () => {
  const savedCookie = cookie;
  cookie = '';
  await api('POST', '/api/auth/register', { email: 'eve@example.com', name: 'Eve', password: 'geheim1234' });
  const forbidden = await api('GET', `/api/groups/${groupId}`);
  assert.equal(forbidden.status, 403);
  cookie = savedCookie;

  const conns = await api('GET', '/api/connections');
  await api('DELETE', `/api/connections/${conns.body.connections[0].id}`);
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
});
