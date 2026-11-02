import {registerAskUserInput} from '@i-harness/interaction'
import {registerWeb,createWebCache,type WebAccessMode} from '../../web/src/index.ts'
import {registerToolSearch} from '../../tool-search/src/index.ts'
import {createSessionQueryTools,type SessionQuery} from '../../session-query/src/index.ts'
import {createReadImageTool} from '../../attachment/src/index.ts'
import {createReadVideoTool,type VideoAudioAnalyzer} from '../../media/src/index.ts'
import type {Tool} from '@i-harness/core-tools'
import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'

/** Original default stateless leaf constructors; caller supplies the same
 * configured query, analyzer and additional tool owners as the complete host. */
export function mountOwnedGatewayLeaves(original:ManagedRegistryConstruction,options:{
 workspace:string; webCacheRoot:string; webSearchMode:WebAccessMode|(()=>WebAccessMode)
 sessionQuery:SessionQuery; videoAudioAnalyzer:VideoAudioAnalyzer; additionalTools:readonly Tool[]
}) {
 original.assertCurrent()
 registerWeb(original.ctx,original.tools,{mode:options.webSearchMode,cache:createWebCache({root:options.webCacheRoot,scope:options.workspace})})
 registerAskUserInput(original.ctx,original.tools)
 registerToolSearch(original.ctx,original.tools)
 for(const tool of createSessionQueryTools(options.sessionQuery))original.tools.register(tool)
 for(const tool of options.additionalTools)original.tools.register(tool)
 original.tools.register(createReadImageTool({workspace:options.workspace}))
 original.tools.register(createReadVideoTool({workspace:options.workspace,analyzeAudio:options.videoAudioAnalyzer}))
 original.assertCurrent()
}
