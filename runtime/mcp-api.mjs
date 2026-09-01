/** SPDX-License-Identifier: Apache-2.0 */

/**
 * Increment only when an existing Codex task's discovered MCP contract can no
 * longer call the checkout runtime safely. Compatible runtime implementation
 * edits keep this generation and hot-load on the next isolated MCP call.
 *
 * Generation 9 added cancellation-safe singular spawn and its bounded public
 * non-rollback-safe failure projection. Generation 10 adds strict stateless
 * `dispatch_agents` rows. Generation 11 adds the optional descriptor-bound
 * terminal publisher to initial spawn and dispatch rows. Older MCP
 * discovery cannot know that an ordered explicit-row request is distinct from
 * singular spawn, so it must restart rather than call a runtime that could
 * accept or misroute batch input.
 */
export const HARNESSDOCK_MCP_API_GENERATION = 11;

/** Every Harness this MCP generation admits, in deterministic alphabetical order. */
export const HARNESSDOCK_MCP_HARNESS_IDS = Object.freeze(["claude-code", "opencode", "pi"]);
