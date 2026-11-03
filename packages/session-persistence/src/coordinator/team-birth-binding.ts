import {canonicalJsonData,freezeJsonData,type SessionEventView} from '@i-harness/core-session'
import {bootstrapInitialInputDigest} from '@i-harness/core-session/internal/bootstrap'
import {bootstrapHash} from '../semantic-seed.ts'
import {bootstrapFields,captureBootstrapRequest,initialAdmission,sameBootstrapData} from './bootstrap-header.ts'
import {captureChildBootstrapCaptureRequest,childRoleDigest,type ChildBootstrapCaptureRequest} from './child-bootstrap-intent.ts'
import {captureTaskSnapshot} from './task-document-snapshot.ts'
import type {BootstrapRequest} from './bootstrap-types.ts'

/** Canonical data only; original coordinator ownership and native ACK confer authority. */
export interface TeamBirthRoleSnapshot {name:string;description:string;systemPrompt:string;tools:string[];ephemeral?:boolean;model?:{provider:string;model:string}}
export interface TeamBirthBindingInput {parentSessionId:string;provisioning:Extract<SessionEventView,{type:'team/member'}>;request:ChildBootstrapCaptureRequest;initial:NonNullable<BootstrapRequest['initial']>;role:TeamBirthRoleSnapshot}
export interface TeamBirthBinding extends TeamBirthBindingInput {version:1;kind:'team-birth-binding';requestDigest:string;payloadDigest:string;digest:string}
const MAX_BINDING_BYTES=64*1024*1024
const invalid=():never=>{throw new TypeError('Invalid Team birth binding')}
const safeId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\\/\u0000-\u001f\u007f]/.test(value)&&!value.includes('..')
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256
const same=(a:unknown,b:unknown)=>sameBootstrapData(a,b)
export function teamBirthBindingKey(parentSessionId:string,memberId:string):string {
 if(!safeId(parentSessionId)||!safeId(memberId))invalid()
 return 'team-birth-'+bootstrapHash('ih.team.birth-key.v1',[parentSessionId,memberId])
}
function captureInput(input:unknown):TeamBirthBindingInput {
 const value=captureTaskSnapshot(input);bootstrapFields(value,['parentSessionId','provisioning','request','initial','role'])
 const {parentSessionId,provisioning,initial,role}=value,request=captureChildBootstrapCaptureRequest(value.request)
 if(!safeId(parentSessionId))invalid()
 bootstrapFields(provisioning,['type','version','teamId','member','seq'],['ignorable']);const member=provisioning.member
 bootstrapFields(member,['id','sessionId','name','description','provider','context','phase'])
 if(provisioning.type!=='team/member'||provisioning.version!==1||!safeId(provisioning.teamId)||!safeId(member.id)||member.sessionId!==member.id||!safeId(member.name)||typeof member.description!=='string'||typeof member.provider!=='string'||!member.provider||!['fresh','fork'].includes(member.context)||member.phase!=='provisioning'||!Number.isSafeInteger(provisioning.seq)||provisioning.seq<0||provisioning.ignorable!==undefined&&typeof provisioning.ignorable!=='boolean')invalid()
 const core=request.core
 if(core.caller.kind!=='team'||core.caller.teamId!==provisioning.teamId||core.caller.memberId!==member.id||request.invocation.targetSessionId!==member.id||core.lineage.origin!=='team'||core.lineage.parentSession!==parentSessionId||member.context==='fresh'&&core.history.selection.kind!=='none')invalid()
 bootstrapFields(initial,['inputId','text','startedAt','expiresAt','parentSessionId'])
 if(!id(initial.inputId)||typeof initial.text!=='string'||!initial.text||!Number.isSafeInteger(initial.startedAt)||initial.startedAt<0||!Number.isSafeInteger(initial.expiresAt)||initial.expiresAt<=initial.startedAt||initial.parentSessionId!==parentSessionId)invalid()
 const admitted=initialAdmission({initial:initial as NonNullable<BootstrapRequest['initial']>})??invalid()
 const commitment={inputId:initial.inputId,digest:bootstrapInitialInputDigest(admitted,initial.startedAt,initial.expiresAt),startedAt:initial.startedAt,expiresAt:initial.expiresAt,parentSessionId}
 if(!same(commitment,core.initial))invalid()
 bootstrapFields(role,['name','description','systemPrompt','tools'],['ephemeral','model'])
 if(typeof role.name!=='string'||!role.name||typeof role.description!=='string'||typeof role.systemPrompt!=='string'||!Array.isArray(role.tools)||!role.tools.every((name:unknown)=>typeof name==='string'&&name.length>0)||role.ephemeral!==undefined&&typeof role.ephemeral!=='boolean')invalid()
 if(role.model!==undefined){bootstrapFields(role.model,['provider','model']);if(typeof role.model.provider!=='string'||!role.model.provider||typeof role.model.model!=='string'||!role.model.model)invalid()}
 if(role.name!==core.execution.roleName||childRoleDigest(role)!==core.execution.roleDigest||!same(role.tools,core.execution.toolNames))invalid()
 return freezeJsonData({parentSessionId,provisioning,request,initial,role}) as TeamBirthBindingInput
}
function capturePayload(input:TeamBirthBindingInput,payload:BootstrapRequest):BootstrapRequest {
 const request=captureBootstrapRequest(payload),core=input.request.core
 if(request.target.kind!=='new'||!same(request.invocation,input.request.invocation)||!same(request.metadata,core.metadata)||!same(request.lineage,core.lineage)||!same(request.initial,input.initial))invalid()
 if(core.history.selection.kind==='none'){if(request.seed.records.length!==0)invalid()}
 else {const manifest=request.seed.records[0];if(!manifest||manifest.type!=='conversation/seed-manifest'||!same(manifest.selection,core.history.selection))invalid()}
 return request
}
export function createTeamBirthBinding(input:unknown,payload:BootstrapRequest):TeamBirthBinding {
 const captured=captureInput(input),originalPayload=capturePayload(captured,payload),base={version:1 as const,kind:'team-birth-binding' as const,...captured,requestDigest:captured.request.invocation.requestDigest,payloadDigest:bootstrapHash('ih.team.birth-payload.v1',originalPayload)}
 return freezeJsonData({...base,digest:bootstrapHash('ih.team.birth-binding.v1',base)}) as TeamBirthBinding
}
export function captureTeamBirthBinding(input:unknown):TeamBirthBinding {
 const data=captureTaskSnapshot(input);bootstrapFields(data,['version','kind','parentSessionId','provisioning','request','initial','role','requestDigest','payloadDigest','digest'])
 if(data.version!==1||data.kind!=='team-birth-binding'||typeof data.payloadDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.payloadDigest))invalid()
 const captured=captureInput({parentSessionId:data.parentSessionId,provisioning:data.provisioning,request:data.request,initial:data.initial,role:data.role}),base={version:1 as const,kind:'team-birth-binding' as const,...captured,requestDigest:captured.request.invocation.requestDigest,payloadDigest:data.payloadDigest},expected=freezeJsonData({...base,digest:bootstrapHash('ih.team.birth-binding.v1',base)}) as TeamBirthBinding
 if(!same(data,expected))invalid();return expected
}
/** Verify the exact retained native payload, including the complete fork seed. */
export function assertTeamBirthPayload(binding:TeamBirthBinding,payload:BootstrapRequest):void {
 const original=captureTeamBirthBinding(binding),request=capturePayload(original,payload)
 if(bootstrapHash('ih.team.birth-payload.v1',request)!==original.payloadDigest)invalid()
}
export function encodeTeamBirthBinding(binding:TeamBirthBinding):Uint8Array{const bytes=Buffer.from(canonicalJsonData(captureTeamBirthBinding(binding))+'\n','utf8');if(bytes.byteLength>MAX_BINDING_BYTES)invalid();return bytes}
export function parseTeamBirthBinding(bytes:Uint8Array):TeamBirthBinding {
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_BINDING_BYTES)invalid();let text:string,value:unknown
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text)}catch{return invalid()}
 const binding=captureTeamBirthBinding(value);if(text!==canonicalJsonData(binding)+'\n')invalid();return binding
}
