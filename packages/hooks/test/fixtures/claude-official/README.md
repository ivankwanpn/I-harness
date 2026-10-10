These Apache-2.0 test fixtures are unmodified runtime files from
https://github.com/anthropics/claude-plugins-official/tree/b8e53f1c05dff3b6d751297f6527990ffc81c2f4/plugins
(hookify and ralph-loop). Each fixture includes its upstream license. Only the
hooks and modules required by the regression tests are copied.

The tests use an explicit mock model, isolated temporary project state, and
real subprocesses. Hookify needs Python 3; Ralph Loop needs Bash, jq and Perl.
Set IH_CLAUDE_TEST_PYTHON or IH_CLAUDE_TEST_JQ to local prerequisite paths where
needed. Missing prerequisites skip only their external-runtime integration
cases, never the declaration/unit coverage.

This Windows session uses a test-only jq 1.8.1 binary from the official
jqlang/jq release under .tmp/claude-hook-test-deps. Its upstream SHA-256 is
23cb60a1354eed6bcc8d9b9735e8c7b388cd1fdcb75726b93bc299ef22dd9334; the downloaded
binary matched the release checksum. Its COPYING license is beside the binary.
No binary, global installation, or changed package manifest is shipped.
