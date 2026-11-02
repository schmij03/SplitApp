# SplitApp

Ausgaben in Gruppen teilen, ähnlich wie Splitwise: für WG, Ferien, Ausflüge oder Paare.
Die Oberfläche läuft auf **GitHub Pages**, Daten und Anmeldung auf einem **Cloudflare Worker**.
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

## Architektur

```
Browser ──▶ GitHub Pages (React-Oberfläche, statisch)
                 │  fetch + Bearer-Token
                 ▼
Claude / ChatGPT ──▶ Cloudflare Worker ──▶ D1 (SQLite): Benutzer, Gruppen, Ausgaben
                     /api   Web-API          KV: OAuth-Clients, Grants, Tokens (nur Hashes)
                     /mcp   MCP-Server
                     /authorize, /token, /register, /.well-known/*  OAuth 2.1
```

GitHub Pages kann nur statische Dateien ausliefern. Alles, was einen Server braucht (Konten, Datenbank,
Anmeldung für Claude/ChatGPT, MCP), läuft deshalb als **Cloudflare Worker**. Beides ist im Gratis-Kontingent
für den privaten Gebrauch mehr als ausreichend.

## Einrichtung (einmalig)

1. **Cloudflare-Konto** (gratis) auf [dash.cloudflare.com](https://dash.cloudflare.com) erstellen und einmal
   *Workers & Pages* öffnen, damit eine `workers.dev`-Subdomain angelegt wird.
2. **API-Token** erstellen: *Mein Profil → API-Token → Token erstellen → Vorlage «Cloudflare Workers bearbeiten»*
   und zusätzlich die Berechtigung *Konto → D1 → Bearbeiten* hinzufügen.
3. **Account-ID** kopieren: *Workers & Pages → Übersicht*, rechte Spalte.
4. Auf GitHub im Repository unter *Settings → Secrets and variables → Actions* zwei **Secrets** anlegen:
   `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID`.
5. Unter *Settings → Pages* bei *Source* **GitHub Actions** wählen.
6. Den Code auf den Branch `main` bringen (Pull Request mergen) oder unter *Actions → Deploy → Run workflow* starten.

Der Workflow `.github/workflows/deploy.yml` legt beim ersten Lauf die D1-Datenbank und den KV-Namespace an,
spielt die Datenbank-Migrationen ein, deployt den Worker und danach die Oberfläche auf GitHub Pages:

- Web-App: `https://<github-benutzer>.github.io/<repo>/`
- MCP-URL: `https://splitapp.<deine-subdomain>.workers.dev/mcp` (steht in der Zusammenfassung des Workflow-Laufs
  und in der App unter «KI verbinden»)

Optionale **Repository-Variablen** (*Settings → Secrets and variables → Actions → Variables*):

| Variable | Zweck |
| --- | --- |
| `SPLITAPP_API_URL` | Worker-Adresse, falls nicht `*.workers.dev` (z. B. eigene Domain) |
| `SPLITAPP_WEB_URL` | Adresse der Oberfläche, falls nicht `https://<user>.github.io/<repo>/` |

Registrierung neuer Konten abschalten: in `wrangler.jsonc` `ALLOW_REGISTRATION` auf `"false"` setzen.

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
.github/         Deploy (Worker + Pages) und CI
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
