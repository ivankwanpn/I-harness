import { expectTypeOf, it } from 'vitest'
import type { ResultsSummaryV1 } from '@i-harness/core-session'
import { checkBinding, checkRoot } from '../src/legacy/fork-codec.ts'
import type { LegacyBindingV1, LegacyBindingV2, LegacyRootV2, LegacyApplied, LegacyBinding, LegacyRoot, LegacyPage, LegacyRow } from '../src/legacy/fork-types.ts'
it('narrows required selected summaries and allowed row anchors from enclosing versions',()=>{
 expectTypeOf<Extract<LegacyRoot,{version:2}>['binding']['selectedResults']>().toEqualTypeOf<ResultsSummaryV1>()
 expectTypeOf<Extract<LegacyRoot,{version:1}>['binding']['selectedResults']>().toEqualTypeOf<undefined>()
 type V1Leaf=Extract<LegacyPage,{version:1;kind:'legacy-fork-leaf'}>
 type V2Leaf=Extract<LegacyPage,{version:2;kind:'legacy-fork-leaf'}>
 expectTypeOf<V1Leaf['rows'][number]['anchor']['kind']>().toEqualTypeOf<'manifest'|'seed-group'>()
 expectTypeOf<V2Leaf['rows'][number]['anchor']['kind']>().toEqualTypeOf<'seed-result'>()
})
// Type-only controls: invalid combinations must fail without runtime coercion.
function invalidFamilies(binding:LegacyBinding,row:LegacyRow){
 // @ts-expect-error A V2 root requires the selected result summary.
 const missing:LegacyRoot={version:2,kind:'legacy-fork-plan',binding:{...binding,selectedResults:undefined},observationCount:0,distinctRefCount:0,pages:null}
 // @ts-expect-error A V1 root forbids the selected result summary.
 const extra:LegacyRoot={version:1,kind:'legacy-fork-plan',binding:{...binding,selectedResults:{version:1,rows:0,pages:0,digest:'a'.repeat(64)}},observationCount:0,distinctRefCount:0,pages:null}
 // @ts-expect-error A V1 page cannot contain a selected result anchor.
 const old:LegacyPage={version:1,kind:'legacy-fork-leaf',bindingDigest:'a'.repeat(64),firstRow:0,rows:[{...row,anchor:{kind:'seed-result',manifestSeq:0,pageOrdinal:0,rowOrdinal:0}}]}
 // @ts-expect-error A V2 page cannot contain an old manifest anchor.
 const selected:LegacyPage={version:2,kind:'legacy-fork-leaf',bindingDigest:'a'.repeat(64),firstRow:0,rows:[{...row,anchor:{kind:'manifest',seq:0}}]}
 void [missing,extra,old,selected]
}
void invalidFamilies
function validatedVariants(input:unknown){
 expectTypeOf(checkBinding(input)).toEqualTypeOf<LegacyBindingV1>()
 expectTypeOf(checkBinding(input,2)).toEqualTypeOf<LegacyBindingV2>()
 expectTypeOf(checkRoot({version:2,kind:'legacy-fork-plan'})).toEqualTypeOf<LegacyRootV2>()
 expectTypeOf<Extract<LegacyApplied,{version:2}>['version']>().toEqualTypeOf<2>()
}
void validatedVariants
