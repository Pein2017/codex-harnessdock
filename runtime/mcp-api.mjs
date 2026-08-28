/** SPDX-License-Identifier: Apache-2.0 */

/**
 * Increment only when an existing Codex task's discovered MCP contract can no
 * longer call the checkout runtime safely. Compatible runtime implementation
 * edits keep this generation and hot-load on the next isolated MCP call.
 *
 * Generation 7 is the native-discovery generation: `list_harnesses` and
 * `spawn_agent` take bounded Pi/OpenCode route facts from fresh native
 * discovery instead of fixed constants, `spawn_agent` requires an explicit
 * `reasoning_effort` the selected Driver freshly admits for the exact model,
 * and `followup_task` inherits that frozen effort. A task that discovered
 * generation 6 assumed fixed native model/effort enums and cannot call this
 * surface safely, so it is told to restart rather than adapted.
 */
export const HARNESSDOCK_MCP_API_GENERATION = 7;
