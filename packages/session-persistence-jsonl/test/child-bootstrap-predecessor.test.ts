import { expect, it } from 'vitest'
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJsonData } from '@i-harness/core-session'
import { encodeChildBootstrapReservation } from '@i-harness/session-persistence'
import { buildBootstrapHeader } from '../../session-persistence/src/coordinator/bootstrap-header.ts'
import { pair } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { bootstrapPathsForRoute } from '../src/backend/bootstrap-stage.ts'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { guards } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { extractCurrentPredecessor, provisionPredecessorLock } from './helpers/current-context-predecessors.ts'
import { extractFormat12Predecessor } from './helpers/format12-predecessor.ts'
import { extractSemanticCodec1Predecessor13 } from './helpers/semantic-codec1-predecessor13.ts'
import { extractChildBootstrapPredecessor13, fixtureRuntime, runPredecessor } from './helpers/child-bootstrap-predecessor.ts'

const methods=['inspect','capture-inspect','capture-inspect-valid','read','snapshot','load','loadOwned','repair','create','bootstrap','resume','resume-payloadless'] as const
const oldRequest=`const request={...input.payload,seed:persistence.compileSemanticSeed({kind:'none'})};`
const getInput=`const input=JSON.parse(await fs.readFile(resolve(store,'input.json'),'utf8'));`
const writer=`${getInput}${oldRequest}
const backend=backendFor(store),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}});let outcome,operationError;
try{outcome=await coordinator.bootstrapSemanticTarget(request,guards)}catch(error){operationError=errorRecord(error)}
const result={kind:outcome?.kind,reason:outcome?.reason,token:outcome?.token,request,receipt:outcome?.receipt,operationError};
process.stdout.write(JSON.stringify({event:'operation-before-cleanup',...result})+'\\n');
const cleanup=await cleanupCoordinator(coordinator);console.log(JSON.stringify({...result,cleanup,counts,operations,resolved}));`
async function inventory(root:string){return Promise.all((await readdir(root)).sort().map(async name=>({name,bytes:(await stat(join(root,name))).isFile()?(await readFile(join(root,name))).toString('base64'):'directory'})))}

