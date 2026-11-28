import { expect, it } from 'vitest';
import { createContextStateIndex, deriveContextRecovery, deriveContextBudget, wasContextBudgetRewritten } from '../src/projection/context.ts';
import { deriveLastProviderInput } from '../src/projection/provider-input.ts';
import { contextUsageAnchorId } from '../src/events/usage-anchor.ts';
import type { Session, SessionEvent } from '../src/events/types.ts';
import type { AcceptedRequestAttributionV1, ContextUsageCheckpointV2, ContextUsageEventV2 } from '../src/events/attribution.ts';
import type { ExchangeAcceptedEventV2 } from '../src/events/conversation.ts';
import type { RequestBudgetSnapshotV2 } from '../src/events/admission.ts';
it('incremental recovery retains strongest applicable lane and consumed retry across later transitions', () => {
    const base = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), modelId: 'model', protocol: 'chat' };
    const session: Session = { formatVersion: 14, events: [{ ...base, recoveryId: 'old', providerId: 'p', state: 'retry-started', seq: 0 }, { ...base, recoveryId: 'new', providerId: 'q', state: 'required', seq: 1 }, { ...base, recoveryId: 'old', providerId: 'p', state: 'blocked', seq: 2 }, { ...base, recoveryId: 'new', providerId: 'q', state: 'resolved', seq: 3 }] };
    const index = createContextStateIndex('owner');
    for (const event of session.events)
        index.stage([event]).commit();
    for (const binding of [undefined, { modelId: 'model', protocol: 'chat' }, { providerId: 'p', modelId: 'model', protocol: 'chat' }, { providerId: 'q', modelId: 'model', protocol: 'chat' }, { providerId: 'p', modelId: 'other', protocol: 'chat' }])
        expect(index.recovery('owner', binding)).toEqual(deriveContextRecovery(session, 'owner', binding));
    expect(index.recovery('owner', { modelId: 'model', protocol: 'chat' })).toMatchObject({ recoveryId: 'old', state: 'blocked', retryConsumed: true });
    expect(index.budget('owner')).toEqual(deriveContextBudget(session, 'owner'));
});

const digest = 'a'.repeat(64);
function providerEvidence(firstSeq = 2, ownerSessionId = 'owner') {
    const request: AcceptedRequestAttributionV1 = { version:1,ownerSessionId,observationLifetimeId:'lease',candidateId:'candidate',sendId:'send',
        semanticId:digest,payloadId:digest,payloadKind:'http-json-body',executionEpochId:'epoch',coldCompatible:false,projectionRevision:0,
        snapshot:{semanticRevision:digest,protectionRevision:digest,branchId:digest,contextEpoch:digest,surfaceRevision:digest} };
    const receipt = { exchangeId:'exchange',actionId:'action',attemptId:'attempt' };
    const accepted: ExchangeAcceptedEventV2 = { type:'model/exchange-accepted',version:2,...receipt,request,seq:firstSeq,
        stepStartSeq:0,assistantSeq:1,callSeqs:[] };
    const facts: Omit<ContextUsageCheckpointV2,'anchorId'> = { version:2,accepted:{...receipt,acceptedSeq:firstSeq},request:structuredClone(request),
        bindingId:digest,shapeId:digest,pricingVersion:'projected-pricing-v2',normalizationVersion:'input-usage-v1',usageSemantics:'includes-cache',
        prefixId:digest,unitCount:1,heuristicPrefixTokens:12,reportedInputTokens:41 };
    const usage: Extract<ContextUsageEventV2,{op:'sample'}> = {type:'context/usage',version:2,op:'sample',seq:firstSeq+1,
        checkpoint:{...facts,anchorId:contextUsageAnchorId(facts)}};
    const budget: RequestBudgetSnapshotV2 = { version:2,ownerSessionId,modelId:'model',protocol:'chat',bindingFingerprint:digest,bindingRevision:0,
        projectionRevision:0,neutralFingerprint:digest,identityCoverage:'partial',purpose:'main',estimate:{kind:'unknown',reason:'unconfigured'},
        disposition:'compatibility',dimensions:[{dimension:'context',state:'unchecked'}],pressure:{kind:'unavailable',reason:'unconfigured'},
        components:{kind:'estimated',source:'projected-heuristic',user:0,assistant:0,tool:0,system:0,schema:0,reasoning:0},
        output:{capSupport:'unknown',minimumCap:1},recoveryRequired:false,fullByProvider:false,freshness:'awaiting-projection',
        requestContext:{...request.snapshot,version:1},selectedSemanticId:digest,selectedPayloadId:digest };
    return {accepted,usage,budget:{type:'context/budget',version:2,snapshot:budget,seq:firstSeq+2} as const};
}

it('keeps detached acceptance and usage witnesses only when another batch needs them', () => {
    const {accepted,usage,budget} = providerEvidence();
    const index = createContextStateIndex('owner');
    const staged = index.stage([accepted]);
    accepted.request.sendId = 'changed after stage';
    staged.commit();
    index.stage([usage]).commit();
    usage.checkpoint.reportedInputTokens = 888;
    usage.checkpoint.request.snapshot.branchId = 'b'.repeat(64);
    index.stage([budget]).commit();
    expect(index.lastReportedInputTokens()).toBe(41);
    expect(index.lastConversationUsage()).toEqual({ inputTokens: 41 });
    expect(Object.isFrozen(index.lastConversationUsage())).toBe(true);
});

