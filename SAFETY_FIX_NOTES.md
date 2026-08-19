# FreeSeek Safety Fix Notes

This source tree contains the safety/reliability patch produced from the uploaded FreeSeek 0.17.18 workspace.

## Fixed in this patch

- Replaced user-repository `git stash` checkpoints with a FreeSeek-owned shadow Git checkpoint store.
- Fixed `confirmFileWrites=true` so `write_file` / `edit_file` actually require approval.
- Hardened workspace path resolution for nonexistent files under symlinked parent directories; sub-agent worktree roots use the same guard.
- Routed Python, JavaScript/TypeScript Code Mode, verification commands, and shell execution through the shared CommandRunner / ExecPolicy / OS-sandbox path.
- Added real `AbortSignal` propagation for background jobs, model turns, subprocesses, MCP calls, and generic tool timeouts.
- Fixed `run_command.input` so stdin is actually written to the child process.
- Fixed Windows Code Mode temporary PowerShell script lifetime and switched it to structured argv execution.
- Made sandbox network `localhost` fail closed where a verifiable loopback-only policy is unavailable; `allow` is no longer accidentally treated as localhost-only.
- Reworked scheduler state around explicit `nextRunAt`, fixed first interval/daily execution, and persisted automatic run state.
- Added MCP stdio/HTTP request deadlines, pending-request cleanup, cancellation, and a minimal inherited environment.
- Migrated legacy/default Provider secrets to VS Code SecretStorage; Provider settings store secret references instead of new plaintext API keys/tokens.
- Serialized session index read-modify-write operations and made JSON writes atomic to prevent concurrent background sessions from overwriting metadata.
- Added trust-boundary text for persisted Memory/Skills; user-global memory and skill promotion are approval-gated.
- Added destructive approval coverage for rewind, delete-file, worktree removal, and other high-impact capabilities.
- Disabled automatic startup of the experimental DeepSeek Web compatibility adapter by default.
- Removed the PaperSeek placeholder provider-doc link and updated user-facing credential guidance.
- Hardened VSIX ignore rules against `.agent/**`, source maps, development webview output, VSIX/release artifacts, logs, and runtime state.

## Validation performed in the audit environment

- `npm run typecheck` — passed.
- `npm run check` — passed (the repository still reports its existing non-blocking exported-JSDoc suggestions).
- Focused security/state regression suite — 88 tests passed, 0 failed.
- All 31 `tests/*.test.ts` files were also emitted with a temporary TypeScript test build and executed with Node's test runner: 240 test cases passed, 0 failed. (The repository's normal test runner still requires a platform-matching esbuild binary.)

## Build note

The uploaded `node_modules` contains the Windows esbuild native package while the audit environment is Linux. The original `dist/` therefore cannot be safely regenerated here with the repository's normal esbuild pipeline, and the old `dist/` is intentionally **not included** in the source archive delivered with this patch.

On a normal development machine, install dependencies for that platform and rebuild before installing/publishing:

```bash
npm ci
npm run check
npm test
npm run vscode:prepublish
npm run package
```

Do not copy the old `dist/` from the uploaded archive into a release and assume these fixes are active; VS Code loads `./dist/extension.js`.
