import {expect,it} from 'vitest'
import * as codec from '../src/coordinator/team-birth-binding.ts'
import {compileSemanticSeed} from '../src/semantic-seed.ts'
import {captureChildBootstrapCore,captureChildBootstrapCaptureRequest,createChildBootstrapRequestIntent,childInitialCommitment,childRoleDigest} from '../src/coordinator/child-bootstrap-intent.ts'
import type {BootstrapRequest} from '../src/coordinator/bootstrap-types.ts'

function fixture(){
 const role={name:'teammate',description:'worker',systemPrompt:'work',tools:['read']},lineage={origin:'team' as const,parentSession:'parent',delegationDepth:1},initial={inputId:'input',text:'original prompt',startedAt:1,expiresAt:100,parentSessionId:'parent'}
 const payload:BootstrapRequest={invocation:{version:1,operationId:'op',targetSessionId:'member',createdAt:'2026-11-03T00:00:00.000Z',requestDigest:'0'.repeat(64)},target:{kind:'new'},metadata:{},lineage,seed:compileSemanticSeed({kind:'none'}),initial}
 const core=captureChildBootstrapCore({version:1,kind:'child-bootstrap-core',caller:{kind:'team',teamId:'team',memberId:'member'},history:{selection:{kind:'none'}},metadata:{},lineage,initial:childInitialCommitment(payload),execution:{roleName:role.name,roleDigest:childRoleDigest(role),toolNames:role.tools,model:{kind:'inherit-parent'},approval:'ordinary'}}),intent=createChildBootstrapRequestIntent(core,{kind:'unassigned'});payload.invocation={...payload.invocation,requestDigest:intent.requestDigest}
 const request=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:payload.invocation,core,requestIntent:intent.intent}),event={type:'team/member',version:1,teamId:'team',member:{id:'member',sessionId:'member',name:'helper',description:'worker',provider:'spawn',context:'fresh',phase:'provisioning'},seq:7}
 return {parentSessionId:'parent',provisioning:event,request,initial,role,payload}
}
it('captures one closed canonical Team birth binding and verifies the exact payload',()=>{
 const create=(codec as any).createTeamBirthBinding;expect(create).toBeTypeOf('function');const {payload,...input}=fixture(),binding=create(input,payload)
 expect((codec as any).captureTeamBirthBinding(binding)).toEqual(binding);expect((codec as any).parseTeamBirthBinding((codec as any).encodeTeamBirthBinding(binding))).toEqual(binding);expect(()=> (codec as any).assertTeamBirthPayload(binding,payload)).not.toThrow();expect((codec as any).teamBirthBindingKey('parent','member')).toMatch(/^team-birth-[a-f0-9]{64}$/)
})
it('rejects altered request, role, initial input, provisioning target and extra fields',()=>{
 const create=(codec as any).createTeamBirthBinding;expect(create).toBeTypeOf('function');const {payload,...input}=fixture(),binding=create(input,payload)
 for(const changed of [{...binding,extra:true},{...binding,payloadDigest:'f'.repeat(64)},{...binding,initial:{...binding.initial,text:'changed'}},{...binding,role:{...binding.role,tools:['write']}},{...binding,provisioning:{...binding.provisioning,member:{...binding.provisioning.member,sessionId:'other'}}},{...binding,request:{...binding.request,invocation:{...binding.request.invocation,requestDigest:'f'.repeat(64)}}}])expect(()=> (codec as any).captureTeamBirthBinding(changed)).toThrow()
 expect(()=> (codec as any).assertTeamBirthPayload(binding,{...payload,initial:{...payload.initial!,text:'changed'}})).toThrow();expect(()=> (codec as any).teamBirthBindingKey('../parent','member')).toThrow();expect(()=> (codec as any).parseTeamBirthBinding(Buffer.from(JSON.stringify(binding)))).toThrow();expect(()=> (codec as any).parseTeamBirthBinding(Uint8Array.of(255))).toThrow()
})

it('binds the exact fork seed rather than a later history with the same selection',async()=>{
 const {createSession,append,exportConversationSeed}=await import('@i-harness/core-session'),base=fixture(),makeSeed=(text:string)=>{const session=createSession();append(session,{type:'turn/start'});append(session,{type:'user/message',text});append(session,{type:'turn/end'});const seed=exportConversationSeed(session,{kind:'session',sessionId:'parent'},{kind:'all'});if(seed.kind!=='seed')throw Error('fixture seed unavailable');return compileSemanticSeed(seed)}
 const first=makeSeed('original fork'),later=makeSeed('later fork'),payload={...base.payload,seed:first},core=captureChildBootstrapCore({...base.request.core,history:{selection:{kind:'all'},source:{kind:'session',sessionId:'parent'}}}),intent=createChildBootstrapRequestIntent(core,{kind:'unassigned'}),invocation={...payload.invocation,requestDigest:intent.requestDigest};payload.invocation=invocation
 const request=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation,core,requestIntent:intent.intent}),input={parentSessionId:base.parentSessionId,provisioning:{...base.provisioning,member:{...base.provisioning.member,context:'fork'}},request,initial:base.initial,role:base.role},binding=(codec as any).createTeamBirthBinding(input,payload)
 expect(()=> (codec as any).assertTeamBirthPayload(binding,payload)).not.toThrow();expect(()=> (codec as any).assertTeamBirthPayload(binding,{...payload,seed:later})).toThrow()
})
