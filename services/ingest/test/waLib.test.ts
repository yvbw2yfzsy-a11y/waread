import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLibLogger, loadWaLib, type ModuleImporter } from '../src/waLib.js'
import { NodeCounter } from '../src/nodeCounter.js'
import { memoryLogger } from './support/helpers.js'

function fakeModule() {
  const sockets: any[] = []
  const configs: any[] = []
  const downloads: any[] = []
  const raw = {
    ev: { on: (e: string, h: unknown) => sockets.push(['on', e, h]), off: (e: string, h: unknown) => sockets.push(['off', e, h]) },
    end: (err?: Error) => sockets.push(['end', err]),
    // Alles, was die Huelle NICHT durchreichen darf:
    sendMessage: () => sockets.push(['sendMessage']),
    readMessages: () => sockets.push(['readMessages']),
    sendPresenceUpdate: () => sockets.push(['sendPresenceUpdate']),
    logout: () => sockets.push(['logout']),
    ws: {},
  }
  const mod = {
    makeWASocket: (cfg: any) => (configs.push(cfg), raw),
    initAuthCreds: () => ({ fresh: true }),
    BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v },
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o: unknown) => ({ revived: o }) } } },
    makeCacheableSignalKeyStore: (keys: unknown) => ({ cached: keys }),
    downloadContentFromMessage: (target: unknown, type: string) => (downloads.push([target, type]), 'STREAM'),
    Browsers: { ubuntu: (n: string) => ['Ubuntu', n, '22.04'] },
  }
  return { mod, sockets, configs, downloads, raw }
}

const importerFor = (mod: unknown, only?: string): ModuleImporter => async (spec) => {
  if (only && spec !== only) {
    throw Object.assign(new Error(`Cannot find package '${spec}' imported from /x`), { code: 'ERR_MODULE_NOT_FOUND' })
  }
  return mod
}

