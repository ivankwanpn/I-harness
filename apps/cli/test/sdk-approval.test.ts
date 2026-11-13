import { inspect } from 'node:util'
import { onTestFinished, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { HarnessClient } from '@i-harness/sdk'
import type { ChildProcess } from 'node:child_process'
import { sdkApprovesTools } from '../src/sdk-options.ts'

const repo = resolve(import.meta.dirname, '../../..')
const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
const expectedNative = 'literal-native\n' + 'N'.repeat(70000)
type Call = { name: string; args: Record<string, unknown> }
async function fixture(options: {
    yes?: 'before' | 'after';
    desktopFullAccess?: boolean;
    readOnly?: boolean;
    storeAsFile?: boolean;
    calls: (root: string) => Call[];
}) {
    let root = '';
    let workspace = '';
    let config = '';
    let store = '';
    let gate = '';
    let effect = '';
    let client: HarnessClient | undefined;
    let child: ChildProcess | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let exited: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }> | undefined;
    let args: string[] = [];
    let settingsText: string | undefined;
    let retired = false;
    let ready = false;
    let closeFlight: Promise<void> | undefined;
    let setupFailure: { name: string; message: string; code: unknown; cause: string } | undefined;
    const pending = new Set<Promise<unknown>>();
    const requests: unknown[] = [];
    const stderr: Buffer[] = [];
    const providerErrors: unknown[] = [];
    const started = performance.now();
    const phases: {
        stage: string;
        elapsedMs: number;
    }[] = [];
    const phase = (stage: string) => phases.push({
        stage,
        elapsedMs: performance.now() - started
    });
    function assertOpen() {
        if (retired)
            throw Error('Original SDK fixture retired');
    }
    function own<T>(stage: string, work: () => Promise<T>): Promise<T> {
        assertOpen();
        phase(stage + '-start');
        const flight = work();
        pending.add(flight);
        void flight.then(() => {
            pending.delete(flight);
            phase(stage + '-done');
        }, () => {
            pending.delete(flight);
            phase(stage + '-failed');
        });
        return flight;
    }
    function close(): Promise<void> {
        if (closeFlight)
            return closeFlight;
        retired = true;
        closeFlight = Promise.resolve().then(async () => {
            const failures: unknown[] = [];
            phase('close-start');
            if (gate)
                try {
                    await writeFile(gate, '');
                }
                catch (cause) {
                    failures.push(cause);
                }
            let clientClosed = false;
            if (client)
                try {
                    await client.close();
                    clientClosed = true;
                    phase('sdk-close-ack');
                }
                catch (cause) {
                    failures.push(cause);
                }
            // Cancel existing provider readers, then join setup/requests. A listen
            // already in flight may finish here; the retirement fence prevents spawn.
            try {
                server?.closeAllConnections();
            }
            catch (cause) {
                failures.push(cause);
            }
            while (pending.size)
                await Promise.allSettled([...pending]);
            // Close HTTP independently even when the actual SDK process refuses cleanup.
            if (server?.listening)
                try {
                    const original = server;
                    await new Promise<void>((done, reject) => {
                        original.close(error => error ? reject(error) : done());
                        original.closeAllConnections();
                    });
                }
                catch (cause) {
                    failures.push(cause);
                }
            let nativeExit: Awaited<NonNullable<typeof exited>> | undefined;
            if (child?.pid !== undefined) {
                if (clientClosed || child.exitCode !== null || child.signalCode !== null)
                    nativeExit = await exited;
                else
                    failures.push(Error('Original SDK child exit was not acknowledged'));
            }
            failures.push(...providerErrors);
            phase('resources-joined');
            if (root)
                try {
                    await writeFile(join(root, 'receipt.json'), JSON.stringify({
                        args,
                        cwd: workspace,
                        settings: settingsText ? JSON.parse(settingsText) : undefined,
                        requests,
                        nativeExit,
                        childState: child ? {
                            pid: child.pid,
                            exitCode: child.exitCode,
                            signalCode: child.signalCode,
                        } : undefined,
                        serverListening: server?.listening ?? false,
                        pendingOperations: pending.size,
                        setupFailure,
                        phases,
                        stderr: Buffer.concat(stderr).toString(),
                        effectExists: !!effect && existsSync(effect),
                        cleanup: inspect(failures, {
                            depth: 8
                        })
                    }, null, 2));
                    if (settingsText && existsSync(join(config, 'settings.json')))
                        expect(await readFile(join(config, 'settings.json'), 'utf8')).toBe(settingsText);
                    if (ready)
                        expect(nativeExit).toEqual({
                            code: 0, signal: null
                        });
                }
                catch (cause) {
                    failures.push(cause);
                }
            if (failures.length)
                throw new AggregateError(failures, 'Original SDK fixture resources require cleanup');
        });
        return closeFlight;
    }
    // Enroll per test before the first setup await; completion hooks close the SAME
    // original actors while initialization or an RPC is still outstanding.
    onTestFinished(close);
    try {
        root = await own('temp-root', () => mkdtemp(join(process.env.IH_A6_ROOT ?? tmpdir(), 'a-')));
        assertOpen();
        workspace = join(root, 'w');
        config = join(root, 'c');
        store = join(root, 's');
        gate = join(root, 'gate');
        effect = join(root, 'effect');
        await own('directories', () => Promise.all([mkdir(workspace), mkdir(config)]));
        assertOpen();
        const worker = join(workspace, 'worker.mjs');
        await own('worker-file', () => writeFile(worker, `import{appendFileSync,existsSync}from'node:fs';appendFileSync(process.argv[3],'once\\n');process.stdout.write('literal-native\\n'+'N'.repeat(70000));while(!existsSync(process.argv[2]))await new Promise(done=>setTimeout(done,10));process.exitCode=7;`));
        await own('read-fixture', () => writeFile(join(workspace, 'small.txt'), 'ordinary read-only literal 中文'));
        assertOpen();
        const calls = options.calls(root);
        let index = 0;
        server = createServer((req, res) => {
            const handling = (async () => {
                let raw = '';
                for await (const bytes of req)
                    raw += bytes;
                const body = JSON.parse(raw);
                requests.push(body);
                phase('provider-' + requests.length);
                const call = calls[index++];
                const id = 'approval-' + index;
                res.writeHead(200, {
                    'content-type': 'text/event-stream'
                });
                const delta = call ? {
                    tool_calls: [{
                            index: 0, id, type: 'function', function: {
                                name: call.name, arguments: JSON.stringify(call.args)
                            }
                        }]
                } : {
                    content: 'done'
                };
                res.end('data: ' + JSON.stringify({
                    choices: [{
                            delta, finish_reason: null
                        }]
                }) + '\n\ndata: ' + JSON.stringify({
                    choices: [{
                            delta: {}, finish_reason: call ? 'tool_calls' : 'stop'
                        }]
                }) + '\n\ndata: [DONE]\n\n');
            })();
            pending.add(handling);
            void handling.then(() => pending.delete(handling), cause => {
                pending.delete(handling);
                providerErrors.push(cause);
                res.destroy(cause instanceof Error ? cause : undefined);
            });
        });
        server.on('error', cause => providerErrors.push(cause));
        const originalServer = server;
        await own('listen', () => new Promise<void>((done, reject) => {
            originalServer.once('error', reject);
            originalServer.listen(0, '127.0.0.1', () => {
                originalServer.removeListener('error', reject);
                done();
            });
        }));
        assertOpen();
        const port = (server.address() as {
            port: number;
        }).port;
        const settings = {
            autoTitle: false, sandboxMode: options.readOnly ? 'read-only' : 'danger-full-access', ...(options.desktopFullAccess ? {
                approvalMode: 'full-access'
            } : {}), llm: {
                providers: {
                    fixture: {
                        protocol: 'openai-completions', baseURL: 'http://127.0.0.1:' + port, apiKeyEnv: 'FIXTURE_API_KEY', models: [{
                                id: 'fixture-model'
                            }]
                    }
                }, defaultModel: {
                    provider: 'fixture', model: 'fixture-model'
                }
            }
        };
        settingsText = JSON.stringify(settings);
        await own('settings', () => writeFile(join(config, 'settings.json'), settingsText!));
        assertOpen();
        await own('credentials', () => writeFile(join(config, 'credentials.json'), JSON.stringify({
            refs: {
                FIXTURE_API_KEY: 'fixture-key'
            }
        })));
        assertOpen();
        args = [
            '--import',
            loader,
            join(repo, 'apps/cli/src/index.ts'),
            'sdk',
            ...(options.yes === 'before' ? ['--yes'] : []),
            '--session-dir',
            store,
            ...(options.yes === 'after' ? ['--yes'] : [])
        ];
        if (options.storeAsFile) {
            await own('blocked-store', () => writeFile(store, 'owned setup failure'));
            assertOpen();
        }
        client = HarnessClient.spawn({
            command: process.execPath, args, cwd: workspace, env: {
                IH_CONFIG_DIR: config
            }
        });
        phase('spawn');
        const originalClient = client;
        child = Reflect.get(originalClient, 'child') as ChildProcess;
        child.stderr!.on('data', bytes => stderr.push(Buffer.from(bytes)));
        const originalChild = child;
        exited = originalChild.exitCode !== null || originalChild.signalCode !== null
            ? Promise.resolve({
                code: originalChild.exitCode, signal: originalChild.signalCode
            })
            : new Promise(done => originalChild.once('exit', (code, signal) => done({
                code, signal
            })));
        await own('initialize', () => originalClient.initialize());
        assertOpen();
        const sessionId = (await own('create-session', () => originalClient.createSession())).sessionId;
        assertOpen();
        ready = true;
        return {
            root, workspace, store, client: originalClient, sessionId, gate, effect, requests, close,
            run: (input: Parameters<HarnessClient['run']>[0]) => own('run', () => originalClient.run(input)),
            history: (...input: Parameters<HarnessClient['history']>) => own('history', () => originalClient.history(...input)),
            readResultPage: (...input: Parameters<HarnessClient['readResultPage']>) => own('result-page', () => originalClient.readResultPage(...input)),
            next(call: Call) {
                assertOpen();
                calls[index] = call;
            },
        };
    }
    catch (primary) {
        setupFailure = {
            name: primary instanceof Error ? primary.name : typeof primary,
            message: primary instanceof Error ? primary.message : String(primary),
            code: typeof primary === 'object' && primary !== null ? Reflect.get(primary, 'code') : undefined,
            cause: inspect(primary instanceof Error ? primary.cause : undefined, { depth: 8 }),
        };
        try {
            await close();
        }
        catch (cleanup) {
            throw new AggregateError([primary, cleanup], 'Original SDK setup and cleanup failed', {
                cause: primary
            });
        }
        throw primary;
    }
}

