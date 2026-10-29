// Die ausgelieferte config.example.toml wird von install.sh als echte /etc/waread/config.toml angelegt
// (deploy/install.sh). Ihre Werte zaehlen deshalb mehr als die Code-Standardwerte. Diese Tests lesen
// die Datei so, wie sie ausgeliefert wird.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultConfig, loadConfig } from '../src/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const exampleText = fs.readFileSync(path.resolve(here, '../../../config/config.example.toml'), 'utf8')
const fromExample = () => loadConfig({ env: {}, loadText: () => exampleText })

describe('Standardwerte der Verbindung (Sperrgefahr: Auftrag C)', () => {
  it('F03: ohne gespeicherte Kopplung beginnt der Dienst NICHT von selbst eine QR-Sitzung (Code-Standard)', () => {
    assert.equal(defaultConfig().connection.autoPairOnStart, false)
  })

  it('F03: auch die ausgelieferte Beispielkonfiguration setzt auto_pair_on_start nicht auf true', () => {
    assert.equal(fromExample().connection.autoPairOnStart, false)
  })

  it('F05: Backoff wird erst nach 10 Minuten stabiler Verbindung zurueckgesetzt (Code-Standard)', () => {
    assert.equal(defaultConfig().connection.stableAfterMs, 600_000)
  })

  it('F05: auch die ausgelieferte Beispielkonfiguration setzt stable_after_seconds nicht niedriger', () => {
    assert.equal(fromExample().connection.stableAfterMs, 600_000)
  })

  it('Beispielkonfiguration ist ladbar und entspricht bei der Verbindung den Code-Standardwerten', () => {
    assert.deepEqual(fromExample().connection, defaultConfig().connection)
  })
})

describe('F07: Knotenzaehler ist ab Werk aus', () => {
  it('Code-Standard und ausgelieferte Beispielkonfiguration: count_outgoing_nodes = false', () => {
    assert.equal(defaultConfig().diagnostics.countOutgoingNodes, false)
    assert.equal(fromExample().diagnostics.countOutgoingNodes, false)
    assert.match(exampleText, /^#?\s*count_outgoing_nodes\s*=\s*false/m)
  })

  it('count_outgoing_nodes = true schaltet ihn ein', () => {
    const cfg = loadConfig({ env: {}, loadText: () => '[ingest]\ncount_outgoing_nodes = true\n' })
    assert.equal(cfg.diagnostics.countOutgoingNodes, true)
  })
})
