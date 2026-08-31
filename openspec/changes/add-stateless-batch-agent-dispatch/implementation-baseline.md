# Implementation baseline

Change B composes one explicit stack; it does not sync or reinterpret the
older active delta specs.

- committed source: `74a20a03b79f306e3c67c43100f058427ac1acb2`
- committed source tree: `072fd83b02503f2f14295bbc8049fa148f491178`
- main-spec tree: `06619cd705eb9fa03f4283ea91dec7b800dbd49e`
- package version: `0.25.5`
- accepted Change A MCP generation: `9`
- Change A artifact digest: `sha256:3c3ab7484964e6fedeea7fee8c2df12d6687372a1e73fb80aa8dda4a839993a3`
- deterministic direct-Harness parity receipt digest:
  `sha256:5878b52dd4663c90cea358fc57144d69c28667a4f7f86e6e556c80d7e8338a3b`

The committed source moved from `e2d2589` to `74a20a0` during implementation
only to admit the installed OpenCode `1.18.25` version. That root-cause fix was
independently committed and locally refreshed; it changes no Change A or Change
B lifecycle semantics. This baseline adopts it and requires the same final
verification as the rest of the stack.

Change A is lead-accepted at 15/15 tasks: its new tests fail against the frozen
pre-change source, focused recovery/MCP/ledger tests pass, strict OpenSpec is
valid, and `npm run check` passed. Its accepted public generation is the sole
input to Change B's subsequent generation 10.

The stacked deterministic parity baseline is promotion-eligible at 32 `pass`,
0 `fail`, 0 `hold`, and 10 capability-derived `not_applicable` cells. The lone
unchecked parity task is an optional, separately authorized live model witness;
it is not silently promoted into deterministic parity evidence and does not
block this zero-model implementation.
