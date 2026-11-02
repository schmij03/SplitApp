import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import type { DB } from './db.js';
import { errorHandler } from './http.js';
import { consentRouter } from './mcp/consent.js';
import { SCOPE, SplitAppOAuthProvider } from './mcp/oauth.js';
import { buildMcpServer } from './mcp/tools.js';
import { apiRouter } from './routes/api.js';

export function createApp(db: DB) {
  const app = express();
  app.disable('x-powered-by');
  const trust = config.trustProxy;
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);

  const oauth = new SplitAppOAuthProvider(db);

  // --- OAuth 2.1 Authorization Server + Metadaten (/.well-known/*, /authorize, /token, /register, /revoke) ---
  // MCP-Clients laufen teils im Browser (z. B. MCP Inspector), daher CORS für diese Endpunkte.
  const oauthCors = cors({ origin: true, exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'] });
  app.use(['/.well-known', '/token', '/register', '/revoke'], oauthCors);
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: config.publicUrl,
      resourceServerUrl: config.mcpUrl,
      resourceName: 'SplitApp',
      scopesSupported: [SCOPE],
      serviceDocumentationUrl: new URL('/connect', config.publicUrl),
      // Claude und ChatGPT rufen /token von gemeinsam genutzten Server-IPs auf: grosszügigere Limits.
      tokenOptions: { rateLimit: { windowMs: 15 * 60 * 1000, max: 1000 } },
      // Client-Secrets nicht nach 30 Tagen ablaufen lassen, sonst müssten sich Claude/ChatGPT monatlich neu verbinden.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { windowMs: 60 * 60 * 1000, max: 200 } },
    }),
  );
  // Einige Clients fragen die Protected-Resource-Metadaten ohne Pfadsuffix ab.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: config.mcpUrl.href,
      authorization_servers: [config.publicUrl.href],
      scopes_supported: [SCOPE],
      resource_name: 'SplitApp',
    });
  });
  app.use(consentRouter(db, oauth));

  // --- MCP-Endpunkt (Streamable HTTP, zustandslos) ---
  const bearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });
  app.use('/mcp', oauthCors);
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const extra = req.auth!.extra as { userId: number; clientName: string };
    const server = buildMcpServer({ db, userId: extra.userId, via: `mcp:${extra.clientName}` });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP-Fehler', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Interner Fehler' }, id: null });
      }
    }
  });
  app.all('/mcp', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Dieser Server ist zustandslos: nur POST wird unterstützt.' },
      id: null,
    });
  });

  // --- REST-API für die Web-App ---
  app.use('/api', apiRouter(db, oauth));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // --- Web-App (gebautes React-Frontend) ---
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|mcp|oauth\/|\.well-known\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.webDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) =>
      res.type('text').send('SplitApp-API läuft. Frontend fehlt: "npm run build" ausführen oder "npm run dev" nutzen.'),
    );
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
  app.use(errorHandler);
  return app;
}
