import { expect, it } from 'vitest';
import { createContext } from '@i-harness/core-plugin';
import { createToolRegistry, type Tool } from '../src/index.ts';
import { captureCodeRegistration, claimPreparedCodeInvocation } from '../src/code-origin.ts';
it('captures only the original catalog registration and refuses copied, foreign and re-registered witnesses', () => {
    const ctx = createContext(), registry = createToolRegistry(ctx), tool: Tool = { name: 'code_exec', description: 'registration data only', inputSchema: {}, async execute() { return 'no producer'; } };
    registry.register(tool);
    const witness = captureCodeRegistration(registry, tool, tool.execute);
    expect(() => captureCodeRegistration({ ...registry }, tool, tool.execute)).toThrow('Original registry');
    expect(() => captureCodeRegistration(registry, { ...tool }, tool.execute)).toThrow('mismatch');
    expect(() => claimPreparedCodeInvocation({ ...witness }, {}, {} as never)).toThrow('expired');
    registry.unregister(tool.name);
    registry.register(tool);
    expect(() => claimPreparedCodeInvocation(witness, {}, {} as never)).toThrow('expired');
});
it('does not invoke supplied identity getters or accept a foreign leaf', () => {
    const registry = createToolRegistry(createContext()), tool: Tool = { name: 'code_exec', description: 'original registration', inputSchema: {}, async execute() { return 'no producer'; } };
    registry.register(tool);
    let getters = 0;
    expect(() => captureCodeRegistration(registry, Object.defineProperty({ ...tool }, 'execute', { get() { getters++; return tool.execute; } }), tool.execute)).toThrow('own-data');
    expect(() => captureCodeRegistration(registry, tool, async () => undefined)).toThrow('own-data');
    expect(getters).toBe(0);
});
