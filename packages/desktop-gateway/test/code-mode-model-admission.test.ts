import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from '@i-harness/sdk';
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts';
import { createDesktopHost } from '../src/host.ts';
import { createHostFixtureModel } from './host-fixture-model.ts';
it.each(['wait', 'close'] as const)('admits the original model Code call through the Desktop project and instruction assembly: %s', async (mode) => {
    const wire = (delta: unknown, finishReason: string) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`;
    const server = await createLoopbackProvider('/v1/chat/completions', [
        async (response) => {
            response.end(wire({ tool_calls: [{ index: 0, id: 'original-code', function: {
                            name: 'code_exec', arguments: JSON.stringify({ code: [
                                    'let sum = 0',
                                    'for (let n = 1; n <= 100; n++) sum += n',
                                    'text(sum)',
                                ].join('\n'), yield_time_ms: 0 }),
                        } }] }, 'tool_calls'));
        },
        async (response, request) => {
            if (mode === 'close') {
                response.end(wire({ content: 'done' }, 'stop'));
                return;
            }
            const messages = request.body.messages as Array<{
                role: string;
                content: string;
            }>;
            const message = messages.findLast(value => value.role === 'tool');
            if (!message)
                throw Error('Original Code tool result missing');
            const raw = JSON.parse(message.content);
            const output = raw.retention?.kind === 'inline' ? raw.retention.value : raw;
            if (output.status !== 'running')
                throw Error('Original running Code observation required');
            response.end(wire({ tool_calls: [{ index: 0, id: 'original-wait', function: {
                            name: 'code_wait', arguments: JSON.stringify({ cell_id: output.cell_id, yield_time_ms: 1000 }),
                        } }] }, 'tool_calls'));
        },
        async (response) => { response.end(wire({ content: 'done' }, 'stop')); },
    ]);
    let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined;
    let primary: {
        cause: unknown;
    } | undefined;
    try {
        const root = await mkdtemp(join(tmpdir(), 'ih-desktop-code-admission-'));
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        await writeFile(join(workspace, 'AGENTS.md'), 'Use Code Mode for arithmetic. Preserve the original tool result.\n');
        const settingsPath = join(root, 'settings.json');
        const credentialsPath = join(root, 'credentials.json');
        await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', codeMode: { mode: 'mixed' }, llm: {
                providers: { fixture: { protocol: 'openai-completions', baseURL: `${server.baseUrl}/v1`, apiKeyEnv: 'IH_CODE_ADMISSION_FIXTURE', models: [{ id: 'fixture', contextWindow: 272000 }] } },
                defaultModel: { provider: 'fixture', model: 'fixture' },
            } }));
        await writeFile(credentialsPath, JSON.stringify({ refs: { IH_CODE_ADMISSION_FIXTURE: 'loopback-only' } }));
        const frames: RpcMessage[] = [];
        let nextId = 0;
        const rpc = async (method: string, params: Record<string, unknown> = {}) => {
            const id = ++nextId;
            await host!.handleLine(encodeFrame(makeRequest(id, method, params)));
            const response = frames.find(frame => 'id' in frame && frame.id === id);
            if (!isRpcSuccess(response))
                throw Error(`Desktop fixture RPC ${method} failed: ${JSON.stringify(response)}`);
            return response.result;
        };
        host = await createDesktopHost({ workspace, settingsPath, credentialsPath, sessionDir: join(root, 'sessions'),
            buildProviderClient: createHostFixtureModel(server.baseUrl), onWrite: frame => frames.push(frame) });
        await rpc('initialize');
        const { sessionId } = await rpc('session/create') as {
            sessionId: string;
        };
        await rpc('desktop/session/project/bind', { sessionId });
        await rpc('session/prompt', { sessionId, prompt: 'Compute the sum from 1 to 100 using code_exec.' });
        const initialMessages = server.requests[0]!.body.messages as Array<{ role: string; content: unknown }>;
        expect(JSON.stringify(initialMessages)).toContain('Use Code Mode for arithmetic.');
        let events: Array<{
            type: string;
            name?: string;
            state?: string;
            kind?: string;
            envelope?: unknown;
        }>;
        if (mode === 'close') {
            const message = (server.requests[1]!.body.messages as Array<{
                role: string;
                content: string;
            }>).findLast(value => value.role === 'tool')!;
            const raw = JSON.parse(message.content);
            expect(raw.retention?.kind === 'inline' ? raw.retention.value : raw).toMatchObject({ status: 'running' });
            await host.close();
            host = undefined;
            const records = (await readFile(join(root, 'sessions', `${sessionId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
            events = records.flatMap(record => record.events ?? []);
            expect(events.filter(event => event.type === 'code/cell' && ['completed', 'terminated'].includes(event.state ?? ''))).toHaveLength(1);
            expect(events.filter(event => event.type === 'code/end')).toHaveLength(1);
        }
        else {
            events = (await rpc('session/history', { sessionId, afterSeq: 0, limit: 200 }) as {
                events: typeof events;
            }).events;
        }
        const result = events.find(event => event.type === 'tool/result' && event.name === 'code_exec');
        expect(result).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' } } });
        expect(events.filter(event => event.type === 'agent/delivery-source' && event.kind === 'code')).toHaveLength(1);
        expect(events.filter(event => event.type === 'code/cell' && event.state === 'started')).toHaveLength(1);
        if (mode === 'wait')
            expect(events.filter(event => event.type === 'code/cell' && event.state === 'completed')).toHaveLength(1);
        expect(events.filter(event => event.type === 'code/cell' && ['interrupted', 'failed'].includes(event.state ?? ''))).toEqual([]);
        expect(server.errors).toEqual([]);
        expect(server.requests).toHaveLength(mode === 'wait' ? 3 : 2);
        if (mode === 'close')
            return;
        expect(events.filter(event => event.type === 'code/output')).toHaveLength(1);
        expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1);
        const toolMessage = (server.requests[2]!.body.messages as Array<{
            role: string;
            content: string;
        }>).findLast(message => message.role === 'tool');
        expect(toolMessage).toBeDefined();
        const raw = JSON.parse(toolMessage!.content);
        expect(raw.retention?.kind === 'inline' ? raw.retention.value : raw).toMatchObject({ status: 'completed' });
        expect(events.find(event => event.type === 'code/output')).toMatchObject({ envelope: { preview: '5050', retention: { kind: 'artifact', ref: { completeness: 'complete', encodedBytes: 6 } } } });
    }
    catch (cause) {
        primary = { cause };
    }
    finally {
        const failures: unknown[] = [];
        try {
            await host?.close();
        }
        catch (cause) {
            failures.push(cause);
        }
        try {
            await server.close();
        }
        catch (cause) {
            failures.push(cause);
        }
        if (primary && !failures.length)
            throw primary.cause;
        if (failures.length)
            throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original Desktop fixture cleanup failed', { cause: primary?.cause });
    }
}, 30000);
