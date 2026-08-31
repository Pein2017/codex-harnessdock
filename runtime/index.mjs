/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sole public lifecycle seam. Jobs, Harness Drivers, native processes,
 * persistence, completion delivery, session binding, and mailbox details
 * remain internal.
 */
import { createAgentRuntime as createInternalAgentRuntime } from "./agent-runtime.mjs";

export { HARNESSDOCK_MCP_API_GENERATION } from "./mcp-api.mjs";

/**
 * @typedef {object} AgentRuntimeLifecycle
 * @property {(input: object) => Promise<object>} spawn_agent
 * @property {(input: object) => Promise<object>} dispatch_agents
 * @property {(input: object) => object} send_message
 * @property {(input: object) => Promise<object>} followup_task
 * @property {(input?: object) => Promise<object>} wait_agent
 * @property {(input: object) => Promise<object>} interrupt_agent
 * @property {(input: object) => Promise<object>} read_agent_messages
 * @property {(input?: object) => object} list_agents
 * @property {(input?: object) => Promise<object>} list_harnesses
 */

/**
 * The neutral public factory. It owns no Harness identity of its own: which
 * Harness serves an operation is decided by the caller's explicit route at
 * spawn and then frozen on the Agent, never by this seam.
 *
 * @returns {AgentRuntimeLifecycle}
 */
export function createAgentRuntime(options = {}) {
  const runtime = createInternalAgentRuntime(options);
  return Object.freeze({
    spawn_agent: runtime.spawnAgent.bind(runtime),
    dispatch_agents: runtime.dispatchAgents.bind(runtime),
    send_message: runtime.sendMessage.bind(runtime),
    followup_task: runtime.followupTask.bind(runtime),
    wait_agent: runtime.waitAgent.bind(runtime),
    interrupt_agent: runtime.interruptAgent.bind(runtime),
    read_agent_messages: runtime.readAgentMessages.bind(runtime),
    list_agents: runtime.listAgents.bind(runtime),
    list_harnesses: runtime.listHarnesses.bind(runtime),
  });
}
