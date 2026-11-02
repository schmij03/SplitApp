# SplitApp

Ausgaben in Gruppen teilen, ähnlich wie Splitwise: für WG, Ferien, Ausflüge oder Paare.
Alles läuft gratis auf einem **Cloudflare Worker** (Oberfläche, Daten, Anmeldung), die Oberfläche auf Wunsch zusätzlich auf **GitHub Pages**.
Mit eingebautem **MCP-Server**, damit du SplitApp direkt in **Claude** oder **ChatGPT** verbinden
und Ausgaben im Chat erfassen, ändern, löschen und abfragen kannst.

> «Ich habe gestern 84.50 CHF fürs Abendessen mit Anna und Ben bezahlt.»
> «Wer muss wem wie viel zahlen, damit in der Gruppe Tessin alles ausgeglichen ist?»

## Funktionen

**Web-App**
- Konten mit E-Mail und Passwort
- Gruppen mit Standardwährung, Mitglieder als Platzhalter (z. B. «Anna»), die später per Einladungslink ihr Konto verknüpfen
- Ausgaben mit Kategorie, Datum, Notiz und mehreren Zahlern
- Aufteilung **gleichmässig**, nach **exakten Beträgen**, **Prozent** oder **Anteilen** (z. B. Nächte), mit Live-Vorschau
- Salden pro Person und Währung, **vereinfachte Schulden** (möglichst wenige Ausgleichszahlungen)
- Ausgleichszahlungen erfassen («Als bezahlt erfassen»)
- Gelöschte Einträge wiederherstellen, Rückgängig-Funktion
- Aktivitätsverlauf, inkl. Kennzeichnung, wenn etwas über Claude/ChatGPT geändert wurde
- Mehrere Währungen pro Gruppe, Hell-/Dunkelmodus, für Handy optimiert
- Verwaltung verbundener KI-Apps mit Widerruf

**MCP-Server** (`/mcp`, Streamable HTTP, OAuth 2.1)

| Tool | Zweck |
| --- | --- |
| `whoami` | Verbundenes Konto anzeigen |
| `list_groups` | Alle Gruppen mit eigenem Saldo |
| `get_group` | Mitglieder, Salden, Ausgleichsvorschläge, Gesamtausgaben |
| `get_balances` | Wer schuldet wem (über alle Gruppen oder pro Gruppe) |
| `list_expenses` | Einträge mit Filtern (Text, Mitglied, Zeitraum, gelöschte) |
| `get_expense` | Einzelner Eintrag im Detail |
| `create_expense` | Ausgabe erfassen (alle Aufteilungsarten, mehrere Zahler) |
| `update_expense` | Eintrag ändern (nur angegebene Felder) |
| `delete_expense` | Eintrag löschen (wiederherstellbar) |
| `restore_expense` | Gelöschten Eintrag wiederherstellen |
| `record_payment` | Ausgleichszahlung erfassen |
| `create_group`, `add_member` | Gruppe anlegen, Mitglied hinzufügen |
| `list_activity` | Änderungsverlauf |
| `search`, `fetch` | Suche über alles (kompatibel mit ChatGPT-Connectors) |

Mitglieder können in den Tools per ID, per Name oder mit `"me"` angegeben werden. Beträge sind immer
in der Hauptwährungseinheit (z. B. `12.5` = CHF 12.50).

## Einrichtung (etwa 5 Minuten)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/schmij03/SplitApp)

1. Auf den Knopf klicken
2. Bei Cloudflare anmelden oder gratis registrieren
3. GitHub verbinden, wenn Cloudflare danach fragt, und einen Namen für die Kopie des Repos wählen (z. B. `splitapp-deploy`)
4. **Create and deploy** klicken und warten, bis der Build fertig ist (etwa 2 Minuten)

Cloudflare legt dabei die Datenbank (D1) und den Schlüsselspeicher (KV) selbst an, spielt das Datenbankschema ein
und zeigt am Ende die Adresse an, z. B. `https://splitapp.<name>.workers.dev`:

- Web-App: `https://splitapp.<name>.workers.dev`
- MCP-URL für Claude/ChatGPT: `https://splitapp.<name>.workers.dev/mcp` (steht auch in der App unter «KI verbinden»)

Jeder Push auf die Kopie deployt automatisch neu. Registrierung neuer Konten abschalten: in `wrangler.jsonc`
`ALLOW_REGISTRATION` auf `"false"` setzen.

### Alternative: Deploy über GitHub Actions, Oberfläche zusätzlich auf GitHub Pages

Ohne Kopie des Repos, dafür mit API-Token:

1. Cloudflare-Konto erstellen und einmal *Workers & Pages* öffnen
2. API-Token erstellen: *Mein Profil → API-Token → Token erstellen → Vorlage «Cloudflare Workers bearbeiten»*,
   zusätzlich *Konto → D1 → Bearbeiten*
3. Im Repository unter *Settings → Secrets and variables → Actions* die Secrets `CLOUDFLARE_API_TOKEN` und
   `CLOUDFLARE_ACCOUNT_ID` (steht unter *Workers & Pages* rechts) anlegen
4. Unter *Settings → Pages* bei *Source* **GitHub Actions** wählen
5. Auf `main` pushen oder *Actions → Deploy → Run workflow*

Ohne diese Secrets überspringt der Workflow `.github/workflows/deploy.yml` den Deploy. Optionale Repository-Variablen:

