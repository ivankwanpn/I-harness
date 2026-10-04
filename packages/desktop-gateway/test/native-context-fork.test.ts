import {expect,it} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {append,createSession,rewindCuts} from '@i-harness/core-session'
import {createSessionCoordinator,forkSession} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createNativeContextRuntime} from '../src/context-runtime.ts'

it('grants only the real fork seed, survives disabled fork and origin clear, and excludes rewound/future results',async()=>{
  const base=resolve('build/native-fork-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'fork-'))
  const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')))
  await coordinator.create({sessionId:'parent'})
  const runtime=await createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,projectFor:async()=>({}),
    visibleRefsFor:async id=>{const session=(await coordinator.snapshot!(id)).session;const cuts=rewindCuts(session);return session.events.flatMap(event=>event.type==='context/result-ref'&&!cuts.some(cut=>event.seq!>=cut.cutFrom&&event.seq!<cut.markerSeq)?[event.ref]:[])}})
  try {
    await runtime.contextOutput.configure({enabled:true})
    const session=createSession()
    const capture=async(label:string)=>runtime.contextOutput.capture({sessionId:'parent',callId:label,label,text:label,complete:true,source:await runtime.sourceFor('parent')})
    const visible=(await capture('VISIBLE'))!,hidden=(await capture('HIDDEN'))!,future=(await capture('FUTURE'))!
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'first'});append(session,{type:'context/result-ref',ref:visible});append(session,{type:'turn/end'})
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'rewound'});append(session,{type:'context/result-ref',ref:hidden});append(session,{type:'turn/end'})
    append(session,{type:'rewind/point',version:1,targetTurn:2,anchorSeq:5,mode:'all',fileOps:[]})
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'new branch'});append(session,{type:'turn/end'})
    await coordinator.append('parent',session.events)
    await runtime.contextOutput.configure({enabled:false})
    const fork=await forkSession(coordinator,'parent')
    const refs=(await coordinator.snapshot!(fork.sessionId)).session.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    expect(refs.map(ref=>ref.id)).toEqual([visible.id])
    await runtime.inheritFork('parent',fork.sessionId,refs)
    await coordinator.append('parent',[{type:'turn/start',seq:12},{type:'context/result-ref',ref:future,seq:13},{type:'turn/end',seq:14}])
    await runtime.contextOutput.clear('parent');await runtime.contextOutput.configure({enabled:true})
    expect((await runtime.contextOutput.read({sessionId:fork.sessionId},{refId:visible.id})).text).toBe('VISIBLE')
    for(const ref of [hidden,future])await expect(runtime.contextOutput.read({sessionId:fork.sessionId},{refId:ref.id})).rejects.toThrow()
    expect((await runtime.contextOutput.search({sessionId:fork.sessionId},{query:'VISIBLE'})).hits).toHaveLength(1)
  } finally {await runtime.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