const nativeCalls = (root: string): Call[] => [{ name: 'pwsh', args: { command: '& "' + process.execPath + '" "' + join(root, 'w/worker.mjs') + '" "' + join(root, 'gate') + '" "' + join(root, 'effect') + '"; exit $LASTEXITCODE', background: true } }]
const resultOf = (events: any[]) => events.filter(event => event.type === 'tool/result')

it('joins the real SDK child and provider when an owned store file rejects setup', async () => {
  let observedRoot: string | undefined
  const failure = await fixture({
    yes: 'before',
    storeAsFile: true,
    calls(root) {
      observedRoot = root
      return nativeCalls(root)
    },
  }).then(
    async opened => {
      await opened.close()
      throw Error('A physical store file unexpectedly allowed SDK setup')
    },
    cause => cause,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(AggregateError)
  if (!(failure instanceof Error) || !observedRoot) throw Error('Original setup failure evidence unavailable')
  const receipt = JSON.parse(await readFile(join(observedRoot, 'receipt.json'), 'utf8'))
  expect(receipt.setupFailure).toMatchObject({ name: failure.name, message: failure.message })
  expect(receipt.setupFailure.code).toEqual(Reflect.get(failure, 'code'))
  expect(receipt.setupFailure.cause).toBe(inspect(failure.cause, { depth: 8 }))
  expect(receipt.childState.pid).toBeGreaterThan(0)
  expect(receipt.nativeExit).toEqual({
    code: receipt.childState.exitCode,
    signal: receipt.childState.signalCode,
  })
  expect(receipt.childState.exitCode !== null || receipt.childState.signalCode !== null).toBe(true)
  expect(receipt.serverListening).toBe(false)
  expect(receipt.pendingOperations).toBe(0)
  expect(receipt.requests).toEqual([])
  expect(receipt.effectExists).toBe(false)
  expect(await readFile(join(observedRoot, 's'), 'utf8')).toBe('owned setup failure')
  expect(await readFile(join(observedRoot, 'c/settings.json'), 'utf8')).toBe(JSON.stringify(receipt.settings))
  const stages = receipt.phases.map((phase: { stage: string }) => phase.stage)
  expect(stages.filter((stage: string) => stage === 'spawn')).toHaveLength(1)
  expect(stages.filter((stage: string) => stage === 'close-start')).toHaveLength(1)
  expect(stages.filter((stage: string) => stage === 'sdk-close-ack')).toHaveLength(1)
  expect(stages.filter((stage: string) => stage.endsWith('-failed'))).toHaveLength(1)
  expect(stages.filter((stage: string) => ['run-start', 'history-start', 'result-page-start'].includes(stage))).toEqual([])
}, 20000)

it.each(['before', 'after'] as const)('enables the actual original native producer only with SDK --yes (%s directory)', async yes => {
  const f = await fixture({ yes, calls: nativeCalls })
  try {
    await f.run({ sessionId: f.sessionId, prompt: 'start original native producer' })
    const event = resultOf((await f.history(f.sessionId)).events)[0]
    expect(event.envelope.retention.value.job_id).toMatch(/^bash-/)
    expect(event.envelope.dependencies).toBeUndefined()
    const deadline = Date.now() + 5000
    while (!existsSync(f.effect) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
    expect(existsSync(f.effect)).toBe(true); expect(existsSync(f.gate)).toBe(false)
    expect(await readFile(f.effect, 'utf8')).toBe('once\n')
    await writeFile(f.gate, '')
    f.next({ name: 'job_output', args: { job_id: event.envelope.retention.value.job_id, wait: true, timeout_ms: 5000 } })
    await f.run({ sessionId: f.sessionId, prompt: 'read the original completed native source' })
    const observed = resultOf((await f.history(f.sessionId)).events)[1]
    expect(observed.envelope.retention.value.status).toBe('error')
    const catalogRef = observed.envelope.dependencies.ref
    const catalogPage = await f.readResultPage(f.sessionId, { ref: catalogRef })
    if ('kind' in catalogPage || !('data' in catalogPage) || catalogPage.data.kind !== 'text') throw Error('Original native catalog unavailable')
    expect(catalogPage.eof).toBe(true)
    const catalog = JSON.parse(catalogPage.data.text), frame = catalog.entries[0].retention.ref
    expect(frame.completeness).toBe('complete')
    const bytes: Buffer[] = []; let cursor
    for (;;) {
      const page = await f.readResultPage(f.sessionId, { ref: frame, viaCatalog: catalogRef, cursor, maxBytes: 4096 })
      if ('kind' in page || !('frames' in page)) throw Error('Original native frame unavailable')
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      for (const part of page.frames) { expect(part.channel).toBe('stdout'); bytes.push(Buffer.from(part.data, 'base64')) }
      if (page.eof) break
      expect(page.nextCursor).not.toEqual(cursor); cursor = page.nextCursor!
    }
    const body = Buffer.concat(bytes)
    expect(body.toString()).toBe(expectedNative)
    expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(expectedNative).digest('hex'))
    expect(await readFile(f.effect, 'utf8')).toBe('once\n')
  } finally { await f.close() }
}, 20000)

it('recognizes standalone SDK consent without interpreting a consumed directory or -y as consent', () => {
  expect(sdkApprovesTools([])).toBe(false)
  expect(sdkApprovesTools(['--yes', '--session-dir', 'store'])).toBe(true)
  expect(sdkApprovesTools(['--session-dir', 'store', '--yes'])).toBe(true)
  expect(sdkApprovesTools(['--session-dir', '--yes'])).toBe(false)
  expect(sdkApprovesTools(['--session-dir', '--yes', '--session-dir', '--yes'])).toBe(false)
  expect(sdkApprovesTools(['-y'])).toBe(false)
  const result = spawnSync(process.execPath, ['--import', loader, join(repo, 'apps/cli/src/index.ts'), '--help'], { encoding: 'utf8', windowsHide: true })
  expect(result.status).toBe(0); expect(result.stdout).toBe('')
  const help = result.stderr
  expect(help).toContain('sdk [--session-dir DIR] [--session-store jsonl|commit-log] [--yes]')
  expect(help).toContain('explicit per-call sandbox escalation')
  expect(help).toContain('Without --yes, SDK tool approval requests fail closed')
  const invalid = spawnSync(process.execPath, ['--import', loader, join(repo, 'apps/cli/src/index.ts'), 'sdk', '--yes', '--session-dir'], { encoding: 'utf8', windowsHide: true })
  expect(invalid.status).toBe(1)
  expect(invalid.stderr).toContain('--session-dir requires a directory')
  expect(invalid.stdout).toBe('')
  // Both fresh CLI processes load the source graph before parsing arguments.
}, 20000)

it.each([false, true])('keeps no-flag SDK approval unanswered even with Desktop full-access=%s', async desktopFullAccess => {
  const f = await fixture({ desktopFullAccess, calls: nativeCalls })
  try {
    await expect(f.run({ sessionId: f.sessionId, prompt: 'must refuse native' })).rejects.toThrow('approval required but no answerer registered (fail closed)')
    expect(existsSync(f.effect)).toBe(false)
    expect(resultOf((await f.history(f.sessionId)).events)).toEqual([])
  } finally { await f.close() }
}, 20000)

it('keeps an ordinary read-only tool available without process consent', async () => {
  const f = await fixture({ readOnly: true, calls: root => [{ name: 'read', args: { path: join(root, 'w/small.txt') } }] })
  try {
    await f.run({ sessionId: f.sessionId, prompt: 'ordinary read-only control' })
    const result = resultOf((await f.history(f.sessionId)).events)[0]
    expect(result.envelope.retention.value).toEqual({ content: 'ordinary read-only literal 中文', instruction_scope: { status: 'queued' } })
    expect(result.envelope.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
    expect(existsSync(f.effect)).toBe(false)
  } finally { await f.close() }
}, 20000)

it('keeps ordinary read-only sandbox writes denied despite SDK consent', async () => {
  const f = await fixture({ yes: 'after', readOnly: true, calls: root => [{ name: 'write', args: { path: join(root, 'w/ordinary.txt'), text: 'must refuse' } }] })
  try {
    await f.run({ sessionId: f.sessionId, prompt: 'ordinary write' })
    expect(existsSync(join(f.workspace, 'ordinary.txt'))).toBe(false)
    const events = (await f.history(f.sessionId)).events
    expect(resultOf(events)[0].envelope.retention.value).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(JSON.parse(resultOf(events)[0].envelope.retention.value.error)).toMatchObject({ code: 'SANDBOX_DENIED', mode: 'read-only' })
    expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.mode)).toEqual(['read-only'])
  } finally { await f.close() }
}, 20000)

