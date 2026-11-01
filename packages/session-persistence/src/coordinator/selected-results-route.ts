import { bootstrapFields, captureBootstrapInvocation } from './bootstrap-header.ts'
import { bootstrapHash } from '../semantic-seed.ts'
import { captureSelectedResultsCaptureRequest, type SelectedResultsCaptureRequestV1 } from './selected-results-intent.ts'
import type { BootstrapInvocation } from './bootstrap-types.ts'

export type SelectedResultsRoute = Readonly<{protocol:'public-results-v1';request:SelectedResultsCaptureRequestV1}>
export function captureSelectedResultsRoute(input:unknown):SelectedResultsRoute {
 bootstrapFields(input,['protocol','request'])
 if(input.protocol!=='public-results-v1') throw new TypeError('Invalid selected results route')
 return Object.freeze({protocol:'public-results-v1',request:captureSelectedResultsCaptureRequest(input.request)})
}
export function selectedBootstrapPathKey(invocation:BootstrapInvocation):string {
 return bootstrapHash('ih.bootstrap.selected-results.path.v1',captureBootstrapInvocation(invocation))
}
