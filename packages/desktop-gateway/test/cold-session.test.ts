import * as executorModule from "@i-harness/session-executor"
import { it, expect, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createDesktopProfileServices } from "../src/configuration-host.ts"
import * as agentSettingsModule from "../src/agent-settings.ts"
import * as contextSettingsModule from "../src/context-subsystems.ts"
import * as pluginsModule from "../src/plugins.ts"
import * as settingsModule from "@i-harness/settings"
import { toJSONL, type SessionEvent } from '@i-harness/core-session'

it('cold-reads format7 replacement source/history and context without preparing a provider or changing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-gateway-cold-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace); await mkdir(sessionDir)
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'gateway', text: 'S', coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ]
  const lines = toJSONL({ formatVersion: 7, events }).split('\n')
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sessionId: 's', createdAt: 'literal' })
  const raw = lines.join('\n'), path = join(sessionDir, 's.jsonl')
  await writeFile(path, raw)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, '{}'); await writeFile(credentialsPath, '{}')
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: frame => frames.push(frame) })
  try {
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/history', params: { sessionId: 's' } }))
    expect(frames.find(frame => 'id' in frame && frame.id === 2)).toMatchObject({ result: { events, nextSeq: 7 } })
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/context', params: { sessionId: 's' } }))
    expect(frames.find(frame => 'id' in frame && frame.id === 3)).toHaveProperty('result')
    expect(await readFile(path, 'utf8')).toBe(raw)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])("reads cold history without executing a model and restores saved model selection (configured=%s)", async (configured) => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-history-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const sessionDir = join(root, "sessions")
  const coord = createSessionCoordinator(createJsonlBackend(sessionDir))
  const { id } = await coord.create({ modelSelection: { provider: "fixture", model: "chosen" } })
  await coord.append(id, [{ type: "user/message", text: "saved history", seq: 0 }])
  await coord.close()
  const logPath = join(sessionDir, id + ".jsonl")
  const before = await readFile(logPath, "utf8")
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify(configured ? { llm: {
    providers: { fixture: { protocol: "openai-completions", baseURL: "http://127.0.0.1:1", apiKeyEnv: "IH_COLD_TEST", models: [{ id: "chosen", contextWindow: 272000 }, { id: "default", contextWindow: 1000000 }] } },
    defaultModel: { provider: "fixture", model: "default" },
  } } : {}))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_COLD_TEST: "fixture" } }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: f => frames.push(f) })
  const call = (requestId: number, method: string, params: unknown) => host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
  try {
    await call(1, "initialize", {})
    await call(2, "session/history", { sessionId: id, afterSeq: 0 })
    const history = frames.find(f => "id" in f && f.id === 2)
    expect(isRpcSuccess(history)).toBe(true)
    if (isRpcSuccess(history)) expect(history.result).toEqual({ events: [{ type: "user/message", text: "saved history", seq: 0 }], nextSeq: 1 })
    expect(await readFile(logPath, "utf8")).toBe(before)
    if (configured) {
      await call(3, "session/model/state", { sessionId: id })
      const model = frames.find(f => "id" in f && f.id === 3)
      expect(isRpcSuccess(model)).toBe(true)
      if (isRpcSuccess(model)) expect(model.result).toMatchObject({ status: "ready", modelId: "chosen" })
    }
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it("leaves locked policy readers idle under watch coverage, and retries a failed settings change", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-policy-watch-")), workspace = join(root, "workspace")
  await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, "{}")
  const watch = settingsModule.watchSettings
  let monitor: ReturnType<typeof watch> | undefined
  const observer = vi.spyOn(settingsModule, "watchSettings").mockImplementation((paths, ...args) => {
    const handle = watch(paths, ...args)
    if (paths === settingsPath) monitor = handle
    return handle
  })
  let reads = 0, failNext = false
  const create = agentSettingsModule.createAgentSettings
  const reader = vi.spyOn(agentSettingsModule, "createAgentSettings").mockImplementation((...args) => {
    const original = create(...args)
    return { ...original, async sync(...args: Parameters<typeof original.sync>) {
      reads++
      if (failNext) { failNext = false; throw new Error("Injected transient read error") }
      return original.sync(...args)
    } }
  })
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const frames: RpcMessage[] = []
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, onWrite: frame => frames.push(frame) })
    await host.handleLine(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}}))
    await monitor!.ready
    await vi.waitFor(() => expect(monitor!.getState().kind).toBe("covered"))
    const baseline = reads
    await new Promise(done => setTimeout(done, 2200))
    expect(reads).toBe(baseline)
    failNext = true
    await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only" }))
    let id = 2
    await vi.waitFor(async () => {
      await host!.handleLine(JSON.stringify({jsonrpc:"2.0",id:++id,method:"desktop/sandbox/state",params:{}}))
      expect(frames.find(frame => "id" in frame && frame.id === id)).toMatchObject({result:{mode:"read-only"}})
      expect(reads).toBeGreaterThanOrEqual(baseline + 2)
    }, {timeout:5000})
    expect(warn).toHaveBeenCalled()
  } finally {
    try { await host?.close() } finally { observer.mockRestore(); reader.mockRestore(); warn.mockRestore(); await rm(root,{recursive:true,force:true}) }
  }
}, 20_000)

