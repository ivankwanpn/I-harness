// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentSettings } from '../src/renderer/settings/AgentSettings.tsx';
afterEach(cleanup);
const wslExecution = { distribution: 'Ubuntu', networkAccess: false, workspaceDependencies: true };
const defaults = { windowsSandboxBackend: 'wsl', sandboxMode: 'workspace-write', autoCompaction: true, approvalMode: 'dangerous', wslExecution, webSearchMode: 'cached' };
const initial = { saved: defaults, effective: defaults, restartRequired: false, source: 'settings', executions: [{ sessionId: 'old-session', status: { backend: 'legacy' } }] };
const available = { selected: wslExecution, distributions: [{ name: 'Ubuntu', version: 2, state: 'Stopped' }, { name: 'Debian', version: 2, state: 'Running' }, { name: 'OldLinux', version: 1, state: 'Stopped' }], capabilities: { diagnose: true, repair: true } };
function mount(request: ReturnType<typeof vi.fn>) { return render(<AgentSettings workspaceId='w' bridge={{ request, onEvent: () => () => { } }}/>); }
it('shows separate Chinese controls and saves WSL/web settings without changing active session claim', async () => {
    const request = vi.fn(async (action) => action.kind === 'desktop/approval-rules/state' ? { rules: [], candidates: [] } : action.kind === 'desktop/agent-settings/state' ? initial : action.kind === 'desktop/wsl/state' ? available : { ...initial, saved: { ...defaults, wslExecution: { ...wslExecution, distribution: 'Debian', networkAccess: true }, webSearchMode: 'disabled' }, effective: { ...defaults, wslExecution: { ...wslExecution, distribution: 'Debian', networkAccess: true }, webSearchMode: 'disabled' } });
    mount(request);
    const distribution = await screen.findByRole('combobox', { name: 'WSL 發行版' });
    await waitFor(() => expect(screen.getByRole('option', { name: /Debian/ })).toBeTruthy());
    expect((screen.getByRole('option', { name: /OldLinux/ }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(distribution, { target: { value: 'Debian' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '命令網路存取' }));
    fireEvent.change(screen.getByRole('combobox', { name: '網頁存取' }), { target: { value: 'disabled' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    expect(request).toHaveBeenLastCalledWith({ kind: 'desktop/agent-settings/configure', workspaceId: 'w', patch: { wslExecution: { ...wslExecution, distribution: 'Debian', networkAccess: true }, webSearchMode: 'disabled' } });
    expect(screen.getByText(/old-session/)).toBeTruthy();
    expect(screen.getAllByText(/既有組裝/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/只有已設定的搜尋提供者/).length).toBeGreaterThan(0);
});
it('shows diagnostic failure and never reports repair success for unsupported runtime', async () => {
    const request = vi.fn(async (action) => action.kind === 'desktop/approval-rules/state' ? { rules: [], candidates: [] } : action.kind === 'desktop/agent-settings/state' ? initial : action.kind === 'desktop/wsl/state' ? { ...available, capabilities: { diagnose: true, repair: false } } : Promise.reject(new Error('WSL unavailable')));
    mount(request);
    const diagnose = await screen.findByRole('button', { name: '診斷 WSL' });
    await waitFor(() => expect((diagnose as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('button', { name: '修復工作區依賴' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(diagnose);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('WSL unavailable'));
    expect(request.mock.calls.some(([action]) => action.kind === 'desktop/wsl/repair')).toBe(false);
});
it('does not request WSL diagnostics for native settings and preserves errors when saving', async () => {
    const native = { ...defaults, windowsSandboxBackend: 'legacy' };
    const request = vi.fn(async (action) => action.kind === 'desktop/approval-rules/state' ? { rules: [], candidates: [] } : action.kind === 'desktop/agent-settings/state' ? { ...initial, saved: native, effective: native } : Promise.reject(new Error('Save refused')));
    mount(request);
    fireEvent.change(await screen.findByRole('combobox', { name: '網頁存取' }), { target: { value: 'live' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Save refused'));
    expect(request.mock.calls.some(([action]) => action.kind.startsWith('desktop/wsl/'))).toBe(false);
    expect((screen.getByRole('combobox', { name: '網頁存取' }) as HTMLSelectElement).value).toBe('live');
});
