import type { SettingsWslExecution } from '@i-harness/settings';
import type { WslDistribution, WslRuntimeInfo, WslDependencyStatus } from '@i-harness/sandbox-wsl';
import { withDesktopSettings } from './settings-file.ts';
export interface WslRuntimeDiagnostic {
    distribution: WslRuntimeInfo['distribution'];
    available: WslRuntimeInfo['available'];
    detail: WslRuntimeInfo['detail'];
    dependencies: Record<string, WslDependencyStatus>;
    paths: WslRuntimeInfo['paths'];
}
export interface ManagedDependencyDiagnostic {
    status: 'available' | 'missing' | 'disabled' | 'unavailable';
    detail: string;
    path?: string;
}
export interface WslSettingsState {
    selected: SettingsWslExecution;
    distributions?: readonly WslDistribution[];
    runtime?: WslRuntimeDiagnostic;
    managedDependencies?: ManagedDependencyDiagnostic;
    capabilities: {
        diagnose: boolean;
        repair: boolean;
    };
}
export type WslSettingsRequest = {
    kind: 'desktop/wsl/state' | 'desktop/wsl/diagnose' | 'desktop/wsl/repair';
    workspaceId: string;
};
export interface WslSettingsOptions {
    listDistributions?(): Promise<readonly WslDistribution[]>;
    inspectRuntime?(distribution: string): Promise<WslRuntimeDiagnostic>;
    diagnoseDependencies?(configuration: SettingsWslExecution): Promise<ManagedDependencyDiagnostic>;
    repairDependencies?(configuration: SettingsWslExecution): Promise<ManagedDependencyDiagnostic>;
}
export function createWslSettings(path: string, options: WslSettingsOptions = {}) {
    const read = () => withDesktopSettings(path, async (store) => ({ ...store.get().wslExecution }));
    let diagnosed: Pick<WslSettingsState, 'distributions' | 'runtime' | 'managedDependencies'> = {};
    let diagnosedConfiguration: SettingsWslExecution | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    let closed = false;
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        if (closed) return Promise.reject(new Error("WSL settings closed"));
        const result = tail.then(work, work);
        tail = result.catch(() => undefined);
        return result;
    };
    async function state(): Promise<WslSettingsState> {
        const selected = await read();
        const distributions = diagnosed.distributions ?? await options.listDistributions?.();
        const matches = diagnosedConfiguration !== undefined && JSON.stringify(diagnosedConfiguration) === JSON.stringify(selected);
        return { selected, distributions, ...(matches ? diagnosed : {}), capabilities: { diagnose: !!options.listDistributions && !!options.inspectRuntime, repair: !!options.repairDependencies } };
    }
    return {
        state: () => serial(state),
        async close() { closed = true; await tail; },
        diagnose: () => serial(async () => {
            if (!options.listDistributions || !options.inspectRuntime)
                throw new Error('WSL diagnostics unavailable');
            const selected = await read();
            const distributions = await options.listDistributions();
            const runtime = await options.inspectRuntime(selected.distribution);
            const managedDependencies = options.diagnoseDependencies ? await options.diagnoseDependencies(selected) : undefined;
            diagnosed = { distributions, runtime, managedDependencies };
            diagnosedConfiguration = { ...selected };
            return state();
        }),
        repair: () => serial(async () => {
            if (!options.repairDependencies)
                throw new Error('Managed dependency repair unavailable');
            const selected = await read();
            if (!selected.workspaceDependencies)
                throw new Error('Workspace dependencies are disabled');
            const managedDependencies = await options.repairDependencies(selected);
            const runtime = options.inspectRuntime ? await options.inspectRuntime(selected.distribution) : undefined;
            diagnosed = { distributions: diagnosed.distributions, runtime, managedDependencies };
            diagnosedConfiguration = { ...selected };
            return state();
        }),
    };
}
