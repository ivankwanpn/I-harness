import { expect, it } from 'vitest'
import { builtinRoles } from '../src/roles.ts'
it('adds native read capabilities to enabled builtin roles without giving exploration index mutations',()=>{
  const defaults=builtinRoles(), native=builtinRoles({nativeContext:true})
  expect(defaults.find(role=>role.name==='general')!.tools).not.toContain('context_output_read')
  for(const role of native) expect(role.tools).toEqual(expect.arrayContaining(['context_output_read','context_output_search','code_context_search']))
  expect(native.find(role=>role.name==='explore')!.tools).not.toContain('code_context_index')
  expect(native.find(role=>role.name==='worker')!.tools).toContain('code_context_index')
})
