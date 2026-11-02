import { receivedExecutionInputsFor } from '../../../session-executor/src/lifecycle/execution-inputs.ts';
import { isStrictFactData } from '@i-harness/core-session';
import { registryRequiresInstructionOrigin } from '@i-harness/core-tools';
import { createManagedExecutionDomain, isManagedExecutionSource, assertManagedActionCurrent, getManagedExecutionAdmissionWait, readManagedActionMembers, type ManagedExecutionDomain } from '@i-harness/core-session/internal/execution';
import { canonicalJsonData, type FactOutcome, type CapturedActionFact, type ManagedAction, type SettlementFacts } from '@i-harness/core-session';
import { assertModelOriginPair, type ConstructorManagedModelOriginVerifier, type ManagedModelOriginExpectation, type PreparedModelOriginDriver } from '@i-harness/core-tools/model-origin';
import type { ToolRegistry, PreparedCall } from '@i-harness/core-tools';
import { isManagedExecutionAttachment, type ManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts';
import type { PluginContext } from '@i-harness/core-plugin';
export interface ManagedFactWitness {
    readonly capture: CapturedActionFact<FactOutcome>;
    readonly outcome: Extract<FactOutcome, {
        kind: 'committed';
    }>;
}
type Origin = {
    domain: ManagedExecutionDomain;
    registry: ToolRegistry;
    driver: PreparedModelOriginDriver;
    consumed: boolean;
};
const bindings = new WeakMap<object, Origin>();
const origins = new WeakSet<object>();
type MemberProof = {
    origin: Origin;
    check(expected: ManagedModelOriginExpectation): void;
    schedule(expected: ManagedModelOriginExpectation):void;
    action?: ManagedAction<FactOutcome>;
    taken: boolean;
};
const proofs = new WeakMap<object, MemberProof>();
/** A closed constructor pair; neither a registry nor a domain alone enrolls
 * incoming model calls. Every permit below comes from this invocation's ACKs. */
export function createManagedAgentModelOriginOwner(context: PluginContext, execution: ManagedExecutionAttachment) {
    if (!isManagedExecutionAttachment(execution))
        throw TypeError('Original private execution attachment required');
    const domain = createManagedExecutionDomain(execution.identity, execution.owner, context);
    let bound = false, state: Origin | undefined;
    const verifier: ConstructorManagedModelOriginVerifier = Object.freeze({ kind: 'managed-model-origin', domain, take(proof: object, expected: ManagedModelOriginExpectation) {
            const member = proofs.get(proof);
            if (!state?.consumed || !member || member.origin !== state || member.taken)
                throw TypeError('Original private model member required');
            member.check(expected);
            member.taken = true;
            let issued = false, codeIssued = false;
            const permit: import('@i-harness/core-tools/model-origin').OriginalManagedModelMemberPermit = Object.freeze({ getAdmissionWait(signal:AbortSignal){if(this!==permit)throw TypeError('Original model permit receiver required');member.schedule(expected);return getManagedExecutionAdmissionWait(domain,member.action!,signal)}, assertCurrent() {
                    if (this !== permit)
                        throw TypeError('Original model permit receiver required');
                    member.check(expected);
                }, takeExecSourceIssuer() {
                    if (this !== permit || issued)
                        throw TypeError('Original Exec source issuer required');
                    member.check(expected);
                    issued = true;
                    let registered = false, captured = false;
                    const issuer: import('@i-harness/core-tools/model-origin').OriginalExecSourceIssuer = Object.freeze({ assertAdmissionCurrent() {
                            if (this !== issuer)
                                throw TypeError('Original Exec issuer receiver required');
                            member.check(expected);
                        }, registerCompletion(drain: () => Promise<void>) {
                            if (this !== issuer || registered)
                                throw TypeError('Original Exec completion required');
                            member.check(expected);
                            registered = true;
                            return member.action!.registerSettlementSource(drain);
                        }, captureSource(binding: import('@i-harness/core-tools/model-origin').ExecSourceBinding, recipientCurrent: () => boolean) {
                            if (this !== issuer || !registered || captured)
                                throw TypeError('Original Exec source required');
                            member.check(expected);
                            if (binding.callSeq !== expected.callEventSeq || binding.recipientSessionId !== domain.sessionId || binding.sourceNamespace !== 'exec')
                                throw TypeError('Original Exec member binding required');
                            captured = true;
                            return member.action!.captureExecDeliverySource({ type: 'agent/delivery-source', version: 1, kind: 'exec', ...binding }, () => {
                                try {
                                    member.check(expected);
                                    return recipientCurrent();
                                }
                                catch {
                                    return false;
                                }
                            });
                        } });
                    return issuer;
                }, takeCodeSourceIssuer() {
                    if(this!==permit||codeIssued)throw TypeError('Original Code source issuer required');
                    member.check(expected);
                    if(expected.name!=='code_exec'||registryRequiresInstructionOrigin(expected.registry))throw TypeError('Original supported Code member required');
                    codeIssued=true;
                    const recipient=receivedExecutionInputsFor(execution).codeDelivery(domain);
                    let registered=false,captured=false,preparing=false,preparedBinding:string|undefined;
                    const issuer:import('@i-harness/core-tools/model-origin').OriginalCodeSourceIssuer=Object.freeze({
                        assertAdmissionCurrent(){if(this!==issuer)throw TypeError('Original Code issuer receiver required');member.check(expected);if(registryRequiresInstructionOrigin(expected.registry))throw TypeError('Private instruction-backed Code unsupported')},
                        registerCompletion(drain:()=>Promise<void>){if(this!==issuer||registered)throw TypeError('Original Code completion required');issuer.assertAdmissionCurrent();registered=true;return member.action!.registerSettlementSource(drain)},
                        async prepareLaunch(cellId:string,sourceId:string){if(this!==issuer||!registered||preparing)throw TypeError('Original Code launch preparation required');issuer.assertAdmissionCurrent();preparing=true;const prepared=await recipient.prepareCodeLaunch({sessionId:domain.sessionId,callId:expected.callId,callSeq:expected.callEventSeq,cellId,sourceId});issuer.assertAdmissionCurrent();if(prepared.kind!=='bound')throw Object.assign(Error('Private Code launch unavailable'),{reason:prepared.reason});if(prepared.binding.cellId!==cellId||prepared.binding.sourceId!==sourceId||!isStrictFactData(prepared.binding))throw TypeError('Original Code launch binding required');preparedBinding=canonicalJsonData(prepared.binding);return prepared},
                        captureSource(binding:Readonly<import('@i-harness/core-tools/model-origin').CodeSourceBinding>,recipientCurrent:()=>boolean){if(this!==issuer||!registered||captured||!preparedBinding||!isStrictFactData(binding)||canonicalJsonData(binding)!==preparedBinding||binding.recipientSessionId!==domain.sessionId||binding.callSeq!==expected.callEventSeq||binding.sourceNamespace!=='code'||binding.delivery!=='tool')throw TypeError('Original Code source binding required');issuer.assertAdmissionCurrent();captured=true;return member.action!.captureCodeDeliverySource({type:'agent/delivery-source',version:1,kind:'code',...binding},()=>{try{issuer.assertAdmissionCurrent();return recipientCurrent()}catch{return false}})},
                    });return issuer;
                } });
            return permit;
        } });
    return Object.freeze({ domain, verifier, bind(registry: ToolRegistry, driver: PreparedModelOriginDriver) {
            domain.assertCurrent();
            if (bound)
                throw TypeError('Original model origin already bound');
            assertModelOriginPair(registry, driver, verifier);
            bound = true;
            const binding = Object.freeze({});
            state = { domain, registry, driver, consumed: false };
            origins.add(state);
            bindings.set(binding, state);
            return binding;
        } });
}
export function consumeManagedAgentModelOrigin(binding: object, domain: ManagedExecutionDomain, registry: ToolRegistry) {
    const origin = bindings.get(binding);
    if (!origin || origin.consumed || origin.domain !== domain || origin.registry !== registry)
        throw TypeError('Original private model origin binding required');
    domain.assertCurrent();
    origin.consumed = true;
    return Object.freeze(origin);
}
/** Invocation-local captures remain with the actual action until its original
 * source cleanup ACK. A copied outcome, foreign action, or row cannot join. */
export function createManagedModelInvocation(origin: Origin, action: ManagedAction<FactOutcome>) {
    if (!origins.has(origin) || !origin.consumed || !origin.domain.owner.ownsAction(action))
        throw TypeError('Original private model action required');
    let active = true, input: ManagedFactWitness | undefined;
    const retainedProofs = new Set<MemberProof>();
    const expire = (member: MemberProof) => { member.schedule=member.check = () => { throw TypeError('Private model member released'); }; member.action = undefined; retainedProofs.delete(member); };
    const current = () => {
        if (!active)
            throw TypeError('Private model invocation expired');
        assertManagedActionCurrent(origin.domain, action);
    };
    const read = (witness: ManagedFactWitness) => readManagedActionMembers(origin.domain, action, witness.capture, witness.outcome);
    const batches = new WeakMap<object, {
        accepted: ManagedFactWitness;
        calls: readonly ManagedFactWitness[];
        closed: boolean;
        used: Set<number>;
        proofs: Set<MemberProof>;
    }>();
    const batchTokens = new Set<object>();
    return Object.freeze({
        assertCurrent: current,
        input(witness: ManagedFactWitness) {
            current();
            if (input)
                throw TypeError('Original promoted input already retained');
            const events = read(witness);
            if (!events.some(event => event.type === 'user/message'))
                throw TypeError('Original promoted message required');
            input = witness;
        },
        accepted(witness: ManagedFactWitness, calls: readonly ManagedFactWitness[]) {
            current();
            if (!input)
                throw TypeError('Original promoted input required');
            read(input);
            const accepted = read(witness).find(event => event.type === 'model/exchange-accepted');
            if (!accepted || accepted.type !== 'model/exchange-accepted' || accepted.callSeqs.length !== calls.length)
                throw TypeError('Original accepted exchange required');
            calls.forEach((call, index) => {
                const members = read(call);
                if (members.length !== 1 || members[0]?.type !== 'tool/call' || members[0].seq !== accepted.callSeqs[index])
                    throw TypeError('Original accepted call member required');
            });
            const batch = Object.freeze({});
            batches.set(batch, { accepted: witness, calls: Object.freeze([...calls]), closed: false, used: new Set(), proofs: new Set() });
            batchTokens.add(batch);
            return batch;
        },
        closed(batch: object) {
            current();
            const record = batches.get(batch);
            if (!record || record.closed)
                throw TypeError('Original accepted generation close required');
            read(record.accepted);
            record.closed = true;
        },
        attach(batch: object, index: number, prepared: PreparedCall, source: SettlementFacts<FactOutcome>) {
            current();
            const record = batches.get(batch);
            if (!record?.closed || record.used.has(index) || !isManagedExecutionSource(origin.domain, source))
                throw TypeError('Original accepted batch member required');
            const witness = record.calls[index];
            if (!witness)
                throw TypeError('Original accepted member index required');
            const event = read(witness)[0];
            if (event?.type !== 'tool/call')
                throw TypeError('Original tool call required');
            record.used.add(index);
            const schedule = (expected: ManagedModelOriginExpectation) => {
                if(!active)throw TypeError('Private model invocation expired');
                read(input!);
                read(record.accepted);
                if (!record.closed || expected.registry !== origin.registry || expected.prepared !== prepared || expected.domain !== origin.domain || expected.source !== source || !isManagedExecutionSource(origin.domain, source) || read(witness)[0] !== event || event.callId !== expected.callId || event.seq !== expected.callEventSeq || event.name !== expected.name || canonicalJsonData(event.args) !== canonicalJsonData(expected.args))
                    throw TypeError('Original private model member mismatch');
                source.assertHeld();
            };
            const check=(expected:ManagedModelOriginExpectation)=>{current();schedule(expected)};
            const proof = Object.freeze({}), member = { origin, check, schedule, action, taken: false };
            proofs.set(proof, member);
            retainedProofs.add(member);
            record.proofs.add(member);
            origin.driver.attach(prepared, proof);
        },
        releaseBatch(batch: object) {
            const record = batches.get(batch);
            if (record) {
                for (const proof of record.proofs)
                    expire(proof);
                record.proofs.clear();
                batches.delete(batch);
                batchTokens.delete(batch);
            }
        },
        invalidate() {
            active = false;
            input = undefined;
            for (const proof of retainedProofs)
                expire(proof);
            for (const token of batchTokens)
                batches.delete(token);
            batchTokens.clear();
        },
    });
}


