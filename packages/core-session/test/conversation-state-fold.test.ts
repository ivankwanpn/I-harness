import { expect, it } from 'vitest';
import { createSession, append, projectConversation, readConversationState } from '../src/index.ts';
import { createConversationStateIndex, readIndexedConversationState } from '../src/conversation/state.ts';
import { conversationVisibility } from '../src/conversation/visibility.ts';
import { conversationSources } from '../src/conversation/sources.ts';
import { readDeliveries } from '../src/conversation/delivery.ts';
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
    const projection = projectConversation(session, { ownerSessionId: 'owner' }), options = { visibility: conversationVisibility(session), sources: conversationSources(session, 'owner', []), delivery: readDeliveries(session), seedEnd: 0 };
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
