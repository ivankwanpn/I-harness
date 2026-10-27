import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// An absent explicit runtime is an honest platform qualification skip. Once
// configured, missing/invalid runtime, override or provenance is a hard failure.
it.skipIf(!process.env.IH_FORK_ELECTRON_PATH)('real hidden Electron invoke uses production preload/IPC/adapters and actual restarted Gateway operations', async () => {
  const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url))), packageRoot = join(repoRoot, 'packages/desktop')
  const executable = process.env.IH_FORK_ELECTRON_PATH
  const provenancePath = process.env.IH_FORK_ELECTRON_PROVENANCE
  if (!executable || !process.env.ELECTRON_OVERRIDE_DIST_PATH || !provenancePath) throw new Error('Task-safe explicit Electron executable, override and provenance are required')
  const provenance: unknown = JSON.parse(await readFile(provenancePath, 'utf8'))
  if (!provenance || typeof provenance !== 'object' || !('executableSha256' in provenance) || typeof provenance.executableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(provenance.executableSha256)) throw new Error('Electron provenance executableSha256 is invalid')
  expect(createHash('sha256').update(await readFile(executable)).digest('hex')).toBe(provenance.executableSha256)
  const root = await mkdtemp(join(tmpdir(), 'ih-fork-ipc-')), artifacts = join(packageRoot, '.f1c-checks/ipc')
  await mkdir(artifacts, { recursive: true })
  const mainSource = join(packageRoot, 'test/helpers/fork-ipc-entry.ts'), renderer = join(artifacts, 'renderer.js'), html = join(artifacts, 'renderer.html'), loader = join(artifacts, 'loader.cjs')
  const preload = join(packageRoot, 'out/preload/index.cjs')
  const preloadBytes = await readFile(preload)
  await build({ entryPoints: [join(packageRoot, 'test/helpers/fork-ipc-renderer.ts')], outfile: renderer, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130' })
  await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"></head><body><script src="./renderer.js"></script></body></html>')
  await writeFile(loader, `const fs=require('node:fs'),path=require('node:path'),url=require('node:url');const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const app=require('electron').app;fs.mkdirSync(path.join(config.root,'user-data'),{recursive:true});app.setPath('userData',path.join(config.root,'user-data'));app.disableHardwareAcceleration();const fail=error=>{fs.writeFileSync(config.output,JSON.stringify({ok:false,loaderError:String(error),stack:error&&error.stack}));app.exit(1)};process.on('uncaughtException',fail);process.on('unhandledRejection',fail);const {tsImport}=require(${JSON.stringify(join(repoRoot, 'node_modules/tsx/dist/esm/api/index.cjs'))});tsImport(url.pathToFileURL(${JSON.stringify(mainSource)}).href,{parentURL:url.pathToFileURL(__filename).href,tsconfig:${JSON.stringify(join(packageRoot, 'tsconfig.json'))}}).catch(fail);`)
  const output = join(root, 'receipts.json'), config = join(root, 'config.json')
  await writeFile(config, JSON.stringify({ root, repoRoot, preload, renderer: html, output }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [loader, config], { cwd: packageRoot, env, windowsHide: true, stdio: 'pipe' })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit({ code, signal })) })
  await writeFile(join(root, 'electron-exit.json'), JSON.stringify(exit))
  await writeFile(join(root, 'electron.stdout.log'), stdout); await writeFile(join(root, 'electron.stderr.log'), stderr)
  const result = JSON.parse(await readFile(output, 'utf8'))
  await writeFile(join(root, 'build-receipts.json'), JSON.stringify({ executable, override: process.env.ELECTRON_OVERRIDE_DIST_PATH, windowsHide: true, runAsNodeRemoved: !('ELECTRON_RUN_AS_NODE' in env),
    preload, preloadSha256: createHash('sha256').update(preloadBytes).digest('hex'), mainEntrySourceSha256: createHash('sha256').update(await readFile(mainSource)).digest('hex'), ipcSourceSha256: createHash('sha256').update(await readFile(join(packageRoot, 'src/main/ipc.ts'))).digest('hex'), rendererSha256: createHash('sha256').update(await readFile(renderer)).digest('hex'), exit }, null, 2))
  console.info(JSON.stringify({ control: 'real Electron production fork IPC', root, exit, ok: result.ok, error: result.error ?? result.loaderError, children: result.children }))
  expect(result, 'Actual Electron fixture receipts at ' + root).toMatchObject({ ok: true, electron: '44.4.5', sandboxed: true, contextIsolation: true })
  expect(exit).toEqual({ code: 0, signal: null }); expect(result.children).toHaveLength(2)
  expect(result.children.every((child: { code: number; signal: string | null }) => child.code === 0 && child.signal === null)).toBe(true)
  expect(result.targets).toHaveLength(2)
  expect(dirname(preload)).toBe(join(packageRoot, 'out/preload'))
}, 120000)
