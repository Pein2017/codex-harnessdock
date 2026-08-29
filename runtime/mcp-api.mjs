/** SPDX-License-Identifier: Apache-2.0 */

/**
 * Increment only when an existing Codex task's discovered MCP contract can no
 * longer call the checkout runtime safely. Compatible runtime implementation
 * edits keep this generation and hot-load on the next isolated MCP call.
 *
 * Generation 8 adds the spawn-only `target_worktree` contract. Older MCP
 * discovery cannot know that a supplied target must be admitted before route
 * inspection and frozen separately from the control root, so it must restart
 * rather than call a runtime that could ignore or partially enforce the field.
 */
export const HARNESSDOCK_MCP_API_GENERATION = 8;
