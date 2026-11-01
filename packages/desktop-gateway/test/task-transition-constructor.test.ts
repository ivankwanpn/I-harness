import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

it('desktop session creation initializes its original task document',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'desktop-task-'))
 const workspace=join(root,'workspace'),sessionDir=join(root,'sessions'),settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json'),frames:RpcMessage[]=[]
 await mkdir(workspace);await mkdir(sessionDir);await writeFile(settingsPath,'{}')
 const host=await createDesktopHost({workspace,sessionDir,settingsPath,credentialsPath,onWrite:frame=>frames.push(frame)})
 try {
  await host.handleLine(encodeFrame(makeRequest(1,'initialize',{})))
  await host.handleLine(encodeFrame(makeRequest(2,'session/create',{})))
  const reply=frames.find(frame=>'id' in frame&&frame.id===2);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply))
  const {sessionId}=reply.result as {sessionId:string}
  expect(JSON.parse(await readFile(join(sessionDir,`task-${sessionId}.doc.jsonl`),'utf8'))).toEqual({formatVersion:2,tasks:[],notifications:[]})
  expect(JSON.parse((await readFile(join(sessionDir,`${sessionId}.jsonl`),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
  await host.handleLine(encodeFrame(makeRequest(3,'session/create',{clientToken:'draft-token-12345678'})))
  const draftReply=frames.find(frame=>'id' in frame&&frame.id===3);if(!isRpcSuccess(draftReply))throw Error(JSON.stringify(draftReply))
  const draftId=(draftReply.result as {sessionId:string}).sessionId
  expect(JSON.parse(await readFile(join(sessionDir,`task-${draftId}.doc.jsonl`),'utf8')).formatVersion).toBe(2)
  expect(JSON.parse((await readFile(join(sessionDir,`${draftId}.jsonl`),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
 } finally {await host.close();await rm(root,{recursive:true,force:true})}
},30000)
