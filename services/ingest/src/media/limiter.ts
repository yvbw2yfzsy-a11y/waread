/** Begrenzt die Zahl gleichzeitig laufender asynchroner Aufgaben (z. B. 1 ffmpeg-Prozess). */
export class Limiter {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('Limiter: max muss eine ganze Zahl >= 1 sein')
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      const next = this.waiters.shift()
      if (next) next() // Platz direkt an den naechsten Wartenden weiterreichen
      else this.active--
    }
  }

  get running(): number {
    return this.active
  }

  get waiting(): number {
    return this.waiters.length
  }
}
