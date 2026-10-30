// Prozess-Einstieg des Web-Dienstes (waread-web.service).
import { createApp, LISTEN_HOST } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { DbModuleError, initDbClient, migrate, openDatabase } from './db.js';
import { createLogger, errFields } from './log.js';

async function main(): Promise<void> {
  const cfgFile = process.env['WAREAD_CONFIG'] ?? '/etc/waread/config.toml';

  let cfg: Config;
  try {
    cfg = loadConfig(cfgFile);
  } catch (err) {
    // ConfigError-Meldungen nennen nur Schluessel/Pfade, nie Werte (kein Hash im Journal).
    const msg = err instanceof ConfigError ? err.message : 'Konfiguration konnte nicht geladen werden';
    process.stderr.write(`waread-web: ${msg}\n`);
    process.exit(1);
  }

  const log = createLogger(cfg.web.logLevel);
  await initDbClient(cfg.paths.dbModule);
  const db = openDatabase(cfg.paths.db);
  migrate(db);

  const running = createApp({ cfg, db, log });
  await running.listen();
  log.info('listening', { host: LISTEN_HOST, port: cfg.web.port });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('shutdown', { signal });
    try {
      await running.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    log.error('unhandled_rejection', errFields(err));
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught_exception', errFields(err));
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  // DbModuleError-Meldungen nennen nur Pfade/Funktionsnamen und sind fuer die Fehlersuche gedacht.
  if (err instanceof DbModuleError) {
    process.stderr.write(`waread-web: ${err.message}\n`);
  } else {
    const f = errFields(err);
    process.stderr.write(`waread-web: Start fehlgeschlagen (${String(f['errName'])} ${String(f['errCode'] ?? '')})\n`);
  }
  process.exit(1);
});
