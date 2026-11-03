import { types } from 'node:util';
import {bindOriginalCurrentnessDescriptors,wrapOriginalSourceCurrentness,propagateOriginalCurrentnessReader} from './currentness-guards.ts';
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts';
const captured = new WeakSet<object>();
/** Original method/receiver capture. Passive cleanup always uses the retained
 * methods even after active source substitution/currentness has failed. */
export function captureOriginalRestorationSource(input: OriginalConversationRestorationSource): OriginalConversationRestorationSource {
    const fail = () => {
        throw Object.assign(new TypeError('CONVERSATION_RESTORATION_SOURCE_CHANGED'), { code: 'CONVERSATION_RESTORATION_SOURCE_CHANGED' });
    };
    if (!input || typeof input !== 'object' || types.isProxy(input))
        return fail();
    if (captured.has(input))
        return input;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
        return fail();
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(input), methods = ['assertCurrent', 'consume', 'readEvent', 'settle', 'close', 'appendCommitted'] as const;
    const allowed = new Set<string>([...methods, 'formatVersion', 'header', 'prefix']);
    if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.has(key)))
        return fail();
    for (const name of methods) {
        const field = descriptors[name];
        if (!field || !('value' in field) || typeof field.value !== 'function' || types.isProxy(field.value))
            return fail();
    }
    let immutableVerified=false;
    const check = () => {
        if(immutableVerified)return;
        if (Object.getPrototypeOf(input) !== prototype)
            fail();
        const keys = Reflect.ownKeys(input);
        if (keys.length !== Reflect.ownKeys(descriptors).length)
            fail();
        for (const key of Object.keys(descriptors)) {
            const original = descriptors[key]!, now = Object.getOwnPropertyDescriptor(input, key);
            if (!now || now.enumerable !== original.enumerable || ('value' in original ? !('value' in now) || now.value !== original.value : 'value' in now || now.get !== original.get || now.set !== original.set))
                fail();
        }
        immutableVerified=immutableInput;
    };
    const originalAssert=bindOriginalCurrentnessDescriptors({receiver:input,method:descriptors.assertCurrent!.value,before:[],after:[],message:'CONVERSATION_RESTORATION_SOURCE_CHANGED'});
    const immutableInput=!!originalAssert&&Object.isFrozen(input);
    const assert = originalAssert??descriptors.assertCurrent!.value.bind(input) as OriginalConversationRestorationSource['assertCurrent'];
    const consume = descriptors.consume!.value.bind(input) as OriginalConversationRestorationSource['consume'];
    const read = descriptors.readEvent!.value.bind(input) as OriginalConversationRestorationSource['readEvent'];
    const settle = descriptors.settle!.value.bind(input) as OriginalConversationRestorationSource['settle'];
    const close = descriptors.close!.value.bind(input) as OriginalConversationRestorationSource['close'];
    const append = descriptors.appendCommitted!.value.bind(input) as OriginalConversationRestorationSource['appendCommitted'];
    const metadata = <K extends 'formatVersion' | 'header' | 'prefix'>(key: K): OriginalConversationRestorationSource[K] => {
        check();
        const field = descriptors[key];
        if (!field) {
            if (key !== 'header')
                return fail();
            return undefined as OriginalConversationRestorationSource[K];
        }
        return ('value' in field ? field.value : field.get ? Reflect.apply(field.get, input, []) : undefined) as OriginalConversationRestorationSource[K];
    };
    const source: OriginalConversationRestorationSource = {
        get formatVersion() {
            return metadata('formatVersion');
        }, get header() {
            return metadata('header');
        }, get prefix() {
            return metadata('prefix');
        }, assertCurrent: (originalAssert&&wrapOriginalSourceCurrentness(originalAssert,()=>{check();assert();check()}))??function() {
            check();
            assert();
            check();
        }, async consume(accept) {
            check();
            await consume(async (unit) => {
                check();
                await accept(unit);
                check();
            });
            check();
        }, async readEvent(index) {
            check();
            const event = await read(index);
            check();
            return event;
        }, settle, close, appendCommitted(batch, receipt) {
            check();
            append(batch, receipt);
            check();
        }
    };
    Object.freeze(source);
    for(const key of ['prefix','header','formatVersion'] as const)propagateOriginalCurrentnessReader(input,key,source,key);
    captured.add(source);
    return source;
}
