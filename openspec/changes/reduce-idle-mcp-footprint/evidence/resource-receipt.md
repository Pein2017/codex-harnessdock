# Resource receipt

Date: 2026-09-01 UTC  
Host: Linux, Node.js 22.22.0 for the isolated import measurement  
Checkout: `/data/CoordExp/.worktrees/harnessdock-reduce-idle-mcp-footprint`

## Live installed baseline

The live Codex app-server owned 10 exact HarnessDock bootstrap processes. Reading each process's `/proc/<pid>/smaps_rollup` and FD directory produced:

| Processes | Aggregate PSS | Aggregate RSS | Aggregate FDs |
|---:|---:|---:|---:|
| 10 | 322,128 KiB | 820,012 KiB | 211 |

Every observed process had the live Codex app-server as parent. This receipt does not classify them as leaked and does not sum RSS as unique physical memory.

## Comparable cold-import observation

Both rows used the same clean-worktree command: import `runtime/mcp-server.mjs`, then read the current process's `smaps_rollup`, FD directory, and import elapsed time.

| State | PSS | RSS | FDs | Import time |
|---|---:|---:|---:|---:|
| Before production edit | 45,654 KiB | 95,168 KiB | 22 | 241.020 ms |
| After production edit | 38,273 KiB | 85,512 KiB | 22 | 237.798 ms |
| Observed delta | −7,381 KiB (−16.2%) | −9,656 KiB (−10.1%) | 0 | −3.222 ms |

PSS is the decision-bearing memory observation. RSS is retained separately. Import time is one sample and supports no latency claim. The installed Plugin was not refreshed by this change, so the live 10-process population remains a baseline rather than an after-release witness.

## Stop decision

The leaf import correction achieved a material cold-frontend PSS reduction without changing transport or lifecycle. This change therefore stops here: no shared daemon, relay, idle MCP timer, process reaper, or new lease registry is justified by the current host evidence.
