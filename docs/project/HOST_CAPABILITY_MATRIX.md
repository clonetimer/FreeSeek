# FreeSeek Host Capability Matrix

Updated: 2026-08-20

| Capability | VS Code | CLI default | ACP | Desktop dev.1 | Eval |
| --- | --- | --- | --- | --- | --- |
| interactiveInput | yes | no | negotiated | yes | no |
| permissionPrompt | yes | no | yes | yes | no |
| diffReview | yes | no | no | **no** | no |
| lsp | yes | no | no | **no** | no |
| imageInput | yes | no | no | **no** | no |
| mcp | yes | opt-in | yes | yes via ACP | no |
| skills | yes | opt-in | yes | yes via ACP | no |
| multiAgent | yes | opt-in | policy gated | **not exposed yet** | no |
| scheduling | yes | no | no | **not exposed yet** | no |
| persistentSessions | yes | yes | yes | yes via ACP | no |
| richPresentation | yes | no | yes | yes | no |

Desktop dev.1 deliberately claims less than the VS Code Host. Missing editor-native capabilities are not silently emulated.
