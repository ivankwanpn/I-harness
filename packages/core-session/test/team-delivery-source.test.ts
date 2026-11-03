import {expect,it} from 'vitest'
import {captureFactGroup} from '../src/managed/groups.ts'
import {createDeliveryIndex} from '../src/conversation/delivery.ts'

it('reserves Team provenance for the guarded source and requires a live generation',()=>{
 const admitted={type:'agent/input/admitted' as const,version:1 as const,inputId:'team-delivery-'+'a'.repeat(64),text:'message',delivery:'steer' as const,intent:'system' as const,provenance:{kind:'child-report' as const,authority:'observation' as const,scope:'turn' as const,producer:'session.delivery.team'},synthetic:{description:'Team message',scope:'turn' as const,display:{kind:'team-message' as const,title:'Team message',body:'message'}}}
 expect(captureFactGroup({kind:'input-admission',admitted})).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 expect(captureFactGroup({kind:'team-input-admission',admitted}).kind).toBe('captured')
 const stage=createDeliveryIndex({sessionId:'parent'}).stage();expect(()=>stage.advance({...admitted,seq:0})).toThrow('invalid Team delivery admission')
})
