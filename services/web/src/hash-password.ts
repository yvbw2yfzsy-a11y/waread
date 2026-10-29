// Hilfsprogramm: Argon2id-Hash fuer web.password_hash / web.password_hash_file erzeugen.
//   node dist/hash-password.js
// Das Passwort wird nie als Argument uebergeben (Shell-Verlauf, ps), sondern interaktiv ohne Echo
// oder per Pipe auf stdin gelesen:  printf '%s' "$PW" | node dist/hash-password.js
// Ausgabe (stdout): nur der Hash im PHC-Format. Parameter nach OWASP-Empfehlung: m=19456 KiB, t=2, p=1.
import { randomBytes } from 'node:crypto';

const MIN_LENGTH = 10;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('abgebrochen'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden('Neues Passwort: ');
    const again = await readHidden('Wiederholen:     ');
    if (password !== again) throw new Error('Eingaben stimmen nicht ueberein');
  } else {
    password = await readAllStdin();
  }
  if (password.length < MIN_LENGTH) throw new Error(`Passwort zu kurz (mindestens ${MIN_LENGTH} Zeichen)`);

  const name = 'hash-wasm';
  type HashWasm = { argon2id(o: Record<string, unknown>): Promise<string> };
  let mod: HashWasm;
  try {
    const m = (await import(name)) as Partial<HashWasm> & { default?: Partial<HashWasm> };
    const api = typeof m.argon2id === 'function' ? m : m.default;
    if (!api || typeof api.argon2id !== 'function') throw new Error('unbrauchbar');
    mod = api as HashWasm;
  } catch {
    throw new Error('Paket "hash-wasm" nicht installiert oder unbrauchbar (npm install im Verzeichnis services/web)');
  }
  const hash = await mod.argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19456,
    hashLength: 32,
    outputType: 'encoded',
  });
  process.stdout.write(hash + '\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`hash-password: ${err instanceof Error ? err.message : 'Fehler'}\n`);
  process.exit(1);
});
