// Gemeinsamer Anwendungskontext, den die Routen-Module erhalten.
import type { Auth, LoginLimiter } from './auth.js';
import type { Config } from './config.js';
import type { ConnectionState } from './connection.js';
import type { Logger } from './log.js';
import type { PasskeyService } from './passkeys.js';
import type { Db } from './sqlite.js';
import type { EventPump, Hub } from './sse.js';

export interface App {
  cfg: Config;
  db: Db;
  log: Logger;
  auth: Auth;
  limiter: LoginLimiter;
  conn: ConnectionState;
  hub: Hub;
  pump: EventPump;
  passkeys: PasskeyService;
}
