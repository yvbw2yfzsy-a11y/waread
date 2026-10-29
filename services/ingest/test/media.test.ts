import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import sharp from 'sharp'
import { AudioConvertError, checkFfmpeg, convertToAac, needsConversion } from '../src/media/audio.js'
import { Limiter } from '../src/media/limiter.js'
import { configureSharp, createThumbnail, mimeForFormat } from '../src/media/thumbnail.js'
import { makeTmpDir } from './support/helpers.js'

const haveFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('Limiter', () => {
  it('hoechstens max gleichzeitig, Rest wartet in Reihenfolge', async () => {
    const lim = new Limiter(2)
    let running = 0
    let peak = 0
    const order: number[] = []
    const task = (i: number) =>
      lim.run(async () => {
        order.push(i)
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 15))
        running--
        return i
      })
    const res = await Promise.all([0, 1, 2, 3, 4].map(task))
    assert.deepEqual(res, [0, 1, 2, 3, 4])
    assert.deepEqual(order, [0, 1, 2, 3, 4])
    assert.equal(peak, 2)
    assert.equal(lim.running, 0)
    assert.equal(lim.waiting, 0)
  })

  it('Fehler geben den Platz frei', async () => {
    const lim = new Limiter(1)
    await assert.rejects(lim.run(async () => Promise.reject(new Error('x'))))
    assert.equal(await lim.run(async () => 'ok'), 'ok')
  })

  it('ungueltiges Limit wird abgewiesen', () => {
    for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => new Limiter(bad), RangeError)
  })
})

