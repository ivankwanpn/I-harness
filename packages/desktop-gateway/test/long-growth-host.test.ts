import {checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
import { expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import type { SessionEvent } from "@i-harness/core-session"
import { createSession, deriveMessages } from "@i-harness/core-session"
import { describeContext } from "../../llm-openai-compatible/src/context.ts"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createDesktopHost } from "../src/host.ts"

function decodeRequestChunks(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
}

it('decodes a fixture request losslessly when a multibyte UTF-8 character crosses chunks', () => {
  const raw = '{"text":"合"}', bytes = Buffer.from(raw, 'utf8')
  for (let split = 1; split < bytes.length; split++) {
    const decoded = decodeRequestChunks([bytes.subarray(0, split), bytes.subarray(split)])
    expect(decoded).toBe(raw)
    expect(JSON.parse(decoded)).toEqual({ text: '合' })
    expect(Buffer.byteLength(decoded, 'utf8')).toBe(bytes.length)
  }
})

it.each([[100000, "turns"], [150000, "turns"], [100000, "autonomous"]] as const)("shipping host compacts cumulative moderate growth with window %s across %s", async (contextWindow, mode) => {
  const root = await mkdtemp(join(tmpdir(), "ih-growth-host-")), workspace = join(root, "workspace")
  await mkdir(workspace)
  const page = "合成資料保留完整工具結果".repeat(500) // 6000 CJK chars: below prune and output spill thresholds
  expect(page.length).toBeLessThan(8192)
  for (let i = 0; i < 12; i++) await writeFile(join(workspace, `page-${i}.txt`), page)
  const frames: RpcMessage[] = [], requests: { kind: string; input: number; reasoning: number; cap?: number; body: any }[] = []
  let reads = 0, mainCalls = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => { chunks.push(chunk) }); req.on("end", () => {
      const raw = decodeRequestChunks(chunks)
      const body = JSON.parse(raw), last = JSON.stringify(body.messages?.at(-1))
      const summary = last.includes("You are now acting as a compaction engine"), title = !body.tools?.length && !summary
      const input = describeContext(body, { model: "fixture", apiKey: "controlled" }).input
      const measured = Object.values(input.components).reduce((n, c) => n + c.heuristicTokens, 0)
      requests.push({ kind: summary ? "summary" : title ? "title" : "main", input: measured, reasoning: input.components.replayedReasoning.heuristicTokens, cap: body.max_tokens, body })
      const delta = summary ? { content: checkpointOfLength(600, "Checkpoint: preserve the requested task and completed reads.") }
        : title ? { content: "Controlled growth" }
          : (mode === "autonomous" || mainCalls++ % 2 === 0) && reads < 12 ? { reasoning_content: "推理保留".repeat(250), tool_calls: [{ index: 0, id: `read-${reads}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `page-${reads++}.txt` }) } }] }
            : { content: "All twelve controlled reads completed." }
      // Chat reports cache-inclusive prompt usage; this accepted prefix is
      // calibrated to its actual prepared heuristic, with realistic cache share.
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: measured, prompt_cache_hit_tokens: Math.max(0, measured - 162), completion_tokens: 1100 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing endpoint")
  const settingsPath = join(root, "settings.json"), credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only", webSearchMode: "disabled", compaction: { auto: true },
    llm: { providers: { fixture: { protocol: "openai-completions", baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: "IH_GROWTH_TEST_KEY", models: [{ id: "fixture", contextWindow, maxTokens: 20000 }] } }, defaultModel: { provider: "fixture", model: "fixture" } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_GROWTH_TEST_KEY: "controlled" } }))
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, credentialsPath, onWrite: frame => frames.push(frame) })
    let id = 0
    const request = async (method: string, params: unknown): Promise<any> => {
      const next = ++id; await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }))
      const response = frames.find(f => "id" in f && f.id === next)
      if (!isRpcSuccess(response)) throw new Error(JSON.stringify({ response: response && "error" in response ? response.error.message : "missing response", requests: requests.map(({ body: _body, ...r }) => r) }))
      return response.result
    }
    await request("initialize", {})
    const { sessionId } = await request("session/create", {})
    if (mode === "autonomous") await request("session/prompt", { sessionId, prompt: "Read all twelve synthetic pages once each and preserve every completed result." })
    else for (let i = 0; i < 12; i++) await request("session/prompt", { sessionId, prompt: `Read synthetic page ${i} once and preserve the completed result.` })
    const history = await request("session/history", { sessionId, afterSeq: 0, limit: 1000 })
    const events = history.events as SessionEvent[]
    expect(events.filter(e => e.type === "tool/dispatch").map(e => e.callId)).toEqual(Array.from({ length: 12 }, (_, i) => `read-${i}`))
    const results = events.filter(e => e.type === "tool/result")
    expect(results).toHaveLength(12)
    expect(results.every(e => JSON.stringify(e.output).includes(page))).toBe(true)
    expect(results.every(e => JSON.stringify(e.output).length < 8192)).toBe(true)
    expect(events.some(e => e.type === "compaction/prune" || e.type === "context/result-ref")).toBe(false)
    const firstSummary = requests.findIndex(r => r.kind === "summary")
    expect(firstSummary).toBeGreaterThan(1)
    const summaries = requests.filter(r => r.kind === "summary")
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries.every(r => r.cap === 4096)).toBe(true)
    const prior = requests.slice(0, firstSummary).filter(r => r.kind === "main").at(-1)!
    const next = requests.slice(firstSummary + 1).find(r => r.kind === "main")!
    expect(prior.reasoning).toBeGreaterThan(0)
    // The preceding send does not yet include its completed output. Reprice
    // the entire raw prefix immediately before R under the next main surface.
    const rewriteIndex=events.findIndex(event=>event.type==='compaction/replacement')
    expect(rewriteIndex).toBeGreaterThan(0)
    const beforeMessages=deriveMessages({...createSession(),events:events.slice(0,rewriteIndex)})
    const before=await createOpenAICompatibleClient({apiKey:'controlled',model:'fixture',baseUrl:'https://fixture.invalid'}).prepare!({
      systemPrompt:next.body.messages.find((message:any)=>message.role==='system')?.content??'',
      tools:next.body.tools.map((tool:any)=>({name:tool.function.name,description:tool.function.description,inputSchema:tool.function.parameters})),
      messages:beforeMessages,maxOutputTokens:next.cap,
    })
    const beforeInput=Object.values(before.measurement.input.components).reduce((sum,component)=>sum+component.heuristicTokens,0)
    expect(next.input).toBeLessThan(beforeInput)
    expect(requests.filter(r => r.kind === "main")).toHaveLength(mode === "autonomous" ? 13 : 24)
    expect(summaries.length).toBeGreaterThan(1)
    expect(events.some(e => e.type === "compaction/replacement")).toBe(true)
    const active = deriveMessages({ ...createSession(), events })
    expect(active.filter(m => typeof m.content === "string" && m.content.includes("Checkpoint: preserve"))).toHaveLength(1)
    const budget = events.filter(e => e.type === "context/budget" && e.version === 2).map(e => e.snapshot)
    const crossing = budget.find(snapshot=>snapshot.pressure.kind==='known'&&snapshot.pressure.softNeeded)!
    if(crossing?.pressure.kind!=='known'||crossing.output.effectiveCap===undefined)throw Error('actual prepared pressure crossing required')
    const selectedBudget=contextWindow-Math.ceil(.1*contextWindow)-crossing.output.effectiveCap
    expect(crossing.pressure).toMatchObject({inputBudget:selectedBudget,trigger:Math.floor(.8*selectedBudget),target:Math.floor(.7*selectedBudget)})
    expect(crossing.pressure.input).toBeGreaterThanOrEqual(crossing.pressure.trigger)
    expect(crossing.pressure.input).toBeLessThan(.8*contextWindow)
    expect(crossing.estimate).toMatchObject({kind:'estimated',source:'provider-anchor-plus-projection'})
    expect(requests.filter(request=>request.kind==='main').every(request=>request.cap!==undefined&&request.cap>0&&request.cap<=20000)).toBe(true)
    const beforeSamples=events.slice(0,rewriteIndex).filter(event=>event.type==='context/usage'&&event.version===2&&event.op==='sample')
    const afterSamples=events.slice(rewriteIndex+1).filter(event=>event.type==='context/usage'&&event.version===2&&event.op==='sample')
    expect(beforeSamples.length).toBeGreaterThan(0);expect(afterSamples.length).toBeGreaterThan(0)
    const lastBefore=beforeSamples.at(-1)!,firstAfter=afterSamples[0]!
    if(lastBefore.type!=='context/usage'||lastBefore.version!==2||lastBefore.op!=='sample'||firstAfter.type!=='context/usage'||firstAfter.version!==2||firstAfter.op!=='sample')throw Error('accepted samples required')
    expect(firstAfter.checkpoint.request.ownerSessionId).toBe(sessionId)
    expect(firstAfter.checkpoint.request.snapshot.contextEpoch).not.toBe(lastBefore.checkpoint.request.snapshot.contextEpoch)
    expect(events.slice(rewriteIndex+1)).toContainEqual(expect.objectContaining({type:'context/usage',version:2,op:'retire',anchorId:lastBefore.checkpoint.anchorId,reason:'context-rewritten'}))
    expect(budget.some(snapshot=>snapshot.projectionRevision>0&&snapshot.estimate.kind==='estimated'&&snapshot.estimate.source==='provider-anchor-plus-projection')).toBe(true)
    // Oversized candidates are assessed but never sent: hard admission may
    // bypass the ordinary hysteresis before rebuilding a smaller main request.
    const oversized=requests.filter(r=>r.kind==='main'&&r.input+r.cap!+Math.ceil(contextWindow*.1)>contextWindow)
      .map(({input,cap})=>({input,cap,total:input+cap!+Math.ceil(contextWindow*.1),window:contextWindow,
        admitted:budget.filter(snapshot=>snapshot.output.effectiveCap===cap).map(snapshot=>({estimate:snapshot.estimate,output:snapshot.output,pressure:snapshot.pressure,disposition:snapshot.disposition}))}))
    expect(oversized).toEqual([])
    expect(requests.every(r => r.kind !== "main" || r.body.messages.some((m: any) => m.role === "system") && r.body.tools.length > 0)).toBe(true)
    await host.close(); host = undefined
    host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, credentialsPath, onWrite: frame => frames.push(frame) })
    await request("initialize", {})
    const restored = await request("session/history", { sessionId, afterSeq: 0, limit: 1000 })
    expect(restored.events.filter((e: SessionEvent) => e.type === "tool/result")).toEqual(results)
  } finally {
    await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
