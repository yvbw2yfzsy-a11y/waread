// Notausstieg fuer die Passkey-Sperre. Gedacht fuer den Fall "Handy weg" oder "Passkey funktioniert nicht".
// Braucht Zugriff auf die Passkey-Datei, also Shell-Zugang zum Server (das ist der Besitznachweis).
//
//   sudo -u waread node /opt/waread/services/web/dist/passkey-admin.js status
//   sudo -u waread node /opt/waread/services/web/dist/passkey-admin.js unlock   # Sperre aus, Passkeys bleiben
//   sudo -u waread node /opt/waread/services/web/dist/passkey-admin.js reset --yes   # alles entfernen
//
// Der laufende Dienst bemerkt die Aenderung binnen etwa einer Sekunde; alle Sitzungen werden dabei beendet.
// Mit --file kann die Datei direkt angegeben werden, sonst gilt web.passkey_file aus der Konfiguration.
import { loadConfig } from './config.js';
import { adminReset, adminStatus, adminUnlock } from './passkeys.js';

function usage(): never {
  process.stderr.write('Verwendung: passkey-admin <status|unlock|reset> [--file <pfad>] [--yes]\n');
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== 'status' && cmd !== 'unlock' && cmd !== 'reset') usage();
  let file: string | undefined;
  let yes = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--file' && args[i + 1] !== undefined) file = args[++i]!;
    else if (a === '--yes') yes = true;
    else usage();
  }
  if (!file) {
    try {
      file = loadConfig(process.env['WAREAD_CONFIG'] ?? '/etc/waread/config.toml').web.passkeyFile;
    } catch (err) {
      process.stderr.write(`passkey-admin: Konfiguration nicht lesbar (${(err as Error).message}). Mit --file <pfad> direkt angeben.\n`);
      process.exit(1);
    }
  }

  try {
    if (cmd === 'status') {
      const s = adminStatus(file);
      process.stdout.write(
        `Datei: ${file}\n` +
          `Vorhanden: ${s.exists ? 'ja' : 'nein'}\n` +
          `Zustand: ${s.valid ? 'gueltig' : 'UNGUELTIG (der Dienst behandelt das als gesperrt)'}\n` +
          `Sperre: ${s.lock ? 'an' : 'aus'}\n` +
          `Passkeys: ${s.credentials}\n`,
      );
    } else if (cmd === 'unlock') {
      adminUnlock(file);
      process.stdout.write('Passkey-Sperre aufgehoben (entsperrt). Alle Sitzungen sind beendet, das Passwort gilt wieder.\n');
    } else {
      if (!yes) {
        process.stderr.write('Das entfernt ALLE Passkeys und die Sperre. Zur Bestaetigung --yes angeben.\n');
        process.exit(1);
      }
      adminReset(file);
      process.stdout.write('Alle Passkeys entfernt, Sperre aus. Alle Sitzungen sind beendet. Auf dem Geraet ggf. den alten Eintrag "waread" loeschen.\n');
    }
  } catch (err) {
    process.stderr.write(`passkey-admin: Fehler (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})\n`);
    process.exit(1);
  }
}

main();