it('prioritizes a physical rewrite over an ahead-of-history budget revision, retaining the original observation', () => {
    const {budget} = providerEvidence();
    const original = {...budget, snapshot:{...budget.snapshot, projectionRevision:500}};
    const rewrite = {type:'compaction/reset', removedSeqs:[1], seq:original.seq+1} as const;
    const index = createContextStateIndex('owner');
    index.stage([original]).commit();
    const staged = index.stage([rewrite]);
    expect(index.conversationBudgetRewritten()).toBe(false);
    staged.commit();
    expect(index.conversationBudgetRewritten()).toBe(true);
    expect(index.budget('owner','conversation')).toEqual(original.snapshot);
    expect(wasContextBudgetRewritten([original,rewrite],original.snapshot)).toBe(true);
    const next={...budget,seq:rewrite.seq+1,snapshot:{...budget.snapshot,projectionRevision:1}};
    index.stage([next]).commit();
    expect(index.conversationBudgetRewritten()).toBe(false);
    expect(wasContextBudgetRewritten([original,rewrite,next],next.snapshot)).toBe(false);
});

it('selects conversation budgets consistently for an auxiliary-only history and a mixed batch', () => {
    const { budget } = providerEvidence();
    const events: SessionEvent[] = [];
    const index = createContextStateIndex('owner');
    for (const purposes of [['title', 'summary'], ['main', 'approval', 'media'], ['recovery', 'title']] as const) {
        const batch = purposes.map(purpose => ({ ...budget, snapshot: { ...budget.snapshot, purpose } }));
        events.push(...batch);
        index.stage(batch).commit();
        const display = deriveContextBudget({ formatVersion: 14, events }, 'owner', 'conversation');
        const expected = purposes.find(purpose => purpose === 'main' || purpose === 'recovery');
        expect(display).toEqual(expected && { ...budget.snapshot, purpose: expected });
        expect(index.budget('owner', 'conversation')).toEqual(display);
        expect(index.budget('owner')).toEqual(batch.at(-1)!.snapshot);
    }
});

it('cold and restored folds never visit an old usage payload before the latest owning acceptance', () => {
    const prior = providerEvidence();
    const latest = providerEvidence(42);
    let visits = 0;
    const olderUsage = Object.defineProperty({...prior.usage},'checkpoint',{get(){visits++;return prior.usage.checkpoint}});
    const events = [prior.accepted, ...Array(32).fill(olderUsage), prior.budget, latest.accepted, latest.usage, latest.budget];
    expect(deriveLastProviderInput(events,'owner')).toEqual({acceptedSeq:42,usageSeq:43,budgetSeq:44,tokens:41,usage:{inputTokens:41}});
    const index = createContextStateIndex('owner');
    index.stage(events).commit();
    expect(index.lastReportedInputTokens()).toBe(41);
    expect(visits).toBe(0);
});

it('matches the incremental fold after a foreign receipt, retirement, auxiliary budget or rewrite', () => {
    const {accepted,usage,budget} = providerEvidence();
    const foreign = providerEvidence(10,'foreign').accepted;
    const retire = { type:'context/usage',version:2,op:'retire',ownerSessionId:'owner',anchorId:usage.checkpoint.anchorId,
        reason:'context-rewritten',branchId:digest,contextEpoch:digest,seq:10 } as const;
    const alternatives: { suffix: SessionEvent[]; tokens?: number }[] = [
        {suffix:[foreign],tokens:41},
        {suffix:[{...retire,ownerSessionId:'foreign'}],tokens:41},
        {suffix:[retire]},
        {suffix:[{type:'compaction/reset',removedSeqs:[],seq:10}]},
        {suffix:[{...budget,seq:10,snapshot:{...budget.snapshot,purpose:'approval'}}]},
        {suffix:[providerEvidence(10).accepted]},
    ];
    for (const {suffix,tokens} of alternatives) {
        const events = [accepted,usage,budget,...suffix];
        const index = createContextStateIndex('owner');
        for (const event of events) index.stage([event]).commit();
        expect(index.lastReportedInputTokens()).toBe(tokens);
        expect(deriveLastProviderInput(events,'owner')?.tokens).toBe(tokens);
        const expectedConversation = suffix[0]?.type === 'context/budget' && suffix[0].version === 2 && suffix[0].snapshot.purpose === 'approval' ? 41 : tokens;
        expect(index.lastReportedInputTokens('conversation')).toBe(expectedConversation);
        expect(deriveLastProviderInput(events, 'owner', 'conversation')?.tokens).toBe(expectedConversation);
    }
});

it('never carries a main measurement across an unclassified same-owner acceptance or another main action', () => {
    const { accepted, usage, budget } = providerEvidence();
    const auxiliary = { ...budget, snapshot: { ...budget.snapshot, purpose: 'approval' as const } };
    const main = { type:'context/action',version:1,op:'open',ownerSessionId:'owner',actionId:'next-main',purpose:'main',origin:{kind:'input',seq:0},startedAt:1,trustedAt:1,expiresAt:2 } as const;
    for (const next of [main, providerEvidence(18).accepted]) {
        const events = [accepted,usage,budget,auxiliary,next,auxiliary];
        const index = createContextStateIndex('owner');
        for (const event of events) index.stage([event]).commit();
        expect(index.lastReportedInputTokens('conversation')).toBeUndefined();
        expect(deriveLastProviderInput(events, 'owner', 'conversation')).toBeUndefined();
    }
    // A delayed sample for the old response can remain valid on its own,
    // while the conversation already has a newer main action.
    const late = [accepted, main, usage, budget];
    expect(deriveLastProviderInput(late, 'owner')?.tokens).toBe(41);
    expect(deriveLastProviderInput(late, 'owner', 'conversation')).toBeUndefined();
});