it('approves one explicit workspace-write escalation and leaves the next ordinary call read-only', async () => {
  const f = await fixture({ yes: 'after', readOnly: true, calls: root => [
    { name: 'write', args: { path: join(root, 'w/first.txt'), text: 'one', sandbox_permissions: 'workspace-write', justification: 'one task-owned fixture file' } },
    { name: 'write', args: { path: join(root, 'w/second.txt'), text: 'must refuse' } },
  ] })
  try {
    await f.run({ sessionId: f.sessionId, prompt: 'one transient explicit escalation' })
    expect(await readFile(join(f.workspace, 'first.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(f.workspace, 'second.txt'))).toBe(false)
    const events = (await f.history(f.sessionId)).events
    expect(resultOf(events)[0].envelope.retention.value).toMatchObject({ ok: true })
    expect(resultOf(events)[1].envelope.retention.value).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(JSON.parse(resultOf(events)[1].envelope.retention.value.error)).toMatchObject({ code: 'SANDBOX_DENIED', mode: 'read-only' })
    expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.mode)).toEqual(['read-only'])
  } finally { await f.close() }
}, 20000)

it('refuses explicit escalation without a process approval answerer', async () => {
  const f = await fixture({ readOnly: true, calls: root => [{ name: 'write', args: { path: join(root, 'w/no-consent.txt'), text: 'must refuse', sandbox_permissions: 'workspace-write', justification: 'requires actual consent' } }] })
  try {
    await f.run({ sessionId: f.sessionId, prompt: 'no explicit escalation consent' })
    expect(existsSync(join(f.workspace, 'no-consent.txt'))).toBe(false)
    const event = resultOf((await f.history(f.sessionId)).events)[0]
    expect(event.envelope.retention.value).toMatchObject({ code: 'SANDBOX_DENIED', denial: { code: 'SANDBOX_DENIED', mode: 'read-only', reason: 'sandbox escalation to "workspace-write" requires approval, but no approval channel is available' } })
  } finally { await f.close() }
}, 20000)
