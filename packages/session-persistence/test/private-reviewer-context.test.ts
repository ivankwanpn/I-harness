import {expect,it,vi} from 'vitest'
const fault=vi.hoisted(()=>({close:false}))
vi.mock('../src/execution-internal.ts',async load=>{const original=await load<typeof import('../src/execution-internal.ts')>();return {...original,associateExecutionDependencies(backend:object,open:Parameters<typeof original.associateExecutionDependencies>[1]){original.associateExecutionDependencies(backend,(...args)=>{const scope=open(...args);return Object.freeze({assertCurrent:scope.assertCurrent.bind(scope),readEvent:scope.readEvent.bind(scope),async close(){if(fault.close)throw Error('controlled reviewer scope close');await scope.close()}})})}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createManagedExecutionDomain,captureManagedReviewerContext,assertOriginalManagedReviewerContext,assertOriginalManagedActionSource} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'

it('retains only the original reviewer tail and latest user for the same live action',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-reviewer-context-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});await coordinator.append('parent',[{type:'turn/start'},{type:'user/message',text:'original user intent'},...Array.from({length:14},()=>({type:'sandbox/mode' as const,mode:'workspace-write' as const}))])
 const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{}),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),foreign=execution.owner.beginAction(),review=captureManagedReviewerContext(domain,action)
 try{
  expect(()=>review.events).toThrow();await review.ready;assertOriginalManagedReviewerContext(domain,review)
  assertOriginalManagedActionSource(domain,action,source);expect(()=>assertOriginalManagedActionSource(domain,foreign,source)).toThrow();expect(()=>assertOriginalManagedActionSource(domain,action,{...source})).toThrow()
  expect(review.events).toHaveLength(12);expect(review.latestUser).toMatchObject({type:'user/message',text:'original user intent',seq:1});expect(review.events[0]?.seq).toBe(execution.observe().eventCount-12);expect(review.identity).toBe(execution.identity)
  expect(()=>assertOriginalManagedReviewerContext(domain,{...review})).toThrow()
  expect(()=>review.authorizeAudit({kind:'original-managed-approval-audit'})).toThrow()
  await action.facts.metadata.admit({type:'sandbox/mode',mode:'read-only'});expect(()=>review.assertCurrent()).toThrow();await review.close()
  fault.close=true;const failed=captureManagedReviewerContext(domain,action);await expect(failed.ready).rejects.toThrow('controlled reviewer scope close');expect(()=>domain.assertCurrent()).toThrow();fault.close=false;await failed.close();domain.assertCurrent()
  const stopped=captureManagedReviewerContext(domain,action);await stopped.ready;action.stop();expect(()=>stopped.assertCurrent()).toThrow();await stopped.close()
 }finally{fault.close=false;await review.close();await source.close();foreign.finish();action.finish();await coordinator.close()}
 expect(()=>review.events).toThrow()
},20000)