describe('Vorschaubilder (echtes sharp)', () => {
  let tmp: ReturnType<typeof makeTmpDir>
  beforeEach(() => {
    tmp = makeTmpDir()
    configureSharp()
  })
  afterEach(() => tmp.cleanup())

  const bg = { r: 200, g: 30, b: 30 }
  const p = (n: string) => path.join(tmp.dir, n)

  it('Querformat 1000x500 JPEG -> kurze Seite 200 (400x200), JPEG, Format laut Inhalt', async () => {
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: bg } }).jpeg().toFile(p('a.jpg'))
    const res = await createThumbnail(p('a.jpg'), p('a.thumb.jpg'), 200)
    assert.deepEqual(res, { width: 400, height: 200, format: 'jpeg' })
    const meta = await sharp(p('a.thumb.jpg')).metadata()
    assert.equal(meta.format, 'jpeg')
    assert.equal(Math.min(meta.width!, meta.height!), 200)
    assert.ok(!fs.existsSync(p('a.thumb.jpg.part')))
  })

  it('Hochformat 300x900 -> 200x600', async () => {
    await sharp({ create: { width: 300, height: 900, channels: 3, background: bg } }).png().toFile(p('b.png'))
    const res = await createThumbnail(p('b.png'), p('b.thumb.jpg'), 200)
    assert.equal(res.width, 200)
    assert.equal(res.height, 600)
    assert.equal(res.format, 'png', 'gemeldet wird das Format der QUELLE')
  })

  it('kleines Bild wird nicht vergroessert', async () => {
    await sharp({ create: { width: 100, height: 60, channels: 3, background: bg } }).jpeg().toFile(p('c.jpg'))
    const res = await createThumbnail(p('c.jpg'), p('c.thumb.jpg'), 200)
    assert.deepEqual([res.width, res.height], [100, 60])
  })

  it('EXIF-Ausrichtung wird angewendet, EXIF/GPS-Daten werden nicht uebernommen', async () => {
    await sharp({ create: { width: 800, height: 400, channels: 3, background: bg } })
      .withExif({ IFD0: { Copyright: 'geheim' }, IFD3: { GPSLatitudeRef: 'N' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(p('d.jpg'))
    const res = await createThumbnail(p('d.jpg'), p('d.thumb.jpg'), 200)
    assert.deepEqual([res.width, res.height], [200, 400], 'Orientierung 6 dreht das Querformat ins Hochformat')
    const meta = await sharp(p('d.thumb.jpg')).metadata()
    assert.equal(meta.exif, undefined, 'keine EXIF-Daten im Vorschaubild')
  })

  it('beschaedigte oder unpassende Datei -> Fehler, keine halbe Ausgabe', async () => {
    fs.writeFileSync(p('x.jpg'), 'das ist kein Bild')
    await assert.rejects(createThumbnail(p('x.jpg'), p('x.thumb.jpg'), 200))
    assert.ok(!fs.existsSync(p('x.thumb.jpg')))
    assert.ok(!fs.existsSync(p('x.thumb.jpg.part')))
    await assert.rejects(createThumbnail(p('fehlt.jpg'), p('y.thumb.jpg'), 200))
  })

  it('Dekompressionsbombe (> 50 Megapixel) wird abgelehnt', async () => {
    await sharp({ create: { width: 7200, height: 7200, channels: 3, background: bg } }).png({ compressionLevel: 9 }).toFile(p('bomb.png'))
    assert.ok(fs.statSync(p('bomb.png')).size < 5_000_000, 'Quelle ist klein, Pixelzahl aber gross')
    await assert.rejects(createThumbnail(p('bomb.png'), p('bomb.thumb.jpg'), 200))
    assert.ok(!fs.existsSync(p('bomb.thumb.jpg')))
  })

  it('mimeForFormat', () => {
    assert.equal(mimeForFormat('jpeg'), 'image/jpeg')
    assert.equal(mimeForFormat('webp'), 'image/webp')
    assert.equal(mimeForFormat('heif'), 'image/heic')
    assert.equal(mimeForFormat('svg'), undefined)
    assert.equal(mimeForFormat(undefined), undefined)
  })
})

describe('Sprachumwandlung', () => {
  it('needsConversion', () => {
    assert.equal(needsConversion('audio/ogg; codecs=opus'), true)
    assert.equal(needsConversion('audio/ogg'), true)
    assert.equal(needsConversion(null), true)
    assert.equal(needsConversion('audio/mp4'), false)
    assert.equal(needsConversion('audio/mpeg'), false)
    assert.equal(needsConversion('audio/aac'), false)
  })

  let tmp: ReturnType<typeof makeTmpDir>
  beforeEach(() => {
    tmp = makeTmpDir()
  })
  afterEach(() => tmp.cleanup())
  const p = (n: string) => path.join(tmp.dir, n)

  it('checkFfmpeg: vorhanden / nicht vorhanden', { skip: !haveFfmpeg }, async () => {
    assert.equal(await checkFfmpeg('ffmpeg'), true)
    assert.equal(await checkFfmpeg('/nicht/vorhanden/ffmpeg'), false)
  })

  it('Opus/Ogg -> AAC/MP4 mit echtem ffmpeg; Original bleibt, kein .part', { skip: !haveFfmpeg }, async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', p('in.ogg')])
    await convertToAac(p('in.ogg'), p('out.m4a'), { ffmpegPath: 'ffmpeg', timeoutMs: 30_000 })
    assert.ok(fs.existsSync(p('in.ogg')))
    assert.ok(fs.existsSync(p('out.m4a')))
    assert.ok(!fs.existsSync(p('out.m4a.part')))
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels:format=format_name,duration', '-of', 'json', p('out.m4a')]).toString(),
    )
    assert.equal(probe.streams[0].codec_name, 'aac')
    assert.equal(probe.streams[0].channels, 1)
    assert.match(probe.format.format_name, /mp4/)
    assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.3)
  })

  it('beschaedigte Eingabe -> ffmpeg_failed, keine Ausgabedatei', { skip: !haveFfmpeg }, async () => {
    fs.writeFileSync(p('bad.ogg'), 'kein Audio')
    await assert.rejects(
      convertToAac(p('bad.ogg'), p('bad.m4a'), { ffmpegPath: 'ffmpeg', timeoutMs: 30_000 }),
      (e) => e instanceof AudioConvertError && e.code === 'ffmpeg_failed',
    )
    assert.ok(!fs.existsSync(p('bad.m4a')))
    assert.ok(!fs.existsSync(p('bad.m4a.part')))
  })

  it('ffmpeg fehlt -> ffmpeg_missing', async () => {
    fs.writeFileSync(p('in.ogg'), 'x')
    await assert.rejects(
      convertToAac(p('in.ogg'), p('o.m4a'), { ffmpegPath: '/nicht/vorhanden/ffmpeg', timeoutMs: 5_000 }),
      (e) => e instanceof AudioConvertError && e.code === 'ffmpeg_missing',
    )
  })

  /** Ersatz-ffmpeg: protokolliert Start/Ende und Nice-Wert, legt die Ausgabedatei an. */
  function fakeFfmpeg(sleepSec: string): string {
    const script = p('fake-ffmpeg.sh')
    fs.writeFileSync(
      script,
      `#!/bin/sh
LOG="${p('calls.log')}"
for a; do last="$a"; done
sleep 0.1  # dem Elternprozess Zeit geben, die Prioritaet zu setzen
echo "start $(ps -o ni= -p $$ | tr -d ' ')" >> "$LOG"
sleep ${sleepSec}
echo data > "$last"
echo "end" >> "$LOG"
`,
      { mode: 0o755 },
    )
    return script
  }

  it('Zeitlimit: haengender ffmpeg wird beendet -> ffmpeg_timeout (F18/S11: ohne Limit wird der Test rot, er haengt nicht)', async () => {
    fs.writeFileSync(p('in.ogg'), 'x')
    const hang = p('hang.sh')
    // Ein echter Dauerhaenger (10 Minuten), keine Attrappe, die sich nach 30 s selbst beendet.
    fs.writeFileSync(hang, `#!/bin/sh\necho $$ > "${p('hang.pid')}"\nexec sleep 600\n`, { mode: 0o755 })
    let guardTimer: NodeJS.Timeout | undefined
    const guard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(() => reject(new Error('Test-Wache: ffmpeg wurde nie beendet (Zeitlimit fehlt?)')), 5_000)
    })
    const t0 = Date.now()
    try {
      await Promise.race([
        assert.rejects(
          convertToAac(p('in.ogg'), p('o.m4a'), { ffmpegPath: hang, timeoutMs: 300 }),
          (e) => e instanceof AudioConvertError && e.code === 'ffmpeg_timeout',
        ),
        guard,
      ])
    } finally {
      clearTimeout(guardTimer)
      try {
        process.kill(Number(fs.readFileSync(p('hang.pid'), 'utf8')), 'SIGKILL') // faellt das Limit aus, nicht 10 Minuten liegen lassen
      } catch {
        /* schon beendet */
      }
    }
    assert.ok(Date.now() - t0 < 5_000)
    assert.ok(!fs.existsSync(p('o.m4a')))
  })

  it('niedrige Prioritaet (nice 15) und nie zwei Umwandlungen gleichzeitig', async () => {
    fs.writeFileSync(p('in.ogg'), 'x')
    const ff = fakeFfmpeg('0.15')
    await Promise.all([
      convertToAac(p('in.ogg'), p('o1.m4a'), { ffmpegPath: ff, timeoutMs: 10_000 }),
      convertToAac(p('in.ogg'), p('o2.m4a'), { ffmpegPath: ff, timeoutMs: 10_000 }),
      convertToAac(p('in.ogg'), p('o3.m4a'), { ffmpegPath: ff, timeoutMs: 10_000 }),
    ])
    const lines = fs.readFileSync(p('calls.log'), 'utf8').trim().split('\n')
    assert.deepEqual(
      lines.map((l) => l.split(' ')[0]),
      ['start', 'end', 'start', 'end', 'start', 'end'],
      'strikt nacheinander',
    )
    for (const l of lines.filter((x) => x.startsWith('start'))) {
      assert.equal(Number(l.split(' ')[1]), 15, 'ffmpeg laeuft mit nice 15')
    }
  })
})
