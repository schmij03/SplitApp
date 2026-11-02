# SplitApp

Ausgaben in Gruppen teilen, ähnlich wie Splitwise: für WG, Ferien, Ausflüge oder Paare.
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

## Schnellstart (lokal)

Voraussetzung: **Node.js 22.13 oder neuer** (nutzt das eingebaute SQLite, keine nativen Abhängigkeiten).

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Danach läuft die App auf http://localhost:3000. Für die Entwicklung mit Hot Reload:

```bash
npm run dev
```

(Frontend auf http://localhost:5173, API auf Port 3000.)

## Betrieb im Internet

Claude und ChatGPT verbinden sich von ihren Servern aus. Die App muss deshalb unter einer **öffentlichen
HTTPS-Adresse** erreichbar sein. Wichtige Umgebungsvariablen (siehe `.env.example`):

| Variable | Bedeutung |
| --- | --- |
| `PUBLIC_URL` | Öffentliche Adresse, z. B. `https://split.example.com` (Pflicht) |
| `APP_SECRET` | Zufälliger geheimer Wert, z. B. aus `openssl rand -hex 32` |
| `DATA_DIR` | Ordner für die SQLite-Datenbank (persistentes Volume!) |
| `ALLOW_REGISTRATION` | `false`, um nach dem Einrichten keine neuen Konten mehr zuzulassen |
| `TRUST_PROXY` | Anzahl Reverse-Proxies vor der App (Standard bei HTTPS: `1`) |

### Mit Docker

```bash
docker build -t splitapp .
```

```bash
docker run -d -p 3000:3000 -v splitapp-data:/data -e PUBLIC_URL=https://split.example.com -e APP_SECRET=$(openssl rand -hex 32) splitapp
```

Davor einen Reverse-Proxy mit HTTPS (z. B. Caddy, Traefik, nginx) oder eine Plattform wie Fly.io,
Railway oder Render verwenden. Wichtig ist ein **persistentes Volume** für `/data`.

Zum schnellen Ausprobieren ohne Server reicht auch ein Tunnel, z. B. `cloudflared tunnel --url http://localhost:3000`.
Die angezeigte HTTPS-Adresse dann als `PUBLIC_URL` setzen und die App neu starten.

## Mit Claude oder ChatGPT verbinden

Die MCP-URL lautet `https://<deine-domain>/mcp`. Die Seite **«KI verbinden»** in der App zeigt sie mit Kopierknopf an.

**Claude** (claude.ai, Desktop, Mobile): Einstellungen → Connectors → *Benutzerdefinierten Connector hinzufügen* →
URL eintragen → *Verbinden* → bei SplitApp anmelden → *Zugriff erlauben*.

**Claude Code:**

```bash
claude mcp add --transport http splitapp https://split.example.com/mcp
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
     │  Browser → /authorize ──────────▶  /oauth/consent: Login + «Zugriff erlauben»
     │  ◀─────────── Redirect mit Code
     │  POST /token (Code + PKCE-Verifier) → Access- und Refresh-Token
     │  POST /mcp mit Bearer-Token ────▶  Tools im Namen des Benutzers
```

- OAuth 2.1 mit PKCE (S256), Dynamic Client Registration (RFC 7591), Protected Resource Metadata (RFC 9728)
- Access-Token 1 Stunde gültig, Refresh-Token 90 Tage mit Rotation
- Tokens, Codes und Sessions werden nur als SHA-256-Hash gespeichert
- Jede Verbindung ist unter «KI verbinden → Verbundene Apps» sichtbar und widerrufbar
- Jeder Tool-Aufruf prüft, dass der Benutzer Mitglied der betroffenen Gruppe ist

## Projektstruktur

```
src/
  shared/        Geldbeträge, Aufteilungslogik, Schuldenvereinfachung (Server + Web)
  server/
    services/    Geschäftslogik und Berechtigungen (von Web-API und MCP gemeinsam genutzt)
    routes/      REST-API für die Web-App
    mcp/         OAuth-Server, Zustimmungsseite, MCP-Tools
    db.ts        SQLite-Schema (node:sqlite)
  web/           React-Frontend (Vite)
tests/           Unit-Tests und End-to-End-Test (OAuth + MCP)
```

## Tests

```bash
npm test
```

Der End-to-End-Test startet den Server, registriert einen Benutzer, durchläuft den kompletten OAuth-Ablauf
wie ein MCP-Client und ruft anschliessend die Tools zum Lesen, Erfassen, Ändern, Löschen und
Wiederherstellen auf.
