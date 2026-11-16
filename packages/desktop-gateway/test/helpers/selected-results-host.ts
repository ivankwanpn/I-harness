import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../../session-executor/test/controlled-model.ts'
import { createJsonlCommitCoordinator } from '../../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createDesktopHost } from '../../src/host.ts'

/** Header line every controlled `read` result must contain. */
export const SELECTED_RESULTS_HEADER = 'SELECTED_RESULTS_HOST_HEADER'

export function bigFileContent(): string {
  return SELECTED_RESULTS_HEADER + '\n' + Array.from({ length: 2400 }, (_, index) => `line-${index}-${'q'.repeat(60)}`).join('\n')
}

export type SelectedHostStore = 'commit-log' | 'jsonl'
export type SelectedHostFixture = {
  root: string; workspace: string; sessionDir: string; settingsPath: string; credentialsPath: string
  /** Real project configured through the public project route. */
  project: { id: string; name: string; roots: string[]; primaryRoot: string }
  open(): Promise<SelectedHostClient>
  dispose(): Promise<void>
}
export type SelectedHostStats = { modelCalls: number; toolCalls: number }
export type SelectedHostClient = {
  host: Awaited<ReturnType<typeof createDesktopHost>>
  frames: RpcMessage[]; stats: SelectedHostStats
  call(method: string, params?: unknown): Promise<unknown>
  /** One raw result page; the SDK rejects malformed queries itself. */
  readPage(sessionId: string, ref: unknown, extra?: { offset?: number; maxBytes?: number }): Promise<{
    data?: { kind: 'text'; text: string } | { kind: 'bytes'; base64: string }
    eof?: boolean; nextOffset?: number; kind?: string; reason?: string
  }>
  /** Reassemble every page of one retained result through the public RPC. */
  readAll(sessionId: string, ref: unknown): Promise<{ text: string; bytes: number; pages: number }>
  close(): Promise<void>
}

/** Session-store facts written by the real host, read back through the store. */
export type StoredResultRef = { callId?: string; seq: number; ref: { id: string; revision: string; contentDigest: string; encodedBytes: number } }
export async function storedSession(sessionDir: string, sessionId: string) {
  const observer = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
  try {
    const { session } = await observer.load(sessionId)
    const events = session.events as { type: string; name?: string; callId?: string; seq?: number; page?: { ordinal: number; rows?: { protocol?: string; ref?: { id?: string }; original?: unknown }[] }; results?: unknown; version?: number; digest?: string; envelope?: { retention?: { kind?: string; ref?: StoredResultRef['ref'] } } }[]
    const results: StoredResultRef[] = events.filter(event => event.type === 'tool/result' && event.name === 'read')
      .flatMap(event => event.envelope?.retention?.kind === 'artifact' && event.envelope.retention.ref ? [{ callId: event.callId, seq: event.seq!, ref: event.envelope.retention.ref }] : [])
    const artifactResultCount = events.filter(event => event.type === 'tool/result' && event.envelope?.retention?.kind === 'artifact').length
    return { header: session.header as { semanticSeed?: { version?: number; codec?: string; operationId?: string; requestDigest?: string } }, events, results, artifactResultCount }
  } finally { await observer.close() }
}

/** True when the file store still holds the artifact directory for one ref. */
export async function managedArtifactPaths(sessionDir: string, refId: string): Promise<string[]> {
  const names = await readdir(sessionDir, { recursive: true })
  return names.map(String).filter(name => name.includes(refId))
}

