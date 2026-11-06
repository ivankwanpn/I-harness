import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

// Store-agnostic: a created session must initialize the composition's empty
// task document. The previous version read the legacy `*.doc.jsonl` file, which
// only exists on the jsonl store.
it('desktop session creation initializes its original task document',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'desktop-task-'))
 const workspace=join(root,'workspace'),sessionDir=join(root,'sessions'),settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json'),frames:RpcMessage[]=[]
 await mkdir(workspace);await mkdir(sessionDir);await writeFile(settingsPath,'{}')
 const host=await createDesktopHost({workspace,sessionDir,settingsPath,credentialsPath,onWrite:frame=>frames.push(frame)})
 let number=0
 const call=async(method:string,params:Record<string,unknown>={})=>{const id=++number;await host.handleLine(encodeFrame(makeRequest(id,method,params)));const reply=frames.find(frame=>'id' in frame&&frame.id===id);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result}
 try {
  await call('initialize')
  const {sessionId}=await call('session/create') as {sessionId:string}
  expect(sessionId).toBeTruthy()
  expect(await call('desktop/session/work-state',{sessionId})).toMatchObject({todos:null,todosRevision:0})
 } finally {await host.close();await rm(root,{recursive:true,force:true})}
},30000)
