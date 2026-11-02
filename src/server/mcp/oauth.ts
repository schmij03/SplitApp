/**
 * OAuth 2.1 Authorization Server für MCP-Clients (Claude, ChatGPT, ...).
 *
 * Ablauf:
 *  1. Client registriert sich dynamisch (POST /register, RFC 7591)
 *  2. Client leitet den Benutzer auf /authorize weiter -> wir speichern die Anfrage und zeigen /oauth/consent
 *  3. Benutzer meldet sich an und bestätigt -> Redirect mit einmaligem Code zurück zum Client
 *  4. Client tauscht Code (+ PKCE-Verifier) gegen Access- und Refresh-Token (POST /token)
 *  5. Client ruft /mcp mit "Authorization: Bearer <token>" auf
 */
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../crypto.js';
import { nowSeconds, tx, type DB } from '../db.js';
import type { Row } from '../services/context.js';

export const SCOPE = 'splitapp';
const CODE_TTL = 5 * 60;
const REQUEST_TTL = 30 * 60;

export interface PendingAuthorization {
  id: string;
  client: OAuthClientInformationFull;
  params: { state?: string; scopes: string[]; codeChallenge: string; redirectUri: string; resource?: string };
}

function sameResource(a: string, b: string) {
  const norm = (u: string) => {
    const url = new URL(u);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

export class SplitAppOAuthProvider implements OAuthServerProvider {
  constructor(private db: DB) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.db;
    return {
      getClient(clientId: string) {
        const row = db.prepare('SELECT info FROM oauth_clients WHERE client_id = ?').get(clientId) as Row | undefined;
        return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
      },
      registerClient(client) {
        // client_id und client_secret erzeugt bereits das SDK; wir speichern nur.
        const full = client as OAuthClientInformationFull;
        db.prepare('INSERT INTO oauth_clients (client_id, info) VALUES (?, ?)').run(full.client_id, JSON.stringify(full));
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource.href, config.mcpUrl.href)) {
      throw new InvalidTargetError(`Unbekannte Ressource: ${params.resource.href}`);
    }
    const id = randomToken(24);
    const stored: PendingAuthorization['params'] = {
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [SCOPE],
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
    };
    this.db
      .prepare('INSERT INTO oauth_requests (id, client_id, params, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, client.client_id, JSON.stringify(stored), nowSeconds() + REQUEST_TTL);
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
  }

  getPending(id: string): PendingAuthorization | undefined {
    const row = this.db
      .prepare('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?')
      .get(String(id ?? ''), nowSeconds()) as Row | undefined;
    if (!row) return undefined;
    const client = this.clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined;
    if (!client) return undefined;
    return { id: row.id, client, params: JSON.parse(row.params) };
  }

  /** Benutzer hat zugestimmt: Code erzeugen und Redirect-URL zurückgeben. */
  approve(pending: PendingAuthorization, userId: number): string {
    const code = randomToken(32);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(pending.id);
      this.db
        .prepare(
          `INSERT INTO oauth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256(code),
          pending.client.client_id,
          userId,
          pending.params.codeChallenge,
          pending.params.redirectUri,
          pending.params.scopes.join(' '),
          nowSeconds() + CODE_TTL,
        );
    });
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set('code', code);
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state);
    return url.href;
  }

  deny(pending: PendingAuthorization): string {
    this.db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(pending.id);
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'Der Benutzer hat den Zugriff abgelehnt.');
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state);
    return url.href;
  }

  private codeRow(client: OAuthClientInformationFull, code: string): Row {
    const row = this.db
      .prepare('SELECT * FROM oauth_codes WHERE code_hash = ? AND expires_at > ?')
      .get(sha256(code), nowSeconds()) as Row | undefined;
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Ungültiger oder abgelaufener Code.');
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.codeRow(client, code).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const row = this.codeRow(client, code);
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri stimmt nicht überein.');
    // Code ist einmalig gültig (PKCE wurde vom SDK bereits geprüft).
    this.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(row.code_hash);
    return this.issueTokens(client.client_id, row.user_id, row.scopes.split(' '), randomToken(16));
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND expires_at > ?")
      .get(sha256(refreshToken), nowSeconds()) as Row | undefined;
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Ungültiger Refresh-Token.');
    // Refresh-Token-Rotation: alter Token wird ungültig.
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(row.token_hash);
    return this.issueTokens(client.client_id, row.user_id, row.scopes.split(' '), row.grant_id);
  }

  private issueTokens(clientId: string, userId: number, scopes: string[], grantId: string): OAuthTokens {
    const access = `sa_at_${randomToken(32)}`;
    const refresh = `sa_rt_${randomToken(32)}`;
    const ins = this.db.prepare(
      'INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, user_id, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    tx(this.db, () => {
      ins.run(sha256(access), 'access', grantId, clientId, userId, scopes.join(' '), nowSeconds() + config.accessTokenSeconds);
      ins.run(sha256(refresh), 'refresh', grantId, clientId, userId, scopes.join(' '), nowSeconds() + config.refreshTokenDays * 86400);
    });
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: config.accessTokenSeconds,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db
      .prepare(
        `SELECT t.*, c.info AS client_info FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.token_hash = ? AND t.kind = 'access'`,
      )
      .get(sha256(token)) as Row | undefined;
    if (!row || row.expires_at <= nowSeconds()) throw new InvalidTokenError('Token ist ungültig oder abgelaufen.');
    this.db
      .prepare(`UPDATE oauth_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?`)
      .run(row.token_hash);
    const clientName = (JSON.parse(row.client_info) as OAuthClientInformationFull).client_name ?? 'MCP-Client';
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' ').filter(Boolean),
      expiresAt: row.expires_at,
      resource: config.mcpUrl,
      extra: { userId: row.user_id, clientName },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.db.prepare('SELECT grant_id, client_id FROM oauth_tokens WHERE token_hash = ?').get(sha256(request.token)) as
      | Row
      | undefined;
    if (row && row.client_id === client.client_id) {
      this.db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(row.grant_id);
    }
  }

  // --- Verwaltung im Web-UI ("Verbundene Apps") -----------------------------

  listConnections(userId: number) {
    const rows = this.db
      .prepare(
        `SELECT t.grant_id, t.client_id, c.info, MIN(t.created_at) AS connected_at, MAX(t.last_used_at) AS last_used_at
         FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ? AND t.expires_at > ? GROUP BY t.grant_id ORDER BY connected_at DESC`,
      )
      .all(userId, nowSeconds()) as Row[];
    return rows.map((r) => {
      const info = JSON.parse(r.info) as OAuthClientInformationFull;
      return {
        id: r.grant_id as string,
        clientName: info.client_name ?? 'Unbekannte App',
        clientUri: info.client_uri ?? null,
        redirectHost: safeHost(info.redirect_uris?.[0]),
        connectedAt: r.connected_at as string,
        lastUsedAt: (r.last_used_at as string) ?? null,
      };
    });
  }

  revokeConnection(userId: number, grantId: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND grant_id = ?').run(userId, grantId);
  }
}

export function safeHost(uri: string | undefined): string | null {
  try {
    return uri ? new URL(uri).host : null;
  } catch {
    return null;
  }
}
