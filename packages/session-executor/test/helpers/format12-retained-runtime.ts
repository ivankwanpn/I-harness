import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, realpath, symlink, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type * as TypeScript from 'typescript'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const defaultFixture = fileURLToPath(new URL('../fixtures/format12-retained-result-c76/', import.meta.url))
const predecessor = 'c76a56011e16057030c2fa7106d358b1eac99657'
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function safePath(path: unknown): asserts path is string {
  assert(typeof path === 'string' && /^[A-Za-z0-9_@.+=-]+(?:\/[A-Za-z0-9_@.+=-]+)*$/.test(path), 'Capsule path must be a strict relative path')
  assert(!path.split('/').some(part => part === '.' || part === '..'), 'Capsule path escape refused')
}
function within(root: string, target: string) {
  const path = relative(root, target)
  assert(path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep), 'Capsule target escaped its owner')
}
type ImportRow = { path: string; original?: string; external?: boolean; kind: string }
type SourceRow = { path: string; bytes: number; sha256: string; imports: ImportRow[]; gitBlob?: string }
interface Manifest {
  version: number; predecessor: string; archive: { path: string; bytes: number; sha256: string }
  sources: SourceRow[]; assets: SourceRow[]; driver: SourceRow
  dependencies: { name: string; version: string; packageRoot: string; packageJsonSha256: string; entries: { specifier: string; relativePath: string; sha256: string }[] }[]
  tooling: Record<'esbuild' | 'typescript', { name: string; version: string; packageRoot: string; packageJsonSha256: string; entry: { relativePath: string; sha256: string } }>
}
export interface Format12ValidationOptions { fixtureDirectory?: string; dependencyRoot?: string }
async function validate(options: Format12ValidationOptions) {
  const fixtureDirectory = resolve(options.fixtureDirectory ?? defaultFixture), dependencyRoot = await realpath(resolve(options.dependencyRoot ?? repository))
  const manifestBytes = await readFile(join(fixtureDirectory, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString()) as Manifest
  assert.equal(manifest.version, 1); assert.equal(manifest.predecessor, predecessor)
  assert.equal(manifest.sources.length, 765, 'Original graph absent or incomplete')
  assert.equal(manifest.archive.path, 'source.json.gz')
  assert.equal(manifest.assets.length, 1); assert.equal(manifest.assets[0]!.path, 'packages/provider/src/model-catalog.json')
  const rows = [...manifest.sources, ...manifest.assets, manifest.driver], seen = new Set<string>()
  for (const row of rows) {
    safePath(row.path); assert(row.path.startsWith('packages/')); assert(!seen.has(row.path), 'Duplicate capsule source')
    seen.add(row.path); assert(Number.isSafeInteger(row.bytes) && row.bytes > 0); assert(/^[a-f0-9]{64}$/.test(row.sha256))
    assert(Array.isArray(row.imports))
    for (const item of row.imports) if (!item.external) { safePath(item.path); assert(rows.some(candidate => candidate.path === item.path), 'Import graph target absent: ' + item.path) }
  }
  assert.equal(manifest.driver.path, 'packages/session-executor/test/helpers/format12-retained-producer.mts')
  const compressed = await readFile(join(fixtureDirectory, manifest.archive.path))
  assert.equal(compressed.length, manifest.archive.bytes); assert.equal(sha(compressed), manifest.archive.sha256, 'Corrupt predecessor capsule')
  const decoded = JSON.parse(gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }).toString()) as { version: number; files: { path: string; content: string }[] }
  assert.equal(decoded.version, 1); assert.equal(decoded.files.length, rows.length)
  const files = new Map<string, string>()
  for (const file of decoded.files) {
    safePath(file.path); assert(!files.has(file.path)); assert(typeof file.content === 'string')
    const row = rows.find(candidate => candidate.path === file.path); assert(row, 'Archive graph entry absent from manifest')
    assert.equal(Buffer.byteLength(file.content), row.bytes); assert.equal(sha(file.content), row.sha256, 'Captured source hash mismatch: ' + file.path)
    files.set(file.path, file.content)
  }
  for (const row of rows) assert(files.has(row.path), 'Captured source missing: ' + row.path)
  const directNames = new Set<string>(), dependencies = []
  for (const dependency of manifest.dependencies) {
    assert(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(dependency.name)); assert(!directNames.has(dependency.name)); directNames.add(dependency.name)
    safePath(dependency.packageRoot); assert(dependency.packageRoot.startsWith('node_modules/.pnpm/'))
    const packageRoot = await realpath(resolve(dependencyRoot, dependency.packageRoot)); within(join(dependencyRoot, 'node_modules'), packageRoot)
    const packageBytes = await readFile(join(packageRoot, 'package.json')), metadata = JSON.parse(packageBytes.toString())
    assert.equal(metadata.name, dependency.name, 'Wrong installed dependency name'); assert.equal(metadata.version, dependency.version, 'Wrong installed dependency version')
    assert.equal(sha(packageBytes), dependency.packageJsonSha256, 'Wrong installed dependency metadata hash')
    for (const entry of dependency.entries) {
      assert(entry.specifier === dependency.name || entry.specifier.startsWith(dependency.name + '/'), 'Dependency specifier owner mismatch')
      safePath(entry.relativePath); const path = resolve(packageRoot, entry.relativePath); within(packageRoot, path)
      assert.equal(sha(await readFile(path)), entry.sha256, 'Wrong installed dependency entry hash')
    }
    dependencies.push({ ...dependency, actualRoot: packageRoot })
  }
  const require = createRequire(join(dependencyRoot, 'package.json')), tooling = {} as Record<'esbuild' | 'typescript', { name: string; version: string; packageRoot: string; packageJsonPath: string; packageJsonSha256: string; entryPath: string; entrySha256: string }>
  for (const name of ['esbuild', 'typescript'] as const) {
    const expected = manifest.tooling[name]; assert.equal(expected.name, name, 'Wrong compiler package name')
    safePath(expected.packageRoot); assert(expected.packageRoot.startsWith('node_modules/.pnpm/'))
    const packageRoot = await realpath(resolve(dependencyRoot, expected.packageRoot)); within(join(dependencyRoot, 'node_modules'), packageRoot)
    const packageJsonPath = await realpath(require.resolve(name + '/package.json'))
    assert.equal(packageJsonPath, join(packageRoot, 'package.json'), 'Compiler metadata resolved outside selected root')
    const packageBytes = await readFile(packageJsonPath), metadata = JSON.parse(packageBytes.toString())
    assert.equal(metadata.name, name, 'Wrong compiler metadata name'); assert.equal(metadata.version, expected.version, 'Wrong compiler metadata version')
    assert.equal(sha(packageBytes), expected.packageJsonSha256, 'Wrong compiler metadata hash')
    safePath(expected.entry.relativePath)
    const entryPath = await realpath(require.resolve(name)); within(packageRoot, entryPath)
    assert.equal(entryPath, resolve(packageRoot, expected.entry.relativePath), 'Wrong selected compiler entry path')
    assert.equal(sha(await readFile(entryPath)), expected.entry.sha256, 'Wrong selected compiler entry hash')
    tooling[name] = { name, version: expected.version, packageRoot, packageJsonPath, packageJsonSha256: sha(packageBytes), entryPath, entrySha256: expected.entry.sha256 }
  }
  return { manifest, files, rows, dependencies, dependencyRoot, tooling, manifestSha256: sha(manifestBytes) }
}
/** Validates all sources/dependencies before any producer process is started. */
export async function validateFormat12RetainedCapsule(options: Format12ValidationOptions = {}) {
  const checked = await validate(options)
  return { predecessor, sources: checked.manifest.sources.length, archiveSha256: checked.manifest.archive.sha256, manifestSha256: checked.manifestSha256, tooling: checked.tooling }
}
export interface Format12ProducerOptions extends Format12ValidationOptions {
  /** Fresh, task-owned actual workspace/data root. Current readers use this same root. */
  root: string
  /** Fresh runtime artifacts remain here for diagnostics. Defaults beside root. */
  runtimeParent?: string
  timeoutMs?: number
}
/** Runs only the captured c76 source, then joins actual child close and streams.
 * Original logical close debt is preserved and requires the child's real exit73. */
