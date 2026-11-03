import { expect,it,vi } from 'vitest'
const boundary=vi.hoisted(()=>({requires:[] as string[],loads:[] as string[],signatures:[] as string[]}))
vi.mock('node:module',()=>({createRequire:()=>((name:string)=>{boundary.requires.push(name);return {load:(dll:string)=>{boundary.loads.push(dll);return {func:(signature:string)=>{boundary.signatures.push(signature);return ()=>1}}}}})}))
import { win32ArtifactApi } from '../src/win32-artifact-api.ts'
it('keeps import lazy and binds the actual fixed synchronous native ABI once',()=>{
  expect(boundary.requires).toEqual([]);expect(boundary.loads).toEqual([]);const api=win32ArtifactApi();expect(win32ArtifactApi()).toBe(api);expect(Object.isFrozen(api)).toBe(true);expect(boundary.requires).toEqual(['koffi']);expect(boundary.loads).toEqual(['kernel32.dll']);expect(boundary.signatures).toEqual([
    'void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)',
    'int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)',
    'uint32_t __stdcall GetFinalPathNameByHandleW(void *, void *, uint32_t, uint32_t)',
    'int __stdcall LCMapStringEx(str16, uint32_t, str16, int, void *, int, void *, void *, intptr_t)',
    'int __stdcall CloseHandle(void *)','uint32_t __stdcall GetLastError()',
  ])
})
