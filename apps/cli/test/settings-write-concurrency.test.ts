import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { acquireSessionLock } from '@i-harness/fs-lock'

const driver = fileURLToPath(new URL('./fixtures/config-writer.mjs', import.meta.url))
const loader = pathToFileURL(resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'node_modules/tsx/dist/loader.mjs')).href
const roots: string[] = [], children: Writer[] = []
type Message = { event: string; code?: number; error?: string }
type Writer = {
  child: ChildProcess
  exited: Promise<number | null>
  wait(event: string): Promise<Message>
  waitAny(events: string[]): Promise<Message>
  send(message: string): void
  output(): string
}
function start(root: string, args: string[], gate = true): Writer {
  const child: ChildProcess = fork(driver, args, { cwd: root, env: { ...process.env, IH_CONFIG_DIR: root, IH_TEST_GATE_LOAD: gate ? '1' : '0' }, execArgv: ['--import', loader], silent: true })
  const messages: Message[] = [], listeners = new Set<() => void>()
  let output = ''
  child.stdout?.on('data', bytes => { output = (output + bytes).slice(-16000) })
  child.stderr?.on('data', bytes => { output = (output + bytes).slice(-16000) })
  child.on('message', message => { messages.push(message as Message); for (const listener of listeners) listener() })
  const exited = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
  const waitAny = (events: string[]) => new Promise<Message>((accept, reject) => {
    const check = () => { const found = messages.find(message => events.includes(message.event)); if (found) { listeners.delete(check); accept(found) } }
    listeners.add(check); check()
    void exited.then(code => { if (!messages.some(message => events.includes(message.event))) { listeners.delete(check); reject(Error(`Writer exited ${code} before ${events}: ${output}`)) } }, reject)
  })
  const send = (message: string) => { if (child.connected) child.send(message) }
  const writer = { child, exited, wait: (event: string) => waitAny([event]), waitAny, send, output: () => output }
  children.push(writer)
  return writer
}
afterEach(async () => {
  for (const writer of children.splice(0)) {
    writer.send('go'); writer.send('continue'); writer.send('key')
    const timer = setTimeout(() => writer.child.kill(), 2000)
    try { await writer.exited } finally { clearTimeout(timer) }
  }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-cli-settings-lease-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-cli-settings-lease-')); roots.push(root)
  const settings = { autoTitle: false, extension: { retained: true }, plugins: { subagentModel: true }, agents: { roles: { research: { provider: 'keep', model: 'original' }, worker: { provider: 'old', model: 'old', protocol: 'anthropic-messages', reasoningEffort: 'high' } } }, llm: { providers: { fixture: { displayName: 'Original provider', baseURL: 'https://fixture.invalid', protocol: 'openai-completions', models: [{ id: 'existing' }] } }, defaultModel: { provider: 'fixture', model: 'existing' } } }
  await writeFile(join(root, 'settings.json'), JSON.stringify(settings))
  return { root, settings, read: async () => JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) }
}
async function pair(root: string, first: string[], second: string[]) {
  const a = start(root, first); await a.wait('ready'); a.send('go'); await a.wait('loaded')
  const b = start(root, second); await b.wait('ready'); b.send('go')
  const competing = await b.waitAny(['loaded', 'lease-waiting'])
  a.send('continue'); expect(await a.exited, a.output()).toBe(0)
  if (competing.event === 'lease-waiting') await b.wait('loaded')
  b.send('continue'); expect(await b.exited, b.output()).toBe(0)
  // A real native contention edge, rather than a sleep, proves the second
  // process could not derive its edit from the first process's old snapshot.
  expect(competing.event).toBe('lease-waiting')
}

it.each([
  { name: 'distinct roles', first: ['roles', 'set', 'general', '--provider', 'one', '--model', 'a'], second: ['roles', 'set', 'explore', '--provider', 'two', '--model', 'b'] },
  { name: 'set and unset', first: ['roles', 'unset', 'worker'], second: ['roles', 'set', 'explore', '--provider', 'two', '--model', 'b'] },
  { name: 'same-entry replacement', first: ['roles', 'set', 'worker', '--provider', 'one', '--model', 'a', '--protocol', 'anthropic-messages'], second: ['roles', 'set', 'worker', '--provider', 'two', '--model', 'b'] },
])('serializes separate-process $name without losing other roles or settings', async ({ name, first, second }) => {
  const f = await fixture(); await pair(f.root, first, second)
  const saved = await f.read()
  expect(saved.agents.roles.research).toEqual(f.settings.agents.roles.research)
  expect(saved.llm.providers.fixture).toEqual(f.settings.llm.providers.fixture)
  expect(saved).toMatchObject({ autoTitle: false, extension: { retained: true } })
  if (name === 'distinct roles') expect(saved.agents.roles).toMatchObject({ general: { provider: 'one', model: 'a' }, explore: { provider: 'two', model: 'b' } })
  if (name === 'set and unset') { expect(saved.agents.roles.worker).toBeUndefined(); expect(saved.agents.roles.explore.model).toBe('b') }
  if (name === 'same-entry replacement') expect(saved.agents.roles.worker).toEqual({ provider: 'two', model: 'b' })
}, 30000)