export async function produceFormat12RetainedResult(options: Format12ProducerOptions) {
  const timeoutMs = options.timeoutMs ?? 45000; assert(timeoutMs > 0 && timeoutMs <= 60000)
  const checked = await validate(options), root = resolve(options.root)
  // Both APIs are loaded only after every selected package and entry passed validation.
  const require = createRequire(join(checked.dependencyRoot, 'package.json'))
  const esbuild = require(checked.tooling.esbuild.entryPath) as typeof import('esbuild')
  const ts = require(checked.tooling.typescript.entryPath) as typeof TypeScript
  assert.equal(esbuild.version, checked.tooling.esbuild.version, 'Executed esbuild API version mismatch')
  assert.equal(ts.version, checked.tooling.typescript.version, 'Executed TypeScript API version mismatch')
  await mkdir(root, { recursive: true }); assert.deepEqual(await readdir(root), [], 'Fresh producer data root required')
  const runtimeParent = resolve(options.runtimeParent ?? dirname(root)); await mkdir(runtimeParent, { recursive: true })
  const runtimeRoot = await mkdtemp(join(runtimeParent, 'format12-c76-runtime-')), sourceRoot = join(runtimeRoot, 'source')
  await mkdir(sourceRoot)
  for (const [path, content] of checked.files) {
    const target = resolve(sourceRoot, path); within(sourceRoot, target)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { flag: 'wx' })
  }
  for (const dependency of checked.dependencies) {
    const target = join(runtimeRoot, 'node_modules', dependency.name); within(runtimeRoot, target)
    await mkdir(dirname(target), { recursive: true }); await symlink(dependency.actualRoot, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const externalSpecifiers = new Set(checked.dependencies.flatMap(dependency => dependency.entries.map(entry => entry.specifier)))
  const graph = new Map(checked.rows.map(row => [row.path, row]))
  const moduleMetadata: { path: string; url: string; replacements: number; transformedSha256: string }[] = []
  const bundle = join(runtimeRoot, 'old-producer.mjs')
  const built = await esbuild.build({ entryPoints: [resolve(sourceRoot, checked.manifest.driver.path)], outfile: bundle, write: true, bundle: true, platform: 'node', format: 'esm', metafile: true, logLevel: 'silent', plugins: [{ name: 'captured-workspace-only', setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
      const path = relative(sourceRoot, args.path).replaceAll('\\', '/'), original = checked.files.get(path)
      assert(original !== undefined, 'Uncaptured compiler input: ' + path)
      const parsed = ts.createSourceFile(args.path, original, ts.ScriptTarget.Latest, true, args.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      let replacements = 0
      const url = pathToFileURL(args.path).href
      const transformed = ts.transform(parsed, [context => {
        const visit: TypeScript.Visitor = node => {
          if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.expression.name.text === 'meta') {
            assert(node.name.text === 'url' || node.name.text === 'dirname', 'Unsupported captured import.meta property')
            replacements++; return context.factory.createStringLiteral(node.name.text === 'url' ? url : dirname(args.path))
          }
          return ts.visitEachChild(node, visit, context)
        }
        return source => ts.visitNode(source, visit) as TypeScript.SourceFile
      }])
      const contents = replacements ? ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed.transformed[0]!) : original
      transformed.dispose()
      if (replacements) moduleMetadata.push({ path, url, replacements, transformedSha256: sha(contents) })
      return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
    })
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.kind === 'entry-point') {
        const path = resolve(args.path); within(sourceRoot, path)
        assert.equal(path, resolve(sourceRoot, checked.manifest.driver.path), 'Uncaptured entry point')
        return { path }
      }
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      if (args.path.startsWith('@i-harness/')) {
        const importer = relative(sourceRoot, args.importer).replaceAll('\\', '/'), row = graph.get(importer)
        assert(row, 'Uncaptured workspace importer: ' + importer)
        const edge = row.imports.find(item => !item.external && item.original === args.path)
        assert(edge && checked.files.has(edge.path), 'Uncaptured workspace import: ' + args.path)
        return { path: resolve(sourceRoot, edge.path) }
      }
      assert(externalSpecifiers.has(args.path), 'Undeclared third-party import: ' + args.path)
      return { path: args.path, external: true }
    })
  } }] })
  const bundledInputs = Object.keys(built.metafile!.inputs).map(path => relative(sourceRoot, resolve(path)).replaceAll('\\', '/')).sort()
  assert.deepEqual(bundledInputs, [...checked.manifest.sources.map(row => row.path), checked.manifest.driver.path].sort(), 'Bundled workspace graph changed')
  const residual = Object.values(built.metafile!.outputs).flatMap(output => output.imports).filter(item => item.external && item.path.startsWith('@i-harness/'))
  assert.deepEqual(residual, [], 'Residual workspace external refused')
  await writeFile(join(runtimeRoot, 'build-provenance.json'), JSON.stringify({ predecessor, manifestSha256: checked.manifestSha256, archiveSha256: checked.manifest.archive.sha256, sourceCount: checked.manifest.sources.length, tooling: { esbuild: { ...checked.tooling.esbuild, apiVersion: esbuild.version }, typescript: { ...checked.tooling.typescript, apiVersion: ts.version } }, driverSha256: checked.manifest.driver.sha256, bundleSha256: sha(await readFile(bundle)), compilerTransform: { tool: 'TypeScript', version: ts.version, operation: 'AST property access replacement only for import.meta.url/dirname, bound to each captured extracted module', modules: moduleMetadata.sort((a, b) => a.path.localeCompare(b.path)) }, bundledInputs, externalSpecifiers: [...externalSpecifiers].sort(), residualWorkspaceExternals: residual, graph: built.metafile }, null, 2))
  const env = { ...process.env }, roots: Record<string, string> = {}
  for (const [key, leaf] of Object.entries({ IH_CONFIG_DIR: 'config', IH_STRUCTURE_EVIDENCE_ROOT: 'structure', IH_RESULT_INTEGRITY_EVIDENCE_ROOT: 'result-integrity', IH_LEGACY_FORK_EVIDENCE_ROOT: 'legacy-fork', IH_MIXED_RETENTION_EVIDENCE_ROOT: 'mixed-retention', IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT: 'native-dependency', TEMP: 'temp', TMP: 'temp' })) {
    roots[key] = join(runtimeRoot, leaf); env[key] = roots[key]; await mkdir(roots[key], { recursive: true })
  }
  env.IH_FORMAT12_PRODUCER_ROOT = root; roots.IH_FORMAT12_PRODUCER_ROOT = root
  const cwd = join(sourceRoot, 'packages/session-executor')
  const child = spawn(process.execPath, [bundle], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  // Own error/close before checking the actual piped streams. Never substitute
  // streams or leave an owned child behind if the spawn contract is violated.
  void closed.catch(() => {})
  const stdoutPipe = child.stdout, stderrPipe = child.stderr
  if (!stdoutPipe || !stderrPipe) {
    child.kill(); await closed.catch(() => {})
    throw new Error('Owned original producer has no stdout/stderr pipes')
  }
  let stdout = '', stderr = '', timedOut = false
  const messages: any[] = []
  stdoutPipe.on('data', bytes => { stdout += bytes.toString() }); stderrPipe.on('data', bytes => { stderr += bytes.toString() }); child.on('message', message => messages.push(message))
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
  const disposition = await closed.finally(() => clearTimeout(timer))
  const processEvidence = { pid: child.pid, argv: [process.execPath, bundle], cwd, windowsHide: true, roots, ...disposition, timedOut, childCloseObserved: true, stdoutEnded: stdoutPipe.readableEnded, stderrEnded: stderrPipe.readableEnded, stdout, stderr, messages }
  await writeFile(join(runtimeRoot, 'process.json'), JSON.stringify(processEvidence, null, 2) + '\n')
  assert(!timedOut, 'Original producer deadline; evidence: ' + runtimeRoot)
  assert.equal(disposition.signal, null); assert.equal(disposition.code, 73, 'Original producer/cut failed; evidence: ' + runtimeRoot)
  assert(stdoutPipe.readableEnded && stderrPipe.readableEnded, 'Original child streams did not end')
  const expectedWarning = "[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"
  assert.equal(stderr.trim(), expectedWarning, 'Unexpected original producer diagnostic; evidence: ' + runtimeRoot)
  assert.equal(stdout, '', 'Unexpected original producer stdout; evidence: ' + runtimeRoot)
  assert(messages.some(message => message.type === 'original-process-cut' && message.pid === child.pid && message.code === 73 && message.primary === null), 'Original production did not finish before cut: ' + runtimeRoot)
  const exited = JSON.parse(await readFile(join(root, 'original-process-exit.json'), 'utf8'))
  assert.equal(exited.pid, child.pid); assert.equal(exited.code, 73)
  const observation = JSON.parse(await readFile(join(root, 'producer-observation.json'), 'utf8'))
  const expectedBody = await readFile(join(root, 'expected-body.json')), originalReadback = await readFile(join(root, 'original-readback.json'))
  assert(originalReadback.equals(expectedBody)); assert.equal(sha(expectedBody), observation.expectedDigest); assert(observation.pageCount > 1)
  // Independent raw verification begins only after the actual original writer
  // exited and its streams closed. The child evidence is a successful original
  // put's observed argument, not a substitute for this final original file.
  const savedBytes = await readFile(join(root, 'original-task-document.json')), saved = JSON.parse(savedBytes.toString())
  const writes = JSON.parse(await readFile(join(root, 'original-task-write-observations.json'), 'utf8')) as { phase: string; sequence: number; snapshot?: unknown }[]
  const savedWrite = writes.find(write => write.phase === 'original-strict-put-start' && JSON.stringify(write.snapshot) === JSON.stringify(saved) && writes.some(outcome => outcome.sequence === write.sequence && outcome.phase === 'original-strict-put-success'))
  assert(savedWrite, 'Observed original task snapshot has no successful strict write')
  const taskBytes = await readFile(join(root, 'sessions', 'task-' + observation.id + '.doc.jsonl')), document = JSON.parse(taskBytes.toString())
  assert.equal(document.formatVersion, 2); assert.equal(document.tasks.length, 1); assert.equal(document.notifications.length, 1)
  const task = document.tasks[0], notification = document.notifications[0]
  assert.equal(task.id, observation.taskId); assert.equal(task.parentSessionId, observation.id); assert.equal(task.status, 'completed'); assert.equal(task.delivery, 'parent')
  assert.equal(task.result.kind, 'retained'); assert.equal(task.result.envelope.retention.kind, 'artifact')
  assert.equal(task.result.revision, observation.revision); assert.deepEqual(task.result.envelope.retention.ref, observation.ref)
  assert.deepEqual(task.result, saved.tasks[0].result)
  assert.equal(notification.submissionId, task.id); assert.equal(notification.status, 'error'); assert.equal(notification.attempts, 1)
  assert.deepEqual(notification, saved.notifications[0])
  const journal = await readFile(join(root, 'sessions', observation.id + '.jsonl')), headerEnd = journal.indexOf(10)
  assert(headerEnd > 0); const header = JSON.parse(journal.subarray(0, headerEnd).toString()); assert.equal(header.formatVersion, 12)
  const ends: { offset: number; bytes: number; sha256: string; batchId: string; event: any }[] = []
  let cursor = headerEnd + 1, notificationAdmissions = 0
  while (cursor < journal.length) {
    const end = journal.indexOf(10, cursor); assert(end >= cursor, 'Incomplete original frame after writer exit')
    const bytes = journal.subarray(cursor, end + 1), frame = JSON.parse(bytes.toString()); assert.equal(frame.recordKind, 'session/fact-batch')
    for (const event of frame.events) {
      if (event.type === 'subagent/end') ends.push({ offset: cursor, bytes: bytes.length, sha256: sha(bytes), batchId: frame.batchId, event })
      if (event.type === 'agent/input/admitted' && event.inputId.startsWith('parent-notify-')) notificationAdmissions++
    }
    cursor = end + 1
  }
  assert.equal(ends.length, 1); assert.equal(notificationAdmissions, 0)
  const terminal = ends[0]!
  assert.equal(terminal.event.taskId, task.id); assert.equal(terminal.event.resultRevision, task.result.revision); assert.deepEqual(terminal.event.envelope, task.result.envelope)
  const postCloseVerification = { originalWriterExited: true, pid: child.pid, header, taskDocumentSha256: sha(taskBytes), savedObservationSha256: sha(savedBytes), savedWriteSequence: savedWrite.sequence, savedRetentionLabel: saved.tasks[0].retention, finalRetentionLabel: task.retention, journalSha256: sha(journal), terminal, notificationAdmissions }
  await writeFile(join(runtimeRoot, 'post-close-original-verification.json'), JSON.stringify(postCloseVerification, null, 2) + '\n')
  return { root, runtimeRoot, sessionId: observation.id as string, childSessionId: observation.childSessionId as string, taskId: observation.taskId as string, resultRevision: observation.revision as string, ref: observation.ref as Record<string, unknown>, expectedBody, observation, process: processEvidence, postCloseVerification }
}