describe('waLib (Huelle um die Bibliothek, mit Fake-Modul)', () => {
  it('createSocket: bekannte Konfiguration, kein Online-Status, kein Voll-Verlauf, nichts zum erneuten Senden', async () => {
    const f = fakeModule()
    const { log } = memoryLogger()
    const lib = await loadWaLib(log, importerFor(f.mod))
    const auth = { creds: { c: 1 }, keys: { get: () => ({}), set: () => {} } }
    lib.createSocket({ auth })
    const cfg = f.configs[0]
    assert.equal(cfg.markOnlineOnConnect, false)
    assert.equal(cfg.syncFullHistory, false)
    assert.equal(cfg.generateHighQualityLinkPreview, false)
    assert.equal(await cfg.getMessage(), undefined)
    assert.deepEqual(cfg.browser, ['Ubuntu', 'Chrome', '22.04'])
    assert.equal(cfg.auth.creds, auth.creds)
    assert.deepEqual(cfg.auth.keys, { cached: auth.keys })
  })

  it('die Huelle reicht NUR ev.on, ev.off und end durch', async () => {
    const f = fakeModule()
    const { log } = memoryLogger()
    const lib = await loadWaLib(log, importerFor(f.mod))
    const sock: any = lib.createSocket({ auth: { creds: {}, keys: { get: () => ({}), set: () => {} } } })
    assert.deepEqual(Object.keys(sock).sort(), ['end', 'ev'])
    assert.deepEqual(Object.keys(sock.ev).sort(), ['off', 'on'])
    for (const forbidden of ['sendMessage', 'readMessages', 'sendPresenceUpdate', 'logout', 'ws', 'query', 'chatModify']) {
      assert.equal(sock[forbidden], undefined, forbidden)
    }
    const h = () => {}
    sock.ev.on('messages.upsert', h)
    sock.ev.off('messages.upsert', h)
    const err = new Error('x')
    sock.end(err)
    assert.deepEqual(f.sockets, [['on', 'messages.upsert', h], ['off', 'messages.upsert', h], ['end', err]])
  })

  it('downloadMedia: Schluessel/Pfad/Typ gehen an downloadContentFromMessage, sonst nichts', async () => {
    const f = fakeModule()
    const { log } = memoryLogger()
    const lib = await loadWaLib(log, importerFor(f.mod))
    const key = new Uint8Array([1, 2])
    assert.equal(await lib.downloadMedia({ mediaKey: key, directPath: '/d', url: null, hkdfType: 'image' }), 'STREAM')
    assert.deepEqual(f.downloads, [[{ mediaKey: key, directPath: '/d', url: undefined }, 'image']])
  })

  describe('F01: Ziel des Medien-Downloads (Absender kontrolliert url/directPath)', () => {
    const key = new Uint8Array([1, 2])
    const target = (directPath: string | null, url: string | null) => ({ mediaKey: key, directPath, url, hkdfType: 'image' })
    const OK_PATH = '/v/t62.7117-24/12345_n.enc?ccb=11-4&oh=01_abc&oe=6720ABCD&_nc_sid=5e03e0'

    const BAD: Array<[string, string | null, string | null]> = [
      ['directPath mit Userinfo-Trick (@evil.example)', '@evil.example/x', null],
      ['directPath ohne fuehrenden Schraegstrich', 'v/t62/abc', null],
      ['directPath mit Backslash', '/a\\b', null],
      ['directPath mit @', '/a@evil.example', null],
      ['directPath mit Leerzeichen', '/a b', null],
      ['directPath mit Zeilenumbruch', '/a\nb', null],
      ['url fremder Host + directPath (Baileys nimmt den Host aus url)', '/v/t62/abc', 'https://evil.example/anything'],
      ['url nur http', null, 'http://mmg.whatsapp.net/v/x'],
      ['url mit IPv4 (Heimnetz)', null, 'https://192.168.1.10/x'],
      ['url mit Loopback', null, 'https://127.0.0.1/x'],
      ['url mit IPv6', null, 'https://[::1]/x'],
      ['url mit Userinfo vor fremdem Host', null, 'https://mmg.whatsapp.net@evil.example/x'],
      ['url mit Userinfo und Passwort bei WhatsApp-Host', null, 'https://user:pw@mmg.whatsapp.net/x'],
      ['url: whatsapp.net nur als Teil des Pfads', null, 'https://evil.example/mmg.whatsapp.net'],
      ['url: Host nur als Vorsilbe (mmg.whatsapp.net.evil.example)', null, 'https://mmg.whatsapp.net.evil.example/x'],
      ['url: Host ohne Punkt davor (evilwhatsapp.net)', null, 'https://evilwhatsapp.net/x'],
      ['url: nackte Domain whatsapp.net', null, 'https://whatsapp.net/x'],
      ['url mit Port', null, 'https://mmg.whatsapp.net:8443/x'],
      ['url mit Backslash-Trick (evil.example\\@mmg.whatsapp.net)', null, 'https://evil.example\\@mmg.whatsapp.net/x'],
      ['url mit file:-Schema', null, 'file:///etc/passwd'],
      ['url nicht parsebar', null, 'kein-url'],
    ]
    for (const [name, directPath, url] of BAD) {
      it(`abgewiesen, Bibliothek wird NICHT aufgerufen: ${name}`, async () => {
        const f = fakeModule()
        const { log } = memoryLogger()
        const lib = await loadWaLib(log, importerFor(f.mod))
        await assert.rejects(
          async () => lib.downloadMedia(target(directPath, url)),
          (e: any) => e?.name === 'DownloadTargetError' && e?.code === 'bad_target',
        )
        assert.deepEqual(f.downloads, [])
      })
    }

    const GOOD: Array<[string, string | null, string | null]> = [
      ['nur directPath (Normalfall, Standardhost der Bibliothek)', OK_PATH, null],
      ['url bei WhatsApp-Host + directPath', OK_PATH, 'https://mmg.whatsapp.net/v/t62.7117-24/x.enc?ccb=11-4'],
      ['nur url bei CDN-Host unter whatsapp.net', null, 'https://media-fra5-1.cdn.whatsapp.net/v/t62.7117-24/x.enc?ccb=11-4'],
      ['Gross-/Kleinschreibung des Hosts', null, 'https://MMG.WhatsApp.NET/v/x'],
    ]
    for (const [name, directPath, url] of GOOD) {
      it(`erlaubt, geht an die Bibliothek: ${name}`, async () => {
        const f = fakeModule()
        const { log } = memoryLogger()
        const lib = await loadWaLib(log, importerFor(f.mod))
        assert.equal(await lib.downloadMedia(target(directPath, url)), 'STREAM')
        assert.equal(f.downloads.length, 1)
      })
    }
  })

  it('Auth-Hilfen kommen aus der Bibliothek', async () => {
    const f = fakeModule()
    const { log } = memoryLogger()
    const lib = await loadWaLib(log, importerFor(f.mod))
    assert.deepEqual(lib.initAuthCreds(), { fresh: true })
    assert.deepEqual(lib.reviveAppStateSyncKey({ a: 1 }), { revived: { a: 1 } })
  })

  it('Exporte auch ueber "default" gefunden', async () => {
    const f = fakeModule()
    const { log } = memoryLogger()
    const lib = await loadWaLib(log, async () => ({ default: f.mod }))
    assert.ok(lib.createSocket)
  })

  it('fehlende Exporte -> klarer Startfehler mit Namen (statt spaeterem Fehlverhalten)', async () => {
    const f = fakeModule()
    const { makeCacheableSignalKeyStore: _a, Browsers: _b, ...rest } = f.mod
    const { log } = memoryLogger()
    await assert.rejects(loadWaLib(log, importerFor(rest)), /makeCacheableSignalKeyStore, Browsers/)
  })

  it('Paketname: erster Name fehlt -> zweiter wird versucht; beide fehlen -> Fehler', async () => {
    const f = fakeModule()
    const { log } = memoryLogger()
    const tried: string[] = []
    const second: ModuleImporter = async (spec) => {
      tried.push(spec)
      return importerFor(f.mod, '@whiskeysockets/baileys')(spec)
    }
    await loadWaLib(log, second)
    assert.deepEqual(tried, ['baileys', '@whiskeysockets/baileys'])
    await assert.rejects(loadWaLib(log, importerFor(f.mod, 'weder-noch')), /Cannot find package/)
  })

  it('fehlt eine ABHAENGIGKEIT des Pakets, wird nicht mit dem anderen Namen weitergeraten', async () => {
    const { log } = memoryLogger()
    const tried: string[] = []
    const broken: ModuleImporter = async (spec) => {
      tried.push(spec)
      throw Object.assign(new Error(`Cannot find package 'libsignal' imported from /x/${spec}`), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    await assert.rejects(loadWaLib(log, broken), /libsignal/)
    assert.deepEqual(tried, ['baileys'])
  })

  it('Bibliotheks-Logger verwirft Objekte (Nummern, Namen, Knoten) und gibt nur kurzen statischen Text weiter', () => {
    const { log, lines } = memoryLogger()
    const l = createLibLogger(log)
    l.trace({ xml: '<message to="491701234567@s.whatsapp.net"/>' }, 'xml send')
    l.debug({ a: 1 }, 'x')
    l.info({ a: 1 }, 'x')
    l.warn({ jid: '491701234567@s.whatsapp.net', body: 'Geheimtext-4711' }, 'connection problem')
    l.error({ err: new Error('Geheimtext-4711') })
    l.child({ module: 'x' }).warn('nur Text')
    const out = lines.join('\n')
    assert.ok(!out.includes('491701234567') && !out.includes('Geheimtext') && !out.includes('xml send'))
    assert.ok(out.includes('connection problem'))
    assert.equal(lines.length, 3)
  })

  describe('F07: Zaehler ausgehender Knoten (nur mit ausdruecklich uebergebenem Zaehler)', () => {
    const SENT = { xml: `<receipt id='3EB0AA' to='491701234567@s.whatsapp.net' type='inactive'/>`, msg: 'xml send' }
    const RECV = { xml: `<message id='3EB0BB' from='491701234567@s.whatsapp.net' type='text'/>`, msg: 'recv xml' }

    it('ohne Zaehler bleibt alles wie bisher: Stufe warn, trace wird verworfen', () => {
      const { log, lines } = memoryLogger()
      const l = createLibLogger(log)
      assert.equal(l.level, 'warn')
      l.trace(SENT)
      assert.deepEqual(lines, [])
    })

    it('mit Zaehler: Stufe trace (Bedingung der Bibliothek), gezaehlt wird nur "xml send", empfangene Knoten nicht', () => {
      const { log, lines } = memoryLogger()
      const counter = new NodeCounter()
      const l = createLibLogger(log, counter)
      assert.equal(l.level, 'trace')
      l.trace(SENT)
      l.trace(SENT)
      l.trace(RECV)
      l.trace({ xml: 'x', msg: 'etwas anderes' })
      l.trace('nur Text')
      l.debug(SENT)
      assert.deepEqual(counter.snapshot(), { 'receipt:inactive': 2 })
      assert.deepEqual(lines, [], 'der Zaehler schreibt keine Logzeilen und leitet nichts weiter')
    })

    it('mit Zaehler werden Warnungen weiterhin nur als kurzer statischer Text weitergegeben', () => {
      const { log, lines } = memoryLogger()
      const l = createLibLogger(log, new NodeCounter())
      l.warn({ jid: '491701234567@s.whatsapp.net', body: 'Geheimtext-4711' }, 'connection problem')
      const out = lines.join('\n')
      assert.ok(out.includes('connection problem') && !out.includes('4917') && !out.includes('Geheimtext'))
    })

    it('loadWaLib reicht den Zaehler an den Socket weiter: die Bibliothek bekommt den trace-faehigen Logger', async () => {
      const f = fakeModule()
      const { log } = memoryLogger()
      const counter = new NodeCounter()
      const lib = await loadWaLib(log, importerFor(f.mod), counter)
      lib.createSocket({ auth: { creds: {}, keys: { get: () => ({}), set: () => {} } } })
      const given = f.configs[0].logger
      assert.equal(given.level, 'trace')
      given.trace(SENT)
      assert.deepEqual(counter.snapshot(), { 'receipt:inactive': 1 })
    })

    it('loadWaLib ohne Zaehler gibt der Bibliothek weiterhin die Stufe warn', async () => {
      const f = fakeModule()
      const { log } = memoryLogger()
      const lib = await loadWaLib(log, importerFor(f.mod))
      lib.createSocket({ auth: { creds: {}, keys: { get: () => ({}), set: () => {} } } })
      assert.equal(f.configs[0].logger.level, 'warn')
    })
  })
})
