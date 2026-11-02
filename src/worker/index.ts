import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { app } from './api.js';
import { Db } from './db.js';
import { appLink, webUrl, type AuthProps, type Env } from './env.js';
import { buildMcpServer } from './mcp/tools.js';

/** MCP-Endpunkt: wird nur mit gültigem Access-Token erreicht (prüft die OAuth-Bibliothek). */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Dieser Server ist zustandslos: nur POST wird unterstützt.' }, id: null },
        { status: 405, headers: { Allow: 'POST' } },
      );
    }
    const props = (ctx as ExecutionContext & { props: AuthProps }).props;
    const origin = new URL(request.url).origin;
    const server = buildMcpServer(
      { db: new Db(env.DB), userId: props.userId, via: `mcp:${props.clientName}` },
      webUrl(env, origin),
      (path) => appLink(env, origin, path),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const DAY = 86400;
const providers = new Map<string, OAuthProvider<Env>>();

/** Die Ressourcen-URL muss absolut sein; sie ergibt sich aus der Adresse, unter der der Worker erreichbar ist. */
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as any,
      defaultHandler: app as any,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['splitapp'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'SplitApp' },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      // Verbindungen bleiben bestehen, solange sie mindestens alle 90 Tage genutzt werden.
      refreshTokenTTL: 90 * DAY,
      refreshTokenIdleTTL: 90 * DAY,
      // Dynamisch registrierte Clients (Claude, ChatGPT) nicht ablaufen lassen.
      clientRegistrationTTL: undefined,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Eigene env-Kopie pro Anfrage: Die Bibliothek legt dort OAUTH_PROVIDER ab, und bei mehreren Adressen
    // (z. B. workers.dev und eigene Domain) dürfen sich die Instanzen nicht gegenseitig überschreiben.
    return providerFor(new URL(request.url).origin).fetch(request, { ...env }, ctx);
  },
} satisfies ExportedHandler<Env>;
