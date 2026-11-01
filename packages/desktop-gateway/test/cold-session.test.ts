import * as executorModule from "@i-harness/session-executor"
import { it, expect, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import * as agentSettingsModule from "../src/agent-settings.ts"
import * as subagentSettingsModule from "../src/subagent-settings.ts"
import * as pluginsModule from "../src/plugins.ts"
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
  let policyWork: Promise<unknown> | undefined
  const createAgentSettings = agentSettingsModule.createAgentSettings
  const createSubagentSettings = subagentSettingsModule.createSubagentSettings
  const createDesktopPlugins = pluginsModule.createDesktopPlugins
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(agentSettingsModule, "createAgentSettings").mockImplementation((...args) => ({
    ...createAgentSettings(...args), sync: async () => { throw new Error("fixture policy refresh failure") },
  }))
  vi.spyOn(subagentSettingsModule, "createSubagentSettings").mockImplementation((...args) => {
    const settings = createSubagentSettings(...args)
    return { ...settings, state: () => {
      policyWork = held.then(async () => {
        const result = await settings.state() // acquires the real settings.provider.lock
        policyFinished = true
        return result
      })
      return policyWork as ReturnType<typeof settings.state>
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
