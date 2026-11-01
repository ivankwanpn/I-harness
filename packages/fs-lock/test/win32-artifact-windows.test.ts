import { expect,it } from 'vitest'
const enabled=process.platform==='win32'&&process.env.IH_FS_LOCK_WINDOWS_QUALIFY==='1'
it.skipIf(!enabled)('qualifies original Windows artifact metadata and owned Node publication',async()=>{
  const {qualifyWindowsArtifactMetadata}=await import('./fixtures/windows-artifact-metadata.ts')
  const result=await qualifyWindowsArtifactMetadata();expect(result.report.cleanup.complete).toBe(true);expect(result.report.cases.some(c=>c.name==='root-replacement-currentness'&&c.status==='passed')).toBe(true);console.log(`Windows artifact evidence: ${result.tracePath}`)
})
