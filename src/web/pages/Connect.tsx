import { api, type Connection } from '../api.js';
import { CopyButton, ErrorBox, formatDateTime, useAuth, useLoader, useToast } from '../components/ui.js';
import { Link } from '../router.js';

export function ConnectPage() {
  const { user } = useAuth();
  const toast = useToast();
  const cfg = useLoader(() => api<{ mcpUrl: string }>('GET', '/config'), []);
  const conns = useLoader(
    () => (user ? api<{ connections: Connection[] }>('GET', '/connections') : Promise.resolve({ connections: [] })),
    [user?.id],
  );
  const mcpUrl = cfg.data?.mcpUrl ?? '…';

  return (
    <div className="stack">
      <div>
        <h1>Mit Claude oder ChatGPT verbinden</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          SplitApp ist ein MCP-Server. Nach dem Verbinden kann dein KI-Assistent alle deine Gruppen sehen, Einträge lesen sowie
          Einträge erfassen, ändern und löschen. Die Anmeldung läuft sicher über OAuth: dein Passwort sieht der Assistent nie.
        </p>
      </div>

      <div className="card stack">
        <h2>MCP-Server-URL</h2>
        <div className="code-block">
          <code>{mcpUrl}</code>
          <CopyButton text={mcpUrl} />
        </div>
        {mcpUrl.startsWith('http://') && !mcpUrl.includes('localhost') && (
          <div className="error-box">Claude und ChatGPT verlangen eine öffentliche HTTPS-Adresse. Bitte den Worker bei Cloudflare deployen (siehe README).</div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Claude</h2>
          <ol className="steps small">
            <li>
              In <strong>claude.ai</strong> oder der Claude-App: <em>Einstellungen → Connectors</em>
            </li>
            <li>
              <em>Benutzerdefinierten Connector hinzufügen</em> wählen
            </li>
            <li>Name «SplitApp» und die URL oben eintragen</li>
            <li>
              <em>Verbinden</em> klicken, bei SplitApp anmelden und den Zugriff erlauben
            </li>
            <li>Im Chat den Connector aktivieren und z. B. fragen: «Wie viel schulde ich in der Gruppe Tessin?»</li>
          </ol>
          <p className="small muted" style={{ marginTop: 10 }}>Claude Code (Terminal):</p>
          <div className="code-block" style={{ marginTop: 4 }}>
            <code>claude mcp add --transport http splitapp {mcpUrl}</code>
            <CopyButton text={`claude mcp add --transport http splitapp ${mcpUrl}`} />
          </div>
        </div>
        <div className="card">
          <h2>ChatGPT</h2>
          <ol className="steps small">
            <li>
              In ChatGPT: <em>Einstellungen → Apps &amp; Connectors → Erweitert</em> und den <em>Entwicklermodus</em> aktivieren
            </li>
            <li>
              <em>Erstellen</em> (neue App / neuer Connector) wählen
            </li>
            <li>Name «SplitApp», die URL oben und als Authentifizierung «OAuth» wählen</li>
            <li>Speichern, bei SplitApp anmelden und den Zugriff erlauben</li>
            <li>Im Chat über «+» bzw. die Tools SplitApp auswählen</li>
          </ol>
          <p className="small muted" style={{ marginTop: 10 }}>
            Die Menünamen können sich je nach Version leicht unterscheiden.
          </p>
        </div>
      </div>

      <div className="card stack">
        <h2>Beispiele für den Chat</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
          <li>«Zeig mir alle meine Gruppen und was ich jeweils schulde.»</li>
          <li>«Ich habe gestern 84.50 CHF fürs Abendessen mit Anna und Ben bezahlt.»</li>
          <li>«Ben hat das Hotel für 420 EUR bezahlt, ich war 2 Nächte, Anna 1 Nacht.»</li>
          <li>«Ändere den Betrag vom Einkauf bei Migros auf 63.20.»</li>
          <li>«Lösch die doppelte Taxi-Ausgabe vom Samstag.»</li>
          <li>«Wer muss wem wie viel zahlen, damit alles ausgeglichen ist?»</li>
        </ul>
      </div>

      <div className="card flush">
        <div style={{ padding: '16px 20px 8px' }}>
          <h2>Verbundene Apps</h2>
        </div>
        {!user ? (
          <div className="empty">
            <Link href="/login?next=/connect">Anmelden</Link>, um verbundene Apps zu sehen.
          </div>
        ) : conns.error ? (
          <div style={{ padding: 20 }}>
            <ErrorBox error={conns.error} />
          </div>
        ) : (conns.data?.connections.length ?? 0) === 0 ? (
          <div className="empty">Noch keine App verbunden.</div>
        ) : (
          <div className="list">
            {conns.data!.connections.map((c) => (
              <div key={c.id} className="list-item">
                <span className="icon-badge">🤖</span>
                <span className="grow">
                  <div className="title">{c.clientName}</div>
                  <div className="small muted">
                    Verbunden {formatDateTime(c.connectedAt)}
                    {c.redirectHost && ` · ${c.redirectHost}`}
                  </div>
                </span>
                <button
                  className="small danger"
                  onClick={async () => {
                    if (!window.confirm(`Zugriff für ${c.clientName} widerrufen?`)) return;
                    await api('DELETE', `/connections/${c.id}`);
                    toast({ message: `${c.clientName} getrennt` });
                    conns.reload();
                  }}
                >
                  Widerrufen
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
