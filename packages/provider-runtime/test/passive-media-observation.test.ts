import {afterEach,expect,it,vi} from 'vitest'
import {createGenerationControl} from '@i-harness/llm-seam'
import {registerOriginalPassiveReservation,type PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'
import {requestVideoAudio} from '../src/video-audio.ts'
afterEach(()=>vi.unstubAllGlobals())
it('records actual audio route handoff with unavailable usage before original settlement failure',async()=>{
 const rows:PassiveProducerRecord[]=[],trace:string[]=[];let sends=0
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{expect(url).toBe('https://audio.invalid/v1/chat/completions');expect(JSON.parse(String(init.body)).model).toBe('audio-model');sends++;trace.push('fetch');return new Response(JSON.stringify({choices:[{message:{content:'fixture analysis'}}]}))})
 const control=createGenerationControl({signal:new AbortController().signal,async reserve(candidate){
  const reservation={issue(){trace.push('issue')},async settle(){trace.push('settle');throw false}}
  registerOriginalPassiveReservation(reservation,{ownerSessionId:'s',actionId:'a',attemptId:'t',ordinal:1,lane:'auxiliary',cause:'auxiliary',incarnation:'i',rebind:0,...candidate},{capture(row){rows.push(row);trace.push(row.kind)},unavailable(){trace.push('unavailable')}});return reservation
 }})
 await expect(requestVideoAudio({wav:new Uint8Array(44),startSeconds:0,durationSeconds:1,generation:{signal:new AbortController().signal,control,async bindAudio(){},async close(){}}},{provider:'audio-provider',model:'audio-model',baseURL:'https://audio.invalid',apiKey:'fixture-only',passiveUsageWorkspace:'workspace'})).rejects.toBe(false)
 expect(sends).toBe(1);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({kind:'handoff',attribution:{providerId:'audio-provider',modelId:'audio-model',workspace:'workspace',billing:'api'}})
 expect(trace).toEqual(['issue','handoff','fetch','unavailable','settle'])
})
