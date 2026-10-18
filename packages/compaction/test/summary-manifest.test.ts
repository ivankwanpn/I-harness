import {expect,it} from 'vitest'
import type {LLMRequest,LLMMessage} from '@i-harness/llm-seam'
import {generateSelectedSummary} from '../src/summary/generate.ts'
import {summarySource} from './fixtures/summary.ts'
import {spyModel} from './fixtures/history.ts'
import {checkpointOfLength} from './fixtures/checkpoint.ts'

type Row={group:string;messages:[number,number];sources:unknown[];provenance:{authority:string}[]}
function manifest(request:LLMRequest):Row[]{
 const directive=request.messages.at(-1)?.content
 if(typeof directive!=='string')throw Error('directive required')
 const match=directive.match(/<recorded-source-manifest>(.*?)<\/recorded-source-manifest>/s)
 if(!match)throw Error('manifest required')
 return JSON.parse(match[1]!)
}
it.each([true,false])('literal assistant-first groups identify their actual neutral request messages (native=%s)',async inherited=>{
 const fixture=spyModel(),source=summarySource([{role:'assistant',content:'FIRST'},{role:'assistant',content:'SECOND'}])
 await generateSelectedSummary(fixture.model,source,{maxTokens:1024,minSummaryChars:500,inherited},{contextWindow:100000})
 expect(fixture.requests).toHaveLength(1)
 const request=fixture.requests[0]!,rows=manifest(request)
 expect(rows.map(row=>row.messages)).toEqual(inherited?[[1,2],[2,3]]:[[0,1],[1,2]])
 expect(rows.map(row=>row.group)).toEqual(['literal-0','literal-1'])
 for(const [index,label]of ['FIRST','SECOND'].entries()){
  const [start,end]=rows[index]!.messages,actual=request.messages.slice(start,end)
  expect(actual).toHaveLength(1)
  if(inherited)expect(actual).toEqual([{role:'assistant',content:label}])
  else{expect(actual[0]!.role).toBe('user');expect(JSON.stringify(actual[0]!.content)).toContain(label)}
  expect(rows[index]!.provenance.map(p=>p.authority)).toEqual(['observation'])
 }
 const first=rows[0]!.messages[0],last=rows.at(-1)!.messages[1]
 expect(first).toBe(inherited?1:0);expect(last).toBe(request.messages.length-1)
 if(inherited)expect(request.messages[0]!.content).toContain('source-record framing')
 expect(String(request.messages.at(-1)!.content)).toContain('zero-based half-open indexes into the final neutral summary request messages')
})
it('literal user-first source requires no framing offset and covers neither extra message nor directive',async()=>{
 const fixture=spyModel(),source=summarySource([{role:'user',content:'USER'},{role:'assistant',content:'ANSWER'}])
 await generateSelectedSummary(fixture.model,source,{maxTokens:1024,minSummaryChars:500,inherited:true},{contextWindow:100000})
 const request=fixture.requests[0]!,rows=manifest(request)
 expect(rows.map(row=>row.messages)).toEqual([[0,1],[1,2]])
 expect(rows.map(row=>request.messages.slice(...row.messages))).toEqual([[{role:'user',content:'USER'}],[{role:'assistant',content:'ANSWER'}]])
 expect(request.messages).toHaveLength(3)
 expect(JSON.stringify(request.messages.slice(0,-1))).not.toContain('source-record framing')
})
it('native ranges include the complete assistant/tool bundle before the next assistant group',async()=>{
 const fixture=spyModel(),source=summarySource([{role:'assistant',content:'FIRST',toolCalls:[{id:'call',name:'read',args:{path:'literal.ts'}}]},
  {role:'tool',toolCallId:'call',content:'EXACT RESULT'},{role:'assistant',content:'SECOND'}])
 await generateSelectedSummary(fixture.model,source,{maxTokens:1024,minSummaryChars:500,inherited:true},{contextWindow:100000})
 const request=fixture.requests[0]!,rows=manifest(request)
 expect(rows.map(row=>row.messages)).toEqual([[1,3],[3,4]])
 expect(request.messages.slice(...rows[0]!.messages)).toEqual([{role:'assistant',content:'FIRST',toolCalls:[{id:'call',name:'read',args:{path:'literal.ts'}}]},
  {role:'tool',toolCallId:'call',content:'EXACT RESULT'}])
 expect(request.messages.slice(...rows[1]!.messages)).toEqual([{role:'assistant',content:'SECOND'}])
 expect(rows[1]!.messages[1]).toBe(request.messages.length-1)
})
it.each([true,false])('partitioned rolling pieces keep literal ranges local to each actual request (native=%s)',async inherited=>{
 const fixture=spyModel(),messages:LLMMessage[]=Array.from({length:8},(_,index)=>({role:'assistant',content:`GROUP-${index} ${'x'.repeat(3000)}`})),source=summarySource(messages)
 const result=await generateSelectedSummary(fixture.model,source,{maxTokens:1024,minSummaryChars:500,inherited},{contextWindow:9000})
 expect(fixture.requests).toHaveLength(2);expect(source.attempts.count).toBe(2)
 expect(result.groupIds).toEqual(['literal-0','literal-1','literal-2','literal-3','literal-4','literal-5','literal-6','literal-7'])
 for(const [piece,request]of fixture.requests.entries()){
  const rows=manifest(request),labels=piece===0?['GROUP-0','GROUP-1','GROUP-2','GROUP-3']:['GROUP-4','GROUP-5','GROUP-6','GROUP-7']
  expect(rows.map(row=>row.messages)).toEqual(inherited?[[1,2],[2,3],[3,4],[4,5]]:[[0,1],[1,2],[2,3],[3,4]])
  expect(rows.map(row=>row.group)).toEqual(piece===0?['literal-0','literal-1','literal-2','literal-3']:['literal-4','literal-5','literal-6','literal-7'])
  for(const [index,label]of labels.entries()){
   const actual=request.messages.slice(...rows[index]!.messages)
   expect(actual).toHaveLength(1);expect(JSON.stringify(actual)).toContain(label+' '+'x'.repeat(3000))
   expect(JSON.stringify(actual)).not.toContain('<compacted-summary>')
  }
  expect(rows.at(-1)!.messages[1]).toBe(request.messages.length-1)
 }
 expect(String(fixture.requests[1]!.messages.at(-1)!.content)).toContain(checkpointOfLength(600))
})
