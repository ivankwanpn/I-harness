import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentShellSettings } from '../src/agent-shell.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
it('reports a Linux Bash binding for new WSL assemblies without host executable checks', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp/wsl-product-settings-shell-'));
    roots.push(root);
    const path = join(root, 'settings.json');
    await writeFile(path, JSON.stringify({ windowsSandboxBackend: 'wsl', agentShell: 'cmd', wslExecution: { distribution: 'Debian', networkAccess: true, workspaceDependencies: false } }));
    const exists = vi.fn((path: string) => /cmd.exe$/i.test(path));
    const settings = createAgentShellSettings(path, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists });
    expect(await settings.state()).toMatchObject({ executionTarget: 'wsl', selected: 'bash', nativeSelected: 'cmd', resolved: { command: '/bin/bash', executionTarget: 'wsl', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, executionContext: JSON.stringify({ distribution: 'Debian', networkAccess: true, workspaceDependencies: false }) } });
    expect(exists.mock.calls.some(([path]) => path === '/bin/bash')).toBe(false);
    expect(settings.resolve()).toMatchObject({ id: 'cmd', executionTarget: 'host' });
    await expect(settings.configure({ shell: 'pwsh' })).rejects.toThrow(/WSL.*Bash/i);
});