it("waits for both owned policy refreshes before closing even when one refresh rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-policy-close-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, "{}")
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  let pluginsClosed!: () => void
  const reachedPluginClose = new Promise<void>((done) => { pluginsClosed = done })
  let policyFinished = false
  let policyWork: Promise<void> | undefined
  const createAgentSettings = agentSettingsModule.createAgentSettings
  const createContextSettings = contextSettingsModule.createContextSubsystemSettings
  const createDesktopPlugins = pluginsModule.createDesktopPlugins
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(agentSettingsModule, "createAgentSettings").mockImplementation((...args) => ({
    ...createAgentSettings(...args), sync: async () => { throw new Error("fixture policy refresh failure") },
  }))
  vi.spyOn(contextSettingsModule, "createContextSubsystemSettings").mockImplementation((...args) => {
    const settings = createContextSettings(...args)
    return { ...settings, syncPolicy: observed => {
      if (!observed) return settings.syncPolicy()
      policyWork = held.then(async () => {
        await settings.syncPolicy(observed)
        policyFinished = true
      })
      return policyWork
    } }
  })
  vi.spyOn(pluginsModule, "createDesktopPlugins").mockImplementation((path, options) => {
    const plugins = createDesktopPlugins(path, options)
    return { ...plugins, close: async () => { await plugins.close(); pluginsClosed() } }
  })
  const host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, onWrite: () => {} })
  let closed = false
  const closing = host.close().then(() => { closed = true })
  try {
    await reachedPluginClose
    // Finish the host's post-plugin microtasks. The remaining owner is the
    // explicitly held policy refresh, rather than a timer or an arbitrary wait.
    await new Promise<void>((done) => setImmediate(done))
    expect(closed).toBe(false)
    expect(policyFinished).toBe(false)
    release()
    await closing
    expect(policyFinished).toBe(true)
    expect(warn).toHaveBeenCalled()
  } finally {
    release()
    await policyWork
    await closing
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it("applies shared settings to each workspace and keeps the remaining workspace live after its sibling closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-workspace-policy-"))
  const settingsPath = join(root, "settings.json")
  const save = (mode: string, enabled: boolean) => writeFile(settingsPath, JSON.stringify({ sandboxMode: mode, contextSubsystems: { contextOutput: { enabled } } }))
  await save("workspace-write", false)
  const profile = createDesktopProfileServices(settingsPath)
  const hosts: Awaited<ReturnType<typeof createDesktopHost>>[] = []
  async function open(name: string) {
    const workspace = join(root, name)
    await mkdir(workspace)
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir: join(root, name + "-sessions"), profile, onWrite: frame => frames.push(frame) })
    hosts.push(host)
    let sequence = 0
    async function call(method: string) {
      const id = ++sequence
      await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }))
      return frames.find(frame => "id" in frame && frame.id === id)
    }
    await call("initialize")
    return { host, call }
  }
  try {
    const a = await open("a"), b = await open("b")
    await save("read-only", true)
    await vi.waitFor(async () => {
      for (const {call} of [a, b]) {
        expect(await call("desktop/sandbox/state")).toMatchObject({ result: { mode: "read-only" } })
        expect(await call("desktop/context-subsystems/state")).toMatchObject({ result: { context: { enabled: true } } })
      }
    }, { timeout: 5000 })
    await a.host.close()
    await save("workspace-write", false)
    await vi.waitFor(async () => {
      expect(await b.call("desktop/sandbox/state")).toMatchObject({ result: { mode: "workspace-write" } })
      expect(await b.call("desktop/context-subsystems/state")).toMatchObject({ result: { context: { enabled: false } } })
    }, { timeout: 5000 })
  } finally {
    await Promise.all(hosts.map(host => host.close()))
    await profile.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('cold Gateway history preserves retained facts without building providers or assemblies', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ih-retained-gateway-')), workspace=join(root,'workspace'),sessionDir=join(root,'sessions')
  await mkdir(workspace);await mkdir(sessionDir)
  const envelope = {version:1 as const,execution:{outcome:'failed' as const,dispatch:'not-dispatched' as const},preview:'cold retained preview',media:[{mediaType:'image/png' as const,dataBase64:'iVBORw0KGgo=',name:'cold.png'}],retention:{kind:'artifact' as const,ref:{version:1 as const,id:'ctxv1_'+'a'.repeat(64),revision:'b'.repeat(64),codec:'json-utf8-v1' as const,encodedBytes:1000000,contentDigest:'c'.repeat(64),completeness:'capture-canceled' as const}},dependencies:{kind:'artifact-set' as const,ref:{version:1 as const,id:'ctxv1_'+'d'.repeat(64),revision:'e'.repeat(64),codec:'json-utf8-v1' as const,encodedBytes:300,contentDigest:'f'.repeat(64),completeness:'complete' as const},count:2}}
  const events: SessionEvent[] = [{type:'tool/result',callId:'retained',name:'fixture',envelope,seq:0},{type:'code/result',cellId:'cell',callId:'nested',name:'fixture',envelope,seq:1},{type:'code/output',cellId:'cell',envelope,seq:2}]

  const path=join(sessionDir,'retained.jsonl'),lines=toJSONL({formatVersion:10,events}).split('\n')
  lines[0]=JSON.stringify({...JSON.parse(lines[0]!),sessionId:'retained',createdAt:'literal'})
  const raw=lines.join('\n');await writeFile(path,raw)
  const settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json')
  await writeFile(settingsPath,'{}');await writeFile(credentialsPath,'{}')
  let assemblies=0,preparations=0,providers=0
  const actualCreate=executorModule.createSessionService
  const spy=vi.spyOn(executorModule,'createSessionService').mockImplementation(options=>{
    const original=options.modelBindingFor
    const service=actualCreate({...options,modelBindingFor:async(...args)=>{preparations++;return original!(...args)}})
    service.onAssembly(()=>{assemblies++})
    return service
  })
  const frames:RpcMessage[]=[]
  const host=await createDesktopHost({workspace,sessionDir,settingsPath,credentialsPath,onWrite:frame=>frames.push(frame),buildProviderClient:()=>{providers++;throw new Error('unexpected provider preparation')}})
  try {
    await host.handleLine(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}}))
    await host.handleLine(JSON.stringify({jsonrpc:'2.0',id:2,method:'session/history',params:{sessionId:'retained'}}))
    expect(frames.find(frame=>'id'in frame&&frame.id===2)).toMatchObject({result:{events,nextSeq:3}})
    expect(preparations).toBe(0);expect(providers).toBe(0);expect(assemblies).toBe(0)
    expect(await readFile(path,'utf8')).toBe(raw)
  } finally {await host.close();spy.mockRestore();await rm(root,{recursive:true,force:true})}
})
