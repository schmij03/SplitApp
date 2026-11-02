import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { cleanupExpired } from './services/users.js';

const db = openDb();
cleanupExpired(db);
setInterval(() => cleanupExpired(db), 60 * 60 * 1000).unref();

if (!process.env.APP_SECRET) {
  console.warn('Hinweis: APP_SECRET ist nicht gesetzt. Offene Anmeldeseiten werden nach einem Neustart ungültig.');
}

createApp(db).listen(config.port, () => {
  console.log(`SplitApp läuft auf ${config.publicUrl.href} (Port ${config.port})`);
  console.log(`MCP-Endpunkt: ${config.mcpUrl.href}`);
});
