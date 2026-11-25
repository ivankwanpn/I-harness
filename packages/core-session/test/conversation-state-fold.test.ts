import { expect, it, vi } from 'vitest';
import { createSession, append, projectConversation, readConversationState } from '../src/index.ts';
import { createConversationStateIndex, readIndexedConversationState } from '../src/conversation/state.ts';
import { conversationVisibility } from '../src/conversation/visibility.ts';
import { archiveConversationSources, createConversationSourceCoordinates, retainConversationSourceCoordinates } from '../src/conversation/sources.ts';
import { eventArchive } from '../src/conversation/archive.ts';
import { readDeliveries } from '../src/conversation/delivery.ts';
import * as contextData from '../src/serialization/context-data.ts';
it('original state fold preserves complete archive, unresolved delegation and original protection without event bodies', () => {
    const session = createSession();
    append(session, { type: 'turn/start' });
    append(session, { type: 'user/message', text: 'task'.repeat(200) });
    append(session, { type: 'step/start' });
    append(session, { type: 'assistant/message', text: 'accepted body'.repeat(200) });
    append(session, { type: 'subagent/start', version: 1, taskId: 'pending', agentPath: '/child', role: 'research', description: 'pending' });
    append(session, { type: 'step/end' });
    append(session, { type: 'turn/end' });
    const index = createConversationStateIndex();
    for (const event of session.events)
        index.stage([event]).commit();
    const coordinates = createConversationSourceCoordinates().stage(session.events).commit();
    const sources = archiveConversationSources(eventArchive(session.events), 'owner', [], { coordinates });
    const projection = projectConversation(session, { ownerSessionId: 'owner' }), options = { visibility: conversationVisibility(session), sources, delivery: readDeliveries(session), seedEnd: 0 };
    const result = readIndexedConversationState(index.read(), projection, options);
    expect(result).toEqual(readConversationState(session, projection));
    expect(result).toMatchObject({ kind: 'available', state: { archive: { eventCount: 7, lastSeq: 6 }, unsettledDelegationIds: ['pending'] } });
    if (result.kind === 'available')
        expect(result.state).not.toHaveProperty('turnSourceId');
    expect(() => readIndexedConversationState({}, projection, options)).toThrow();
    const stale = index.read();
    append(session, { type: 'subagent/end', version: 1, taskId: 'pending', outcome: 'completed' });
    index.stage([session.events.at(-1)!]).commit();
    expect(() => readIndexedConversationState(stale, projection, options)).toThrow();
});

it('checks every indexed coordinate while allocating only the source emitted in state', () => {
    const session = createSession();
    for (let turn = 0; turn < 700; turn++) {
        append(session, { type: 'turn/start' });
        append(session, { type: 'user/message', text: 'task' });
        append(session, { type: 'assistant/message', text: 'reply' });
        append(session, { type: 'turn/end' });
    }
    append(session, { type: 'turn/start' });
    const projection = projectConversation(session, { ownerSessionId: 'owner' });
    const expected = readConversationState(session, projection);
    const state = createConversationStateIndex();
    state.stage(session.events).commit();
    const assertCurrent = vi.fn();
    const coordinateIndex = createConversationSourceCoordinates();
    const coordinates = retainConversationSourceCoordinates(coordinateIndex.stage(session.events).commit(), assertCurrent);
    const sources = archiveConversationSources(eventArchive(session.events), 'owner', [], { coordinates });
    const options = { visibility: conversationVisibility(session), sources, delivery: readDeliveries(session), seedEnd: 0 };
    const reference = vi.spyOn(contextData, 'createConversationSourceRef');
    try {
        assertCurrent.mockClear();
        const result = readIndexedConversationState(state.read(), projection, options);
        expect(result).toEqual(expected);
        expect(result).toMatchObject({ kind: 'available', state: { turnSourceId: '["owner",2800,"event"]', sourceIds: [] } });
        expect(assertCurrent).toHaveBeenCalledTimes(5603);
        expect(reference).toHaveBeenCalledExactlyOnceWith('["owner",2800,"event"]', 2800, 'event', 2800);
        assertCurrent.mockImplementationOnce(() => { throw Error('Original source retired'); });
        expect(() => readIndexedConversationState(state.read(), projection, options)).toThrow('Original source retired');
    } finally {
        reference.mockRestore();
    }
});
