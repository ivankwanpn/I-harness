These two plugin directories are unchanged snapshots from
https://github.com/anthropics/claude-plugins-official at
`b8e53f1c05dff3b6d751297f6527990ffc81c2f4` (retrieved 2026-10-10).
Their original licenses are retained in each plugin directory. The local
marketplace manifest only selects this subset for an offline installation test.

The regression installs them into temporary storage through PluginRegistry,
loads RuntimeInputs through the production Desktop extension adapter, runs the
real explanatory startup command after granting its content hash, and spawns a
real feature-dev code-reviewer with a scripted local model. No live user
settings, installed plugins, model endpoints, or account credentials are used.
