/**
 * Splits a chunked stdout stream into JSON records. Chunks can end mid-line,
 * and Windows shims may emit CRLF, so we buffer until we see a full line.
 */
export class JsonlSplitter {
  private buf = ''

  constructor(
    private onRecord: (rec: any) => void,
    private onBadLine: (line: string) => void = () => {}
  ) {}

  push(chunk: string | Buffer): void {
    this.buf += chunk.toString()
    let nl: number
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '').trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.parse(line)
    }
  }

  /** Flush a trailing record without a newline (e.g. at process exit). */
  end(): void {
    const line = this.buf.trim()
    this.buf = ''
    if (line) this.parse(line)
  }

  private parse(line: string) {
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      this.onBadLine(line)
      return
    }
    this.onRecord(rec)
  }
}
