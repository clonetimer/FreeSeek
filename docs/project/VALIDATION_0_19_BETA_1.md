# FreeSeek 0.19.0-beta.1 Validation Record

Date: 2026-08-19  
Branch: `feat/m3-host-parity` (to be fast-forwarded into `dev/0.19` after commit)  
Target tag: `v0.19.0-beta.1`

## Scope

M3 cross-host parity for the ACP host:

- capability-negotiated `ask_user` via ACP form elicitation;
- root-aware `additionalDirectories`;
- durable session modes;
- explicit Skills/Multi-Agent host policy;
- multi-root path/checkpoint/hook safety;
- structural split to preserve repository hygiene limits.

## Release gates

`npm run check`: **PASS, 8/8**

1. source typecheck — PASS
2. test typecheck — PASS
3. hygiene — PASS
4. ToolRuntime boundary — PASS
5. benchmark boundary — PASS
6. Kernel/Host boundary — PASS
7. package/lock/project-state coherence — PASS
8. export JSDoc — advisory only (62 existing missing-doc exports)

## Regression

`npm test`: **340/340 PASS, 0 FAIL** across 4 suites.

M3-specific protocol/security coverage includes:

- ACP form elicitation capability gating and `elicitation/create` reverse request;
- canonical/scoped/durable additional directories;
- immutable additional-root authorization on resume;
- `session/set_mode` persistence + current-mode update;
- Skills/Multi-Agent launch policy;
- multi-root path safety outside authorized roots.

## Security posture

- The ACP host does not expose `ask_user` unless the connected client advertises form elicitation capability.
- Additional workspace roots are explicit, canonicalized authorization scopes; relative paths remain anchored to the primary workspace.
- Resume is stricter than simple reattachment: the client must reassert the same additional-root set, preventing silent privilege expansion.
- Disabling Skills removes both the user-facing skill tool and the internal SkillManager from the Agent ToolContext, so Multi-Agent cannot indirectly inherit skills.
- All execution remains behind `ToolRegistry → ToolRuntime`; no ACP raw tool-body bypass was introduced.

## Result

**TAGGABLE as `v0.19.0-beta.1`** after the final commit containing this validation record is rechecked and the tag points at that exact validated commit.
