import { mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicJson, boundedJson, ownedPath } from './io.ts'
import { sha } from './manifest.ts'

export interface ArtifactPin { version: 1; documentId: string; sessionId: string; state: 'pending' | 'committed'; operationId: string; revision: string }
type Pin = ArtifactPin
interface Access { version: 1; sessionId: string; revision: string; pinId: string }
export async function publishPin(directory: string, pin: Pin): Promise<void> {
  await mkdir(resolve(directory, 'pins'), { recursive: true }); await mkdir(resolve(directory, 'access'), { recursive: true })
  const pinId = sha(pin.documentId)
  await atomicJson(resolve(directory, 'pins', `${pinId}.json`), pin)
  const access: Access = { version: 1, sessionId: pin.sessionId, revision: pin.revision, pinId }
  await atomicJson(resolve(directory, 'access', `${sha(pin.sessionId)}.json`), access)
}
/** One bounded ACL pointer plus its real document pin, never an owner array. */
export async function readPin(root: string, directory: string, sessionId: string, revision: string): Promise<Pin | undefined> {
  try {
    const accessPath = resolve(directory, 'access', `${sha(sessionId)}.json`)
    await ownedPath(root, accessPath)
    const access = await boundedJson(accessPath) as Access
    if (access.version !== 1 || access.sessionId !== sessionId || access.revision !== revision || !/^[a-f0-9]{64}$/.test(access.pinId)) return undefined
    const pinPath = resolve(directory, 'pins', `${access.pinId}.json`)
    await ownedPath(root, pinPath)
    const pin = await boundedJson(pinPath) as Pin
    return pin.version === 1 && pin.sessionId === sessionId && pin.revision === revision && sha(pin.documentId) === access.pinId ? pin : undefined
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause }
}
export async function releaseDocumentPin(root: string, directory: string, documentId: string): Promise<boolean> {
  const pinPath = resolve(directory, 'pins', `${sha(documentId)}.json`)
  let pin: Pin | undefined
  try { await ownedPath(root, pinPath); pin = await boundedJson(pinPath) as Pin }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
  if (pin && pin.documentId !== documentId) throw new Error('Artifact pin identity conflict')
  if (pin) await rm(pinPath)
  // A retry after pin deletion still owns cleanup of this exact document's
  // companions. They confer no independent body retention.
  const companions = resolve(directory, 'pin-memberships', sha(documentId))
  try { await ownedPath(root, companions); await rm(companions, { recursive: true, force: true }) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
  const remaining = await readdir(resolve(directory, 'pins')).catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return []; throw cause })
  if (!pin) return remaining.length === 0
  let replacement: Pin | undefined
  for (const name of remaining) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Artifact pin metadata corrupt')
    const candidate = await boundedJson(resolve(directory, 'pins', name)) as Pin
    if (candidate.sessionId === pin.sessionId) { replacement = candidate; break }
  }
  const accessPath = resolve(directory, 'access', `${sha(pin.sessionId)}.json`)
  if (replacement) await publishPin(directory, replacement)
  else await rm(accessPath, { force: true })
  return remaining.length === 0
}
