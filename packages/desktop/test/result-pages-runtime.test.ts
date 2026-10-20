import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { createSessionCoordinator } from "../../session-persistence/src/index.ts"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { contextWorkspaceLocation, contextSourceIdentity, createContextOutputService } from "../../context-output/src/index.ts"
import { createDesktopHost } from "../../desktop-gateway/src/host.ts"
import { HarnessClient, encodeFrame } from "@i-harness/sdk"
import { dispatchDesktopRequest, type DesktopIpcDependencies } from "../src/main/ipc.ts"

it("reads original cold retained bytes through actual Desktop main, SDK client and Gateway host", async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-result-pages-")), workspace=join(root,"workspace"), sessionDir=join(root,"sessions"), settingsPath=join(root,"settings.json")
  await mkdir(workspace);await mkdir(sessionDir);await writeFile(settingsPath,"{}")
  const coordinator=createSessionCoordinator(createJsonlBackend(sessionDir),{lock:{enabled:true}})
  for(const sessionId of ["conversation","foreign","archived","hidden"]) await coordinator.create({sessionId,...(sessionId==="archived"?{archived:true}:sessionId==="hidden"?{origin:"subagent",parentSession:"conversation"}:{})})
  await coordinator.flush("conversation")
  const location=await contextWorkspaceLocation(workspace,sessionDir)
  const owner=createContextOutputService({root:location.serviceRoot,workspaceId:location.workspaceKey,authorizeResult:async()=>true})
  const scope=owner.registerResultScope({operationId:"desktop-original",sessionId:"conversation",callId:"c",source:{sourceId:contextSourceIdentity(location.workspaceKey,location.canonical)}},()=>true)
  const sink=await owner.beginResult(scope,"text-utf8-v1");await sink.write(Buffer.from("actual Desktop retained bytes 🙂"))
  const saved=await sink.finish("source-limited");if(saved.kind!=="committed")throw Error("Original fixture refused")
  await owner.grant({sessionId:"conversation"},[saved.ref.id],"hidden")
  await owner.close();await coordinator.close()
  const before=await readFile(join(sessionDir,"conversation.jsonl")), input=new PassThrough(),replies=new PassThrough()
  const host=await createDesktopHost({workspace,sessionDir,settingsPath,onWrite:frame=>replies.write(encodeFrame(frame)+"\n")})
  input.on("data",line=>{void host.handleLine(String(line).trim())})
  const client=new HarnessClient(replies,input),info=await client.initialize()
  let starts=0
  const dependencies={catalog:{get:(id:string)=>id==="w"?{id,path:workspace,label:"Fixture"}:undefined},runtimes:{get:async()=>{starts++;return {client,info}}}} as unknown as DesktopIpcDependencies
  const request={kind:"session/result/read",workspaceId:"w",sessionId:"conversation",ref:saved.ref,maxBytes:16384}
  try {
    expect(info.capabilities["session-result-read"]).toEqual(["1"])
    for(const bad of [{...request,maxBytes:64000},{...request,extra:"path"},{...request,workspaceId:"unknown"}]) await expect(dispatchDesktopRequest(bad,dependencies)).rejects.toThrow()
    expect(starts).toBe(0)
    expect(await dispatchDesktopRequest(request,dependencies)).toMatchObject({ref:saved.ref,eof:true,data:{kind:"text",text:"actual Desktop retained bytes 🙂"}})
    for(const sessionId of ["foreign","archived","hidden"]) expect(await dispatchDesktopRequest({...request,sessionId},dependencies)).toMatchObject({kind:"unavailable"})
    for(const forged of [{revision:"a".repeat(64)},{codec:"json-utf8-v1"},{encodedBytes:saved.ref.encodedBytes+1},{contentDigest:"b".repeat(64)},{completeness:"complete"}]) expect(await dispatchDesktopRequest({...request,ref:{...saved.ref,...forged}},dependencies)).toMatchObject({kind:"unavailable"})
    expect(await readFile(join(sessionDir,"conversation.jsonl"))).toEqual(before)
  } finally {await client.close();await host.close();await rm(root,{recursive:true,force:true})}
},20000)