it.each([
  { name: 'provider siblings', first: ['provider', 'add', 'alpha', '--base-url', 'https://alpha.invalid', '--protocol', 'openai-completions'], second: ['provider', 'add', 'beta', '--base-url', 'https://beta.invalid', '--protocol', 'openai-completions'] },
  { name: 'model siblings', first: ['models', 'add', 'fixture', 'alpha'], second: ['models', 'add', 'fixture', 'beta'] },
  { name: 'role and provider', first: ['roles', 'set', 'general', '--provider', 'one', '--model', 'a'], second: ['provider', 'add', 'alpha', '--base-url', 'https://alpha.invalid', '--protocol', 'openai-completions'] },
])('cooperates across separate-process $name edits', async ({ name, first, second }) => {
  const f = await fixture(); await pair(f.root, first, second)
  const saved = await f.read()
  expect(saved.agents.roles.research).toEqual(f.settings.agents.roles.research)
  expect(saved).toMatchObject({ autoTitle: false, extension: { retained: true } })
  if (name === 'provider siblings') expect(Object.keys(saved.llm.providers)).toEqual(expect.arrayContaining(['fixture', 'alpha', 'beta']))
  if (name === 'model siblings') expect(saved.llm.providers.fixture.models.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining(['existing', 'alpha', 'beta']))
  if (name === 'role and provider') { expect(saved.agents.roles.general.model).toBe('a'); expect(saved.llm.providers.alpha).toBeDefined() }
}, 30000)

it.each(['corrupt', 'unreadable'] as const)('releases the native role lease on %s read failure and permits the next process to save', async mode => {
  const f = await fixture()
  const file = join(f.root, 'settings.json')
  if (mode === 'corrupt') await writeFile(file, '{ corrupt')
  else { await unlink(file); await mkdir(file) }
  const failed = start(f.root, ['roles', 'set', 'general', '--provider', 'one', '--model', 'a'], false)
  await failed.wait('ready'); failed.send('go'); expect(await failed.exited).toBe(1)
  if (mode === 'corrupt') expect(await readFile(file, 'utf8')).toBe('{ corrupt')
  else { expect((await stat(file)).isDirectory()).toBe(true); await rmdir(file) }
  await writeFile(file, JSON.stringify(f.settings))
  const next = start(f.root, ['roles', 'set', 'general', '--provider', 'one', '--model', 'a'], false)
  await next.wait('ready'); next.send('go'); expect(await next.exited, next.output()).toBe(0)
  expect((await f.read()).agents.roles.general.model).toBe('a')
}, 30000)

it('releases the role lease after the actual mutation refuses a changed corrupt saved base', async () => {
  const f = await fixture(), file = join(f.root, 'settings.json')
  const writer = start(f.root, ['roles', 'unset', 'worker'])
  await writer.wait('ready'); writer.send('go'); await writer.wait('loaded')
  await writeFile(file, '{ changed by a noncooperating writer')
  writer.send('continue'); expect(await writer.exited).toBe(1)
  expect(await readFile(file, 'utf8')).toBe('{ changed by a noncooperating writer')
  await writeFile(file, JSON.stringify(f.settings))
  const next = start(f.root, ['roles', 'unset', 'worker'], false)
  await next.wait('ready'); next.send('go'); expect(await next.exited, next.output()).toBe(0)
  expect((await f.read()).agents.roles.worker).toBeUndefined()
}, 30000)

it('does not recreate a custom provider removed by another process while key input is pending', async () => {
  const f = await fixture()
  const key = start(f.root, ['provider', 'key', 'fixture'], false)
  await key.wait('ready'); key.send('go'); await key.wait('key-input')
  const remove = start(f.root, ['provider', 'rm', 'fixture'], false)
  await remove.wait('ready'); remove.send('go'); expect(await remove.exited, remove.output()).toBe(0)
  key.send('key'); expect(await key.exited, key.output()).toBe(1)
  expect((await f.read()).llm.providers.fixture).toBeUndefined()
  await expect(readFile(join(f.root, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)

it('bounds a separate-process role lease wait without writing and succeeds after its real owner releases', async () => {
  const f = await fixture(), path = resolve(join(f.root, 'settings.json'))
  const lock = await acquireSessionLock({ lockPath: `${process.platform === 'win32' ? path.toLowerCase() : path}.provider.lock` })
  try {
    const blocked = start(f.root, ['roles', 'unset', 'worker'], false)
    await blocked.wait('ready'); blocked.send('go'); await blocked.wait('lease-waiting')
    expect(await blocked.exited).toBe(1)
    expect((await f.read()).agents.roles).toEqual(f.settings.agents.roles)
  } finally { await lock.release() }
  const next = start(f.root, ['roles', 'unset', 'worker'], false)
  await next.wait('ready'); next.send('go'); expect(await next.exited, next.output()).toBe(0)
  expect((await f.read()).agents.roles.worker).toBeUndefined()
}, 30000)