/** A real Desktop host: only the provider client is controlled. */
export async function createSelectedResultsHostFixture(options: { store?: SelectedHostStore } = {}): Promise<SelectedHostFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ih-selected-host-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({
    autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' },
    llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_SELECTED_RESULTS_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } },
  }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_SELECTED_RESULTS_KEY: 'controlled' } }))
  await writeFile(join(workspace, 'big.txt'), bigFileContent(), 'utf8')
  const project = { id: 'project', name: 'Selected results project', roots: [workspace], primaryRoot: workspace }
  return {
    root, workspace, sessionDir, settingsPath, credentialsPath, project,
    async open() {
      const frames: RpcMessage[] = [], stats: SelectedHostStats = { modelCalls: 0, toolCalls: 0 }
      const host = await createDesktopHost({
        workspace, sessionDir, settingsPath, credentialsPath, sessionStore: options.store ?? 'commit-log',
        onWrite: frame => frames.push(frame),
        buildProviderClient: () => controlledModel(request => ({
          async *stream(request) {
            request.signal?.throwIfAborted()
            request.validateBeforeTransport?.()
            stats.modelCalls++
            if (request.messages.at(-1)?.role === 'tool') { yield { type: 'text/chunk', text: 'controlled answer' }; yield { type: 'end' }; return }
            if (String(request.messages.at(-1)?.content).includes('read big')) {
              stats.toolCalls++
              yield { type: 'tool_call', call: { id: `read-call-${stats.modelCalls}`, name: 'read', args: { path: 'big.txt' } } }
              yield { type: 'end' }
              return
            }
            yield { type: 'text/chunk', text: 'controlled answer' }
            yield { type: 'end' }
          },
        } as import('@i-harness/llm-seam').ModelClient).stream(request)),
      })
      let serial = 0
      const call = async (method: string, params: unknown = {}) => {
        const id = ++serial
        await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        const frame = frames.findLast(item => 'id' in item && item.id === id)
        if (!frame) throw new Error('missing reply for ' + method)
        if (!isRpcSuccess(frame)) throw new Error(method + ' -> ' + JSON.stringify(frame))
        return frame.result
      }
      const readPage: SelectedHostClient['readPage'] = async (sessionId, ref, extra = {}) =>
        await call('session/result/read', { sessionId, ref, maxBytes: 32768, ...extra }) as Awaited<ReturnType<SelectedHostClient['readPage']>>
      const readAll: SelectedHostClient['readAll'] = async (sessionId, ref) => {
        let offset = 0, text = '', pages = 0
        for (;;) {
          const page = await readPage(sessionId, ref, { offset })
          pages++
          if (!page.data) throw new Error('retained result unavailable: ' + JSON.stringify(page))
          text += page.data.kind === 'text' ? page.data.text : Buffer.from(page.data.base64, 'base64').toString('utf8')
          if (page.eof) return { text, bytes: Buffer.byteLength(text), pages }
          if (page.nextOffset === undefined || page.nextOffset <= offset) throw new Error('retained result cursor did not advance')
          offset = page.nextOffset
        }
      }
      return { host, frames, stats, call, readPage, readAll, close: () => host.close() }
    },
    async dispose() { await rm(root, { recursive: true, force: true }) },
  }
}

/** Configure and bind the real project through the public routes. */
export async function bindProject(client: SelectedHostClient, sessionId: string, project: SelectedHostFixture['project']) {
  await client.call('desktop/project/sync', { projects: [project] })
  await client.call('desktop/session/project/bind', { sessionId, projectId: project.id })
}

/** Prepare one selected-results (V2) fork through the public RPC. */
export async function prepareSelected(client: SelectedHostClient, sourceSessionId: string, targetSessionId: string, operationId: string,
  selection?: { kind: 'completed'; atSeq?: number }) {
  const prepared = await client.call('session/fork/prepare', { version: 2, sourceSessionId, results: 'selected-results-v1', ...(selection === undefined ? {} : { selection }) }) as {
    version: number; kind: string; core: { sourceSessionId: string; results: string }; requestDigest: string
  }
  const operation = {
    version: 2, kind: 'session-fork-operation', prepared,
    invocation: { version: 1, operationId, targetSessionId, createdAt: new Date().toISOString(), requestDigest: prepared.requestDigest },
  }
  return { prepared, operation }
}

type SelectedBegin = {
  kind: string; capture: string; sessionId: string; seedLength: number; receipt: {
    seedDigest: string; manifestDigest: string; results: { version: number; rows: number; pages: number; digest: string }
  }
}

/** Begin or retry one prepared operation through its real public route. */
export async function executeSelected(client: SelectedHostClient, operation: unknown, mode: 'begin' | 'retry' = 'begin'): Promise<SelectedBegin> {
  return await client.call(mode === 'begin' ? 'session/fork/begin' : 'session/fork/retry', { operation }) as SelectedBegin
}

/** Prepare + begin one selected-results (V2) fork through the public RPC. */
export async function forkSelected(client: SelectedHostClient, sourceSessionId: string, targetSessionId: string, operationId: string) {
  const { prepared, operation } = await prepareSelected(client, sourceSessionId, targetSessionId, operationId)
  return { prepared, operation, begin: await executeSelected(client, operation) }
}

/** Managed rows declared by the child's immutable V3 seed pages. */
export function seedManagedRows(events: { type: string; page?: { rows?: { protocol?: string; ref?: { id?: string; revision?: string }; original?: unknown }[] } }[]) {
  return events.filter(event => event.type === 'conversation/seed-results')
    .flatMap(event => (event.page?.rows ?? []).filter(row => row.protocol === 'managed'))
}
export function seedLegacyRows(events: { type: string; page?: { rows?: { protocol?: string; ref?: { id?: string; revision?: string } }[] } }[]) {
  return events.filter(event => event.type === 'conversation/seed-results')
    .flatMap(event => (event.page?.rows ?? []).filter(row => row.protocol === 'legacy'))
}
