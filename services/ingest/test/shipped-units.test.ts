// Die ausgelieferten systemd-Units (deploy/systemd/*.service) werden hier als Text geprueft.
// Das ist KEIN Beweis, dass systemd die Direktiven auf dem Pi so umsetzt (das ist nicht getestet);
// es verhindert nur, dass die Zusagen unbemerkt aus den Dateien verschwinden.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const unitDir = path.resolve(here, '../../../deploy/systemd')

/** Einfacher INI-Leser: Abschnitt -> Schluessel -> Liste aller Werte (Schluessel duerfen mehrfach vorkommen). */
function parseUnit(name: string): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {}
  let section = ''
  for (const raw of fs.readFileSync(path.join(unitDir, name), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      section = sec[1]!
      out[section] ??= {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0 || section === '') continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    ;((out[section] ??= {})[key] ??= []).push(val)
  }
  return out
}

/** Alle durch Leerzeichen getrennten Eintraege aller Zeilen eines Schluessels. */
const items = (u: Record<string, Record<string, string[]>>, sec: string, key: string): string[] =>
  (u[sec]?.[key] ?? []).flatMap((v) => v.split(/\s+/).filter(Boolean))

const AUTH = '/var/lib/waread/auth'

describe('F11: nur der Ingest-Dienst darf die WhatsApp-Sitzung (auth/) sehen', () => {
  for (const name of ['waread-web.service', 'waread-cleanup.service', 'waread-cleanup-vacuum.service']) {
    it(`${name}: InaccessiblePaths enthaelt ${AUTH} (ohne "-", fehlender Pfad soll laut sein)`, () => {
      const u = parseUnit(name)
      assert.ok(items(u, 'Service', 'InaccessiblePaths').includes(AUTH), `${name}: ${AUTH} fehlt in InaccessiblePaths=`)
    })
  }

  it('waread-ingest.service: auth/ bleibt zugaenglich und beschreibbar (sonst gibt es keine Sitzung)', () => {
    const u = parseUnit('waread-ingest.service')
    const blocked = items(u, 'Service', 'InaccessiblePaths').map((p) => p.replace(/^-/, ''))
    assert.ok(!blocked.some((p) => AUTH === p || AUTH.startsWith(p + '/')), `Ingest darf ${AUTH} nicht sperren`)
    assert.ok(items(u, 'Service', 'ReadWritePaths').includes('/var/lib/waread'))
  })

  it('Web und Cleanup lesen auth/ in der Tat nicht: kein Quelltext dort verweist auf auth_dir', () => {
    // Belegt, dass die Sperre den Betrieb nicht stoeren kann (statische Suche, kein Laufzeitbeweis).
    const roots = [path.resolve(here, '../../web/src'), path.resolve(here, '../../../cleanup')]
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== 'dist') walk(p)
        } else if (e.name.endsWith('.ts')) {
          const text = fs.readFileSync(p, 'utf8')
          if (/auth_dir|authDir/.test(text)) hits.push(p)
        }
      }
    }
    roots.forEach(walk)
    assert.deepEqual(hits, [])
  })
})

describe('F20: Ingest startet nicht vor der Uhr-Synchronisation', () => {
  it('waread-ingest.service: After= und Wants= nennen time-sync.target (zusaetzlich zu network-online.target)', () => {
    const u = parseUnit('waread-ingest.service')
    const after = items(u, 'Unit', 'After')
    const wants = items(u, 'Unit', 'Wants')
    assert.ok(after.includes('time-sync.target'), 'After=time-sync.target fehlt')
    assert.ok(wants.includes('time-sync.target'), 'Wants=time-sync.target fehlt')
    assert.ok(after.includes('network-online.target') && wants.includes('network-online.target'))
  })
})
