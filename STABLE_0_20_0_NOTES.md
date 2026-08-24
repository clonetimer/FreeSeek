# FreeSeek 0.20.0 Stable Notes

**Status:** Local/Internal Stable (unsigned public-release profile deferred)  
**Date:** 2026-08-21

## Scope

FreeSeek 0.20.0 freezes the shared Agent/Kernel surfaces together with the standalone Desktop Host. The Stable designation in this kit means the code and local/internal deliverables are functionally validated and frozen. Public distribution signing (Windows Authenticode, macOS notarization, production update signing) is intentionally deferred and does not alter the functional Stable baseline.

## Stable product surfaces

- VS Code Extension host
- CLI (`freeseek`)
- ACP stdio host (`freeseek-acp`)
- Eval / Bench CLI tools
- Standalone Desktop Host

## Desktop evidence carried into Stable

- Exact Electron 43.3.0 Windows x64 runtime integrity verified.
- Development and productized packaged E2E passed.
- Windows DPAPI secureStorage passed.
- Durable session/history/resume and artifact preview passed.
- Forced-kill recovery recovered the same ACP session and cleared the recovery marker after success.
- Candidate-bound ACP interoperability passed with two independent clients.

## Release-signing boundary

This Stable kit is suitable for source use, local/internal installation, evaluation and the next UI-development baseline. It is **not represented as an Authenticode-signed public Windows release**. Future public signing may wrap the same Stable source/runtime without changing the Agent architecture.
