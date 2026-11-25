import type { ExecFrameCursor, ManagedArtifactRef } from '@i-harness/core-session'
import { createExecFramePageValidator } from '@i-harness/context-output'
import type { AgentProcessReadContext } from './agent-process-read.ts'

const PAGE_BYTES = 32768
const PREVIEW_BYTES = 131072
const PREVIEW_PAGES = 32

const invalidPage = () => ({ kind: 'unavailable' as const, reason: 'invalid-page' })
type Validator = ReturnType<typeof createExecFramePageValidator>

function validatorFor(ref: ManagedArtifactRef, cursor?: ExecFrameCursor): Validator | undefined {
  try { return createExecFramePageValidator(ref, cursor) } catch { return undefined }
}

async function readPage(context: AgentProcessReadContext, validator: Validator, ref: ManagedArtifactRef, cursor?: ExecFrameCursor, viaCatalog?: ManagedArtifactRef) {
  const page = await context.page({ ref, cursor, maxBytes: PAGE_BYTES, ...(viaCatalog ? { viaCatalog } : {}) })
  if (page && typeof page === 'object' && 'kind' in page) return page.kind === 'unavailable' ? page : invalidPage()
  try { return validator.validate(page) } catch { return invalidPage() }
}

/** The caller holds the selected process evidence. Every page still goes
 * through the original Process observation and authenticated result reader. */
export async function readSavedProcessFrame(context: AgentProcessReadContext, ref: ManagedArtifactRef, cursor?: ExecFrameCursor, viaCatalog?: ManagedArtifactRef) {
  const validator = validatorFor(ref, cursor)
  return validator ? readPage(context, validator, ref, cursor, viaCatalog) : invalidPage()
}

export async function readSavedProcessPreview(context: AgentProcessReadContext, ref: ManagedArtifactRef) {
  const validator = validatorFor(ref)
  if (!validator) return invalidPage()
  const decoder = { stdout: new TextDecoder('utf-8', { ignoreBOM: true }), stderr: new TextDecoder('utf-8', { ignoreBOM: true }) }
  const text = { stdout: '', stderr: '' }
  let cursor: ExecFrameCursor | undefined, admitted = 0, eof = false
  pages: for (let count = 0; count < PREVIEW_PAGES; count++) {
    const page = await readPage(context, validator, ref, cursor)
    if ('kind' in page) return page
    for (const part of page.frames) {
      const bytes = Buffer.from(part.data, 'base64')
      const limit = Math.min(bytes.length, PREVIEW_BYTES - admitted)
      text[part.channel] += decoder[part.channel].decode(bytes.subarray(0, limit), { stream: true })
      admitted += limit
      if (limit < bytes.length) break pages
    }
    if (page.eof) { eof = true; break }
    if (admitted === PREVIEW_BYTES) break
    cursor = validator.cursor
  }
  const truncated = !eof || ref.completeness !== 'complete'
  if (!truncated) {
    text.stdout += decoder.stdout.decode()
    text.stderr += decoder.stderr.decode()
  }
  return { text: text.stdout + text.stderr, truncated }
}
