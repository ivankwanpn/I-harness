export type CommitFormatCode = 'version' | 'digest' | 'shape' | 'ops' | 'chain' | 'corrupt'

/** A commit log record or chain failed a structural check. */
export class CommitFormatError extends Error {
  readonly code: CommitFormatCode
  constructor(code: CommitFormatCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CommitFormatError'
    this.code = code
  }
}
