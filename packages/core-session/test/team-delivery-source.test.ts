import {expect,it} from 'vitest'
import {captureFactGroup} from '../src/managed/groups.ts'
import {createDeliveryIndex} from '../src/conversation/delivery.ts'
import { createNondurableFactOwner, createSession, encodeFactBatch, legacyPrefixDigest, readFactJournal, type SessionEvent } from '../src/index.ts'
import * as execution from '../src/execution-internal.ts'

it('refuses removed Team admission builders and malformed historical delivery',()=>{
 const admitted={type:'agent/input/admitted' as const,version:1 as const,inputId:'team-delivery-'+'a'.repeat(64),text:'message',delivery:'steer' as const,intent:'system' as const,provenance:{kind:'child-report' as const,authority:'observation' as const,scope:'turn' as const,producer:'session.delivery.team'},synthetic:{description:'Team message',scope:'turn' as const,display:{kind:'team-message' as const,title:'Team message',body:'message'}}}
 expect(captureFactGroup({kind:'input-admission',admitted})).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 expect(captureFactGroup({kind:'team-input-admission',admitted} as never)).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 const stage=createDeliveryIndex({sessionId:'parent'}).stage();expect(()=>stage.advance({...admitted,seq:0})).toThrow('invalid Team delivery admission')
})

it.each([13, 14])('reads format-%s Team event frames after removing Team execution APIs', formatVersion => {
 const events: SessionEvent[] = [
  { type: 'team/member', version: 1, teamId: 'saved-team', member: { id: 'child', name: 'saved-member', description: 'saved child', provider: 'fixture', context: 'fresh', phase: 'active', sessionId: 'child' }, seq: 0 },
  { type: 'team/task', version: 1, teamId: 'saved-team', task: { id: 'task', revision: 1, subject: 'saved work', description: 'saved details', status: 'completed', blockedBy: [], writeScopes: [] }, seq: 1 },
  { type: 'team/message/queued', version: 1, teamId: 'saved-team', message: { id: 'message', senderId: 'child', senderName: 'saved-member', targetId: 'saved-team', delivery: 'quiet', content: 'saved result' }, seq: 2 },
  { type: 'team/message/delivered', version: 1, teamId: 'saved-team', messageId: 'message', targetId: 'saved-team', seq: 3 },
 ]
 const previous = legacyPrefixDigest(0, new Uint8Array())
 const batch = encodeFactBatch('saved-team-batch', previous, events)
 const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }
 expect(readFactJournal(batch.bytes, metadata, formatVersion).events).toEqual(events)
 expect(captureFactGroup({ kind: 'team-transaction', events } as never)).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 expect(captureFactGroup({ kind: 'delivery', event: events[0] } as never)).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 expect(Object.keys(execution).filter(name => /Team/.test(name))).toEqual([])
 const action = createNondurableFactOwner(createSession()).beginAction()
 try { expect(Object.hasOwn(action, 'captureTeamTransaction')).toBe(false) }
 finally { action.finish() }
})
