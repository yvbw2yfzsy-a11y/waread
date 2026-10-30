import fs from 'node:fs/promises'
import sharp from 'sharp'
import { Limiter } from './limiter.js'

/**
 * Vorschaubilder mit sharp: kurze Kante ca. 200 px, JPEG.
 *
 * Schutz des Pi:
 *  - hoechstens ein Bild gleichzeitig, sharp selbst mit 1 Thread und kleinem Cache,
 *  - Eingabegroesse auf 50 Megapixel begrenzt (Dekompressionsbomben aus Nachrichten fremder Absender),
 *  - EXIF/GPS-Metadaten werden im Vorschaubild nicht uebernommen (sharp entfernt sie standardmaessig).
 */

export interface ThumbResult {
  width: number
  height: number
  /** Tatsaechliches Bildformat laut Inhalt (jpeg, png, webp, gif, ...), nicht laut Absender-Angabe. */
  format: string | undefined
}

const MAX_INPUT_PIXELS = 50_000_000

const limiter = new Limiter(1)

/** Einmal beim Start aufrufen. */
export function configureSharp(): void {
  sharp.concurrency(1)
  sharp.cache({ memory: 32, files: 0, items: 32 })
}

/** MIME-Typ passend zum von sharp erkannten Format; undefined fuer Unbekanntes. */
export function mimeForFormat(format: string | undefined): string | undefined {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'heif':
      return 'image/heic'
    case 'avif':
      return 'image/avif'
    case 'tiff':
      return 'image/tiff'
    default:
      return undefined
  }
}

/** Erzeugt ein JPEG-Vorschaubild atomar unter `dest` (Schreiben nach `dest.part`, dann umbenennen). */
export function createThumbnail(src: string, dest: string, shortSide: number): Promise<ThumbResult> {
  return limiter.run(async () => {
    const part = `${dest}.part`
    try {
      const image = sharp(src, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false })
      const meta = await image.metadata()
      const info = await image
        .rotate() // EXIF-Ausrichtung anwenden
        .resize({ width: shortSide, height: shortSide, fit: 'outside', withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toFile(part)
      await fs.rename(part, dest)
      return { width: info.width, height: info.height, format: meta.format }
    } catch (err) {
      await fs.rm(part, { force: true })
      throw err
    }
  })
}
