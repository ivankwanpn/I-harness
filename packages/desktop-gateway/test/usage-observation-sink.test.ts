import {expect,it} from 'vitest'
import {createUsageObservationSink} from '../src/usage-observation-sink.ts'
import type {UsageObservationV1} from '@i-harness/usage-stats'
const fact=(source:'journal-fact'|'memory-committed'='journal-fact')=>({kind:'fact' as const,source,factSeq:3,event:{type:'context/action' as const,op:'open' as const,version:1 as const,ownerSessionId:'s',actionId:'a',purpose:'main' as const,origin:{kind:'input' as const,seq:0},startedAt:123,expiresAt:500,trustedAt:123,seq:3}})
it('maps original fact coordinates/time canonically and keeps memory provenance distinct',async()=>{
 const rows:UsageObservationV1[]=[],sink=createUsageObservationSink({async record(row){rows.push(row)}})
 sink.observer.capture(fact());sink.observer.capture(fact());sink.observer.capture(fact('memory-committed'));await sink.close()
 expect(rows).toHaveLength(3);expect(rows[0]).toEqual(rows[1]);expect(rows[0]!.observedAt).toBe(123)
 expect(rows[0]!.observationId).not.toBe(rows[2]!.observationId);expect(rows[2]!.source).toBe('memory-committed')
})
it('bounds queued and in-flight observations and joins original writer without retry or inference work',async()=>{
 const gate=Promise.withResolvers<void>();let writes=0
 const sink=createUsageObservationSink({capacity:1,async record(){writes++;await gate.promise;throw null}})
 sink.observer.capture(fact());await Promise.resolve();sink.observer.capture(fact());expect(sink.warnings().join()).toMatch(/saturated/)
 let closed=false;const closing=sink.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false)
 gate.resolve();await closing;expect(writes).toBe(1);expect(sink.warnings().join()).toMatch(/store-failed/)
 sink.observer.capture(fact());expect(sink.warnings().join()).toMatch(/admission-closed/)
})
