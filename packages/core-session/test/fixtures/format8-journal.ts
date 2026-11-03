import {append,createSession,toJSONL,type SessionEvent} from '../../src/index.ts'
/** Literal predecessor facts, including an unresolved reservation and references. */
export function format8Fixture(id='legacy') {
 const session=createSession();session.formatVersion=8
 session.header={sessionId:id,createdAt:'synthetic-format8',title:'keep predecessor',workspaceId:'fixture-workspace'} as typeof session.header
 const add=(event:object)=>append(session,event as SessionEvent),d='a'.repeat(64)
 add({type:'agent/input/admitted',version:1,inputId:'original',text:'/raw',delivery:'queue',intent:'user',preparationPolicy:'human-host',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
 add({type:'context/action',version:1,op:'open',ownerSessionId:id,actionId:'old-generation',purpose:'main',origin:{kind:'input',seq:0},startedAt:100,expiresAt:3600100,trustedAt:100})
 add({type:'context/action',version:1,op:'bind',executionDomain:'physical',ownerSessionId:id,actionId:'old-generation',retry:{mode:'normal',maxRetries:5},limits:{total:20,main:6,recovery:6,summary:8},trustedAt:100})
 const preparation={type:'agent/input/preparation',version:1,preparationId:'old-preparation',actionId:'old-generation',actionSeq:1,admissionSeq:0,inputId:'original'}
 add({...preparation,op:'started',startedAt:100});add({...preparation,op:'completed',observations:[{producer:'host-preparation',text:'retained expansion'}]})
 add({type:'context/attempt',version:1,op:'reserve',ownerSessionId:id,actionId:'old-generation',attemptId:'old-attempt',ordinal:1,lane:'main',cause:'initial',incarnation:'old-owner',semanticId:d,payloadId:d,payloadKind:'http-json-body',trustedAt:100})
 add({type:'context/result-ref',ignorable:true,ref:{id:'retained-reference',workspaceId:'fixture-workspace',sessionId:id,callId:'prior-result',label:'retained',revision:d,bytes:5,originalBytes:5,complete:true,expiresAt:4102444800000}})
 const raw=toJSONL(session),end=raw.indexOf('\n'),header={...JSON.parse(raw.slice(0,end)),extension:{keep:['metadata',8]},modelSelection:{provider:'synthetic',model:'m',futureLabel:'retain'}}
 return {session,raw:JSON.stringify(header)+raw.slice(end),header,body:raw.slice(end+1)}
}