it('qualifies actual old clean writers before active foreign-child-stage refusals and preserves every protected byte',async()=>{
 const {root}=await fixtureRuntime('predecessor-matrix'),{request,payload}=pair(),reservation={version:1 as const,kind:'semantic-bootstrap-child-capture' as const,request},reservationBytes=Buffer.from(encodeChildBootstrapReservation(reservation)),full=Buffer.from(buildBootstrapHeader(payload,undefined,undefined,reservation).operation.stageBytes)
 const graphs=[]
 const selected=process.env.IH_CHILD_PREDECESSOR_GRAPHS?.split(',')
 const supplement=process.env.IH_CHILD_PREDECESSOR_SUPPLEMENT==='format11-snapshot-cold'
 const coldOnly=process.env.IH_CHILD_PREDECESSOR_SUPPLEMENT==='current-cold-only'
 const selectedMethods:readonly string[]=supplement?['snapshot']:methods
 if(supplement)expect(selected).toEqual(['format11'])
 await writeFile(join(root,'selection.json'),JSON.stringify({selected:selected??'all',supplement,coldOnly,selectedMethods:coldOnly?[]:selectedMethods},null,2))
 // Every selected graph must execute its genuine clean writer first. Explicit
 // selection permits bounded continuation while unchanged proof is retained.
 for(const [label,format,extract] of [
  ['format11',11,(path:string)=>extractCurrentPredecessor(path,11)],
  ['format12',12,extractFormat12Predecessor],
  ['codec1-format13',13,extractSemanticCodec1Predecessor13],
  ['pre-child-format13',13,extractChildBootstrapPredecessor13],
 ] as const){
  if(selected&&!selected.includes(label))continue
  const graph=join(root,label),receipt=await extract(graph),native=await provisionPredecessorLock(graph)
  expect(native).toMatchObject({version:'3.1.6',entrySha256:'a200e15ec168d00cb3155794808a98243051c61dd7f6989c23c57ee220c918b9',packageSha256:'cd82f63c8daec29ede96b9f9686fe5ea9530c8728efaa699984ddb16288ef652',nativeSha256:'939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3'})
  const store=join(root,label+'-clean');await mkdir(store);await writeFile(join(store,'input.json'),JSON.stringify({payload}))
  const positive=await runPredecessor(graph,label+'-clean',writer,store,receipt.packages,{receipt,native},format)
  expect(positive.kind).toBe('ready');expect(positive.operationError).toBeUndefined();expect(positive.cleanup).toEqual({status:'fulfilled'});expect(positive.receipt).toBeDefined();expect(positive.counts.prepareBootstrapHeader).toBeGreaterThan(0)
  const stageName=(await readdir(store)).find(name=>name.endsWith('.stage'))!,stage=await readFile(join(store,stageName))
  expect(JSON.parse(stage.toString())).not.toHaveProperty('captureReservation')
  await writeFile(join(root,label+'-positive.json'),JSON.stringify({positive,stageName,stage:stage.toString('base64'),target:(await readFile(join(store,'target.jsonl'))).toString('base64')},null,2))
  graphs.push({label,format,graph,receipt,native,positive,stageName,stage})
 }
 expect(graphs.length).toBe(selected?.length??4)
 for(const graph of graphs){
  const vulnerabilities=[]
  for(const [shape,bytes] of supplement||coldOnly?[]:[['zero',Buffer.alloc(0)],['common-prefix',graph.stage.subarray(0,16)]] as const){
   const store=join(root,graph.label+'-same-key-'+shape);await mkdir(store);await writeFile(join(store,'input.json'),JSON.stringify({payload}));await writeFile(join(store,graph.stageName),bytes)
   const result=await runPredecessor(graph.graph,graph.label+'-same-key-'+shape,writer,store,graph.receipt.packages,graph,graph.format)
   expect(result.operationError).toBeUndefined()
   if(shape==='zero'&&graph.format!==11){
    expect(result.kind).toBe('blocked');expect(result.reason).toBe('unknown');expect(result.cleanup.status).toBe('rejected');expect(JSON.stringify(result.cleanup.error)).toContain('FACT_RECOVERY_REQUIRED')
    expect(await readFile(join(store,graph.stageName))).toEqual(bytes);expect((await readdir(store)).includes('target.jsonl')).toBe(false)
   }else{expect(result.kind).toBe('ready');expect(result.cleanup).toEqual({status:'fulfilled'})}
   vulnerabilities.push({shape,kind:result.kind,reason:result.reason,cleanup:result.cleanup,counts:result.counts,operations:result.operations})
  }
  if(!supplement&&!coldOnly)expect(vulnerabilities.some(row=>row.kind==='ready')).toBe(true)
  await writeFile(join(root,graph.label+'-same-key-controls.json'),JSON.stringify(vulnerabilities,null,2))
  for(const shape of coldOnly?[]:['complete','empty','one-byte','common-prefix','oversize','torn','future'] as const)for(const invocation of ['same','different'] as const){
   const stageBytes=shape==='complete'?full:shape==='empty'?Buffer.alloc(0):shape==='one-byte'?Buffer.from('{'):shape==='common-prefix'?reservationBytes.subarray(0,16):shape==='oversize'?Buffer.alloc(262145,32):shape==='torn'?full.subarray(0,full.length-1):Buffer.from(canonicalJsonData({...reservation,version:2})+'\n')
   const store=join(root,graph.label+'-'+shape+'-'+invocation);await mkdir(store)
   const changed=invocation==='same'?payload:{...payload,invocation:{...payload.invocation,operationId:'different',requestDigest:'c'.repeat(64)}}
   for(const method of selectedMethods){const target=join(store,method);await mkdir(target);await writeFile(bootstrapPathsForRoute(join(target,'target.jsonl'),{protocol:'child-v1',request}).stage,stageBytes)}
   await writeFile(join(store,'input.json'),JSON.stringify({payload:changed,methods:selectedMethods}))
   const before=await Promise.all(selectedMethods.map(method=>inventory(join(store,method))))
   const result=await runPredecessor(graph.graph,graph.label+'-'+shape+'-'+invocation,`${getInput}${oldRequest}
const results=[];
for(const method of input.methods){const target=resolve(store,method),backend=backendFor(target),coordinator=persistence.createSessionCoordinator(backend,{lock:{enabled:true}}),start=operations.length,prior={...counts};let outcome,error,captureInvocation,inapplicable=false;
try{if(method==='inspect')outcome=await coordinator.inspectBootstrap(request.invocation);
else if(method==='capture-inspect'||method==='capture-inspect-valid'){if(typeof coordinator.inspectBootstrapCapture!=='function')inapplicable=true;else{const core=persistence.readForkRequestCore({version:1,kind:'session-fork-core',sourceSessionId:'parent',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{}}),intent=persistence.createBootstrapRequestIntent(core,{kind:'unmanaged'});captureInvocation=method==='capture-inspect'?request.invocation:{...request.invocation,requestDigest:intent.requestDigest};outcome=await coordinator.inspectBootstrapCapture({invocation:captureInvocation,core,requestIntent:intent.intent})}}
else if(method==='read')outcome=await backend.read('target');
else if(method==='snapshot'){if(typeof coordinator.snapshot!=='function')inapplicable=true;else outcome=await coordinator.snapshot('target')}
else if(method==='repair')outcome=await backend.repair('target');
else if(method==='create')outcome=await coordinator.create({sessionId:'target'});
else if(method==='bootstrap')outcome=await coordinator.bootstrapSemanticTarget(request,guards);
else if(method==='resume')outcome=await coordinator.resumeSemanticTarget(request.invocation,guards,request);
else if(method==='resume-payloadless')outcome=await coordinator.resumeSemanticTarget(request.invocation,guards);
else outcome=await coordinator[method]('target');}catch(e){error=errorRecord(e)}
process.stdout.write(JSON.stringify({event:'operation-before-cleanup',method,inapplicable,outcome:outcome?.kind,error})+'\\n');const cleanup=await cleanupCoordinator(coordinator);
const actual=operations.slice(start),protectedWrites=actual.filter(row=>row.paths.some(path=>path===resolve(target,'target.jsonl')||path.startsWith(resolve(target,'target.jsonl')+'.bootstrap-')));
const record={method,inapplicable,outcome:outcome?.kind,error,captureInvocation,cleanup,counts:Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key]-prior[key]])),operations:actual,protectedWrites};results.push(record);
if(protectedWrites.length||['ready','already-ready'].includes(outcome?.kind))throw Error('FORBIDDEN foreign-stage mutation '+JSON.stringify(record));
}console.log(JSON.stringify({results,resolved}));`,store,graph.receipt.packages,{receipt:graph.receipt,native:graph.native},graph.format)
   expect(result.results).toHaveLength(selectedMethods.length)
   for(const row of result.results){expect(row.protectedWrites).toEqual([]);expect(row.counts).toMatchObject({fetch:0,provider:0,capture:0,source:0,model:0,prepareBootstrapHeader:0});if(['bootstrap','resume','resume-payloadless','snapshot'].includes(row.method))expect(row.inapplicable).toBe(false)}
   const after=await Promise.all(selectedMethods.map(method=>inventory(join(store,method))))
   await writeFile(join(store,'inventory.json'),JSON.stringify({before,after},null,2))
   const protectedOnly=(rows:Awaited<ReturnType<typeof inventory>>) => rows.filter(row=>row.name==='target.jsonl'||row.name.startsWith('target.jsonl.bootstrap-'))
   expect(after.map(protectedOnly)).toEqual(before.map(protectedOnly))
  }
  // Genuine public predecessor birth, including original initial input. The
  // separate unchanged codec2 predecessor population covers exported V1 seeds.
  const originalTarget=await readFile(join(root,graph.label+'-clean','target.jsonl'))
  for(const shape of ['ready','header-only','torn'] as const){
   const store=join(root,graph.label+'-cold-'+shape);await mkdir(store);await writeFile(join(store,graph.stageName),graph.stage)
   const end=originalTarget.indexOf(10),cut=shape==='ready'?originalTarget.length:shape==='header-only'?end+1:end+24;await writeFile(join(store,'target.jsonl'),originalTarget.subarray(0,cut))
   const coordinator=createSessionCoordinator(createJsonlBackend(store),{lock:{enabled:true}})
   try{const resumed=await coordinator.resumeSemanticTarget(graph.positive.request.invocation,guards,graph.positive.request);expect(resumed.kind).toBe(shape==='ready'?'already-ready':'ready');const after=await readFile(join(store,'target.jsonl'));expect(JSON.parse(after.subarray(0,after.indexOf(10)).toString())).toEqual({...JSON.parse(originalTarget.subarray(0,end).toString()),formatVersion:13});expect(after.subarray(after.indexOf(10)+1)).toEqual(originalTarget.subarray(end+1));expect(await readFile(join(store,graph.stageName))).toEqual(graph.stage);if(resumed.kind==='ready'||resumed.kind==='already-ready'){expect(resumed.receipt.initial).toMatchObject({inputId:'input',startedAt:1,expiresAt:11});await writeFile(join(store,'recovery.json'),JSON.stringify({shape,receipt:resumed.receipt,original:originalTarget.toString('base64'),after:after.toString('base64')},null,2))}}finally{await coordinator.close()}
  }
 }
},600000)
