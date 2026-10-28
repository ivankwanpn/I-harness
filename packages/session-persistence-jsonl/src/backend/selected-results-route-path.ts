import { captureSelectedResultsRoute, childBootstrapPathKey, selectedBootstrapPathKey, type SelectedResultsRoute } from '@i-harness/session-persistence'
import { bootstrapPaths, type StagePaths } from './bootstrap-stage.ts'

export function selectedBootstrapPaths(path:string,input:SelectedResultsRoute):StagePaths {
 const route=captureSelectedResultsRoute(input), invocation=route.request.invocation
 const key=selectedBootstrapPathKey(invocation), publicPaths=bootstrapPaths(path,invocation), childKey=childBootstrapPathKey(invocation)
 const paths={stage:`${path}.bootstrap-${key}.stage`,promote:`${path}.bootstrap-${key}.promote`,publish:`${path}.bootstrap-${key}.publish`}
 const childStage=`${path}.bootstrap-${childKey}.stage`
 if(paths.stage===publicPaths.stage || paths.stage===childStage || publicPaths.stage===childStage) throw new TypeError('Bootstrap path collision')
 return paths
}
