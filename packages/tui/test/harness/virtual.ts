// M37a G4 (adapted from packages/tui-core/test/harness/virtual.ts — M36 G3):
// @xterm/headless wrap — the REAL VT stream parser for the harness.
// DOM-free: no renderer is attached; only the parser + buffer are exercised.
// Semantics verified empirically on 6.0.0: a wide grapheme occupies a head
// cell (getWidth()===2) and a continuation cell (getWidth()===0, getChars()==="");
// translateToString(true) emits the head once and trims trailing blanks.

import type {
  IBufferCell,
  IBufferLine,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as XTerminal,
} from "@xterm/headless"

// Runtime interop: @xterm/headless is CJS (webpack UMD) — under vitest the
// default import is module.exports; a namespace import may add a default
// wrapper on some runners. Resolve the ctor pre-emptively for both shapes.
// Double-cast is deliberate: the ambient d.ts declares named exports only
// (no default), so typing goes through `any` once and stays honest after.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XtermImpl = (await import("@xterm/headless")) as any

const maybeCtor = (XtermImpl.Terminal ?? XtermImpl.default?.Terminal) as
  | (new (o: ITerminalOptions & ITerminalInitOnlyOptions) => XTerminal)
  | undefined

if (maybeCtor === undefined) {
  throw new Error(
    "@xterm/headless: Terminal constructor not found on module object; " +
      `keys=${Object.keys(XtermImpl).join(",")}`,
  )
}
const TerminalCtor = maybeCtor

export interface VirtualCell {
  text: string
  width: number
}

export interface VirtualRow {
  text: string
  cells: VirtualCell[]
}

export class VirtualTerminal {
  private readonly term: XTerminal

  constructor(cols: number, rows: number) {
    this.term = new TerminalCtor({ cols, rows, allowProposedApi: true, scrollback: 1000 })
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  /** Feeds pty bytes into the parser; processing is sequential and awaited by
   * xterm itself (write(data, cb) — the buffer only reflects data after cb). */
  write(data: string | Uint8Array): void {
    // Keep the write queue unobserved: xterm 6 processes writes sequentially
    // via its internal WriteBuffer; `drained()` below gates every assertion.
    void this.term.write(data)
  }

  /** Resolves once every written chunk has been parsed into the buffer. */
  async drained(): Promise<void> {
    await this.term.write("", () => {})
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  private line(y: number): IBufferLine | undefined {
    return this.term.buffer.active.getLine(y)
  }

  /** Per-row text (translateToString(trimRight=true)) of the ACTIVE buffer
   * (alt screen once the child sent ESC[?1049h). */
  rowText(y: number): string {
    const line = this.line(y)
    return line === undefined ? "" : line.translateToString(true)
  }

  /** Per-head column widths via the buffer's own width table: 0 = continuation
   * half of a width-2 grapheme. */
  cellWidths(y: number): number[] {
    const line = this.line(y)
    const widths: number[] = []
    for (let x = 0; x < this.cols; x++) {
      const cell = line === undefined ? undefined : line.getCell(x)
      widths.push(cell === undefined ? 1 : cell.getWidth())
    }
    return widths
  }

  getRow(y: number): VirtualRow {
    const line = this.line(y)
    const widths = this.cellWidths(y)
    const cells: VirtualCell[] = []
    for (let x = 0; x < this.cols; x++) {
      const cell: IBufferCell | undefined =
        line === undefined ? undefined : (line.getCell(x) as IBufferCell | undefined)
      cells.push({ text: cell === undefined ? "" : cell.getChars(), width: widths[x] })
    }
    return { text: this.rowText(y), cells }
  }

  bufferRows(): string[] {
    const rows: string[] = []
    for (let y = 0; y < this.rows; y++) rows.push(this.rowText(y))
    return rows
  }
}