| Variable | Zweck |
| --- | --- |
| `SPLITAPP_API_URL` | Worker-Adresse, falls nicht `*.workers.dev` (z. B. eigene Domain) |
| `SPLITAPP_WEB_URL` | Adresse der Oberfläche, falls nicht `https://<user>.github.io/<repo>/` |

## Architektur

```
Browser ──▶ Cloudflare Worker ──▶ D1 (SQLite): Benutzer, Gruppen, Ausgaben
            /        Oberfläche (statisch, optional auch auf GitHub Pages)
            /api     Web-API          KV: OAuth-Clients, Grants, Tokens (nur Hashes)
Claude / ChatGPT ──▶ /mcp     MCP-Server
            /authorize, /token, /register, /.well-known/*  OAuth 2.1
```

GitHub Pages kann nur statische Dateien ausliefern. Alles, was einen Server braucht (Konten, Datenbank,
Anmeldung für Claude/ChatGPT, MCP), läuft deshalb als **Cloudflare Worker**, der die Oberfläche gleich mit
ausliefert. Läuft die Oberfläche zusätzlich auf GitHub Pages, spricht sie den Worker per Bearer-Token an.

## Lokale Entwicklung

Voraussetzung: Node.js 20 oder neuer. Cloudflare wird lokal simuliert (workerd, lokale D1 und KV), ein Konto ist nicht nötig.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

Oberfläche auf http://localhost:5173, Worker auf http://localhost:8787 (MCP: http://localhost:8787/mcp).

## Mit Claude oder ChatGPT verbinden

Die MCP-URL lautet `https://<worker-adresse>/mcp`. Die Seite **«KI verbinden»** in der App zeigt sie mit Kopierknopf an.

**Claude** (claude.ai, Desktop, Mobile): Einstellungen → Connectors → *Benutzerdefinierten Connector hinzufügen* →
URL eintragen → *Verbinden* → bei SplitApp anmelden → *Zugriff erlauben*.

**Claude Code:**

```bash
claude mcp add --transport http splitapp https://splitapp.example.workers.dev/mcp
```

**ChatGPT:** Einstellungen → Apps & Connectors → Erweitert → *Entwicklermodus* aktivieren → *Erstellen* →
URL eintragen, Authentifizierung «OAuth» → bei SplitApp anmelden → *Zugriff erlauben*.

Die genauen Menünamen können sich je nach Version unterscheiden.

### Wie die Verbindung funktioniert

```
Claude/ChatGPT                         SplitApp
     │  POST /mcp (ohne Token)  ───────▶  401 + WWW-Authenticate (resource_metadata)
     │  GET /.well-known/oauth-protected-resource/mcp
     │  GET /.well-known/oauth-authorization-server
     │  POST /register  (Dynamic Client Registration)
     │  Browser → /authorize ──────────▶  Login + «Zugriff erlauben»
     │  ◀─────────── Redirect mit Code
     │  POST /token (Code + PKCE-Verifier) → Access- und Refresh-Token
     │  POST /mcp mit Bearer-Token ────▶  Tools im Namen des Benutzers
```

- Umgesetzt mit [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider):
  OAuth 2.1 mit PKCE (S256), Dynamic Client Registration (RFC 7591), Client ID Metadata Documents,
  Protected Resource Metadata (RFC 9728)
- Access-Token 1 Stunde gültig; die Verbindung bleibt bestehen, solange sie mindestens alle 90 Tage genutzt wird
- Wird ein Autorisierungscode zweimal eingelöst, werden alle daraus ausgestellten Tokens widerrufen
- Tokens, Codes und Sessions werden nur als Hash gespeichert, Passwörter mit PBKDF2-SHA256
- Anmeldeversuche sind pro IP begrenzt, die Zustimmungsseite ist gegen Einbetten und gefälschte Formulare geschützt
- Jede Verbindung ist unter «KI verbinden → Verbundene Apps» sichtbar und widerrufbar
- Jeder Tool-Aufruf prüft, dass der Benutzer Mitglied der betroffenen Gruppe ist

## Projektstruktur

```
src/
  shared/        Geldbeträge, Aufteilungslogik, Schuldenvereinfachung (Worker + Web)
  worker/
    services/    Geschäftslogik und Berechtigungen (von Web-API und MCP gemeinsam genutzt)
    mcp/         MCP-Tools
    api.ts       Web-API (Hono)
    authorize.ts Anmelde- und Zustimmungsseite für Claude/ChatGPT
    index.ts     Einstieg: OAuth-Provider, /mcp
  web/           React-Oberfläche (Vite, Hash-Routing für GitHub Pages)
migrations/      D1-Datenbankschema
scripts/         Einrichtung der Cloudflare-Ressourcen, End-to-End-Testlauf
.github/         Deploy über GitHub Actions (optional) und CI
```

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

Der End-to-End-Test startet den Worker lokal im Cloudflare-Runtime (workerd mit lokaler D1 und KV), registriert
einen Benutzer, durchläuft den kompletten OAuth-Ablauf wie ein MCP-Client (inklusive Anmeldung und Zustimmung)
und ruft anschliessend die Tools zum Lesen, Erfassen, Ändern, Löschen und Wiederherstellen auf. Beide laufen
auch automatisch in GitHub Actions (`ci.yml`).
