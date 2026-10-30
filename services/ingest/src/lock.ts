import fs from 'node:fs'

/**
 * Exklusive Sperre ueber eine Lockdatei mit PID-Fingerabdruck.
 *
 * Zweck: Nie zwei Prozesse mit denselben WhatsApp-Sitzungsdateien (Abmeldungen drohen).
 * Eine alte Sperre gilt als verwaist, wenn
 *   - der Prozess nicht mehr existiert, oder
 *   - der Boot-Zeitpunkt ein anderer ist (PIDs werden nach einem Neustart wiederverwendet), oder
 *   - die Prozess-Startzeit nicht zur gespeicherten passt (PID-Wiederverwendung im laufenden Betrieb).
 * Auf Systemen ohne /proc faellt der Fingerabdruck weg; dann entscheidet nur "Prozess existiert".
 *
 * Grenze (ehrlich): Zwei Prozesse, die im selben Millisekunden-Fenster eine VERWAISTE Sperre
 * uebernehmen wollen, werden per rename-und-pruefen abgefangen, aber nicht mathematisch bewiesen.
 * Im Betrieb startet systemd ohnehin nur eine Instanz.
 */

export interface Fingerprint {
  bootId: string | null
  startTicks: string | null
}

interface LockRecord extends Fingerprint {
  pid: number
  startedAt: number
}

export class LockHeldError extends Error {
  readonly pid: number
  constructor(pid: number) {
    super(`Sperre wird von Prozess ${pid} gehalten`)
    this.name = 'LockHeldError'
    this.pid = pid
  }
}

export interface LockSystem {
  pid: number
  isAlive(pid: number): boolean
  fingerprint(pid: number): Fingerprint
  now(): number
}

export function defaultLockSystem(): LockSystem {
  return {
    pid: process.pid,
    isAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        // EPERM: Prozess existiert, gehoert aber einem anderen Benutzer.
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    fingerprint(pid) {
      let bootId: string | null = null
      let startTicks: string | null = null
      try {
        bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      } catch {
        /* kein /proc */
      }
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        // Feld 2 (comm) kann Leerzeichen/Klammern enthalten -> ab der letzten ")" parsen.
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        startTicks = rest[19] ?? null // Feld 22 (starttime); rest beginnt bei Feld 3
      } catch {
        /* kein /proc oder Prozess weg */
      }
      return { bootId, startTicks }
    },
    now: () => Date.now(),
  }
}

export interface LockHandle {
  readonly path: string
  release(): void
}

function parseRecord(text: string): LockRecord | null {
  try {
    const v = JSON.parse(text) as Partial<LockRecord>
    if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return null
    return {
      pid: v.pid,
      bootId: typeof v.bootId === 'string' ? v.bootId : null,
      startTicks: typeof v.startTicks === 'string' ? v.startTicks : null,
      startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
    }
  } catch {
    return null
  }
}

function isStale(rec: LockRecord, sys: LockSystem): boolean {
  if (!sys.isAlive(rec.pid)) return true
  const fp = sys.fingerprint(rec.pid)
  if (rec.bootId !== null && fp.bootId !== null && rec.bootId !== fp.bootId) return true
  if (rec.startTicks !== null && fp.startTicks !== null && rec.startTicks !== fp.startTicks) return true
  return false
}

/** Dauer, die eine leere/kaputte Lockdatei als "gerade im Entstehen" gilt. */
const FRESH_GRACE_MS = 10_000

export function acquireLock(lockPath: string, sys: LockSystem = defaultLockSystem()): LockHandle {
  const me: LockRecord = { pid: sys.pid, ...sys.fingerprint(sys.pid), startedAt: sys.now() }
  const body = JSON.stringify(me)

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try {
        fs.writeSync(fd, body)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      return makeHandle(lockPath, me)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    // Sperre existiert: lebt der Halter noch?
    let text: string
    let mtimeMs: number
    try {
      text = fs.readFileSync(lockPath, 'utf8')
      mtimeMs = fs.statSync(lockPath).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // zwischenzeitlich freigegeben
      throw err
    }

    const rec = parseRecord(text)
    if (rec === null) {
      // Leer/kaputt: nur uebernehmen, wenn nicht gerade erst angelegt.
      if (sys.now() - mtimeMs < FRESH_GRACE_MS) throw new LockHeldError(0)
    } else if (!isStale(rec, sys)) {
      throw new LockHeldError(rec.pid)
    }

    // Verwaist: atomar wegbewegen und pruefen, dass wir wirklich die beobachtete Sperre erwischt haben.
    const tomb = `${lockPath}.stale.${sys.pid}`
    try {
      fs.renameSync(lockPath, tomb)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    const moved = fs.readFileSync(tomb, 'utf8')
    fs.unlinkSync(tomb)
    if (moved !== text) {
      // Wir haben versehentlich die frische Sperre eines Dritten bewegt -> aufgeben statt kaempfen.
      const other = parseRecord(moved)
      throw new LockHeldError(other?.pid ?? 0)
    }
  }
  throw new LockHeldError(0)
}

function makeHandle(lockPath: string, me: LockRecord): LockHandle {
  let released = false
  return {
    path: lockPath,
    release() {
      if (released) return
      released = true
      try {
        const rec = parseRecord(fs.readFileSync(lockPath, 'utf8'))
        // Nur loeschen, wenn die Sperre noch unsere ist.
        if (rec && rec.pid === me.pid && rec.startedAt === me.startedAt) fs.unlinkSync(lockPath)
      } catch {
        /* schon weg */
      }
    },
  }
}
