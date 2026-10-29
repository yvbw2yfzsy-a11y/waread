import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import { Limiter } from './limiter.js'

/**
 * Sprachnachrichten: WhatsApp liefert Opus in Ogg. Safari spielt das erst ab iOS 18.4 und nur
 * eingeschraenkt ab -> einmalige Umwandlung nach AAC (MP4-Container, .m4a) beim Eingang.
 *
 * ffmpeg laeuft als externer Prozess mit niedriger CPU-Prioritaet (nice 15), hoechstens eine
 * Umwandlung gleichzeitig, mit hartem Zeitlimit. (I/O-Prioritaet "idle" setzt die systemd-Einheit:
 * IOSchedulingClass=idle.)
 */

export class AudioConvertError extends Error {
  readonly code: 'ffmpeg_missing' | 'ffmpeg_failed' | 'ffmpeg_timeout'
  constructor(code: AudioConvertError['code']) {
    super(code)
    this.name = 'AudioConvertError'
    this.code = code
  }
}

export interface ConvertOptions {
  ffmpegPath: string
  timeoutMs: number
  /** Nice-Wert fuer den Kindprozess (Standard 15). */
  niceness?: number
  /** AAC-Bitrate (Standard 48k; fuer Sprache ausreichend). */
  bitrate?: string
}

/** Muss diese Datei umgewandelt werden? Ogg/Opus und Unbekanntes ja; MP4/AAC/MP3 nein. */
export function needsConversion(mime: string | null | undefined): boolean {
  if (!mime) return true
  const m = mime.toLowerCase()
  return m.includes('ogg') || m.includes('opus')
}

const limiter = new Limiter(1)

/** Prueft einmalig beim Start, ob ffmpeg aufrufbar ist. */
export function checkFfmpeg(ffmpegPath: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    try {
      const child = spawn(ffmpegPath, ['-hide_banner', '-version'], { stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done(false)
      }, timeoutMs)
      child.once('error', () => {
        clearTimeout(timer)
        done(false)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        done(code === 0)
      })
    } catch {
      done(false)
    }
  })
}

/**
 * Wandelt `src` nach AAC/MP4 um und legt das Ergebnis atomar unter `dest` ab
 * (Schreiben nach `dest.part`, dann umbenennen). Das Original bleibt unberuehrt.
 */
export function convertToAac(src: string, dest: string, opts: ConvertOptions): Promise<void> {
  return limiter.run(async () => {
    const part = `${dest}.part`
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', src,
      '-vn',
      '-map_metadata', '-1',
      '-c:a', 'aac',
      '-b:a', opts.bitrate ?? '48k',
      '-ac', '1',
      '-movflags', '+faststart',
      '-f', 'mp4',
      part,
    ]
    try {
      await runFfmpeg(opts.ffmpegPath, args, opts.timeoutMs, opts.niceness ?? 15)
      await fs.rename(part, dest)
    } catch (err) {
      await fs.rm(part, { force: true })
      throw err
    }
  })
}

function runFfmpeg(bin: string, args: string[], timeoutMs: number, niceness: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      reject(new AudioConvertError('ffmpeg_missing'))
      return
    }
    try {
      if (child.pid) os.setPriority(child.pid, niceness)
    } catch {
      /* Prioritaet nicht setzbar (z. B. fremdes System) - Umwandlung laeuft trotzdem */
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new AudioConvertError(err.code === 'ENOENT' ? 'ffmpeg_missing' : 'ffmpeg_failed'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new AudioConvertError('ffmpeg_timeout'))
      else if (code === 0) resolve()
      else reject(new AudioConvertError('ffmpeg_failed'))
    })
  })
}
