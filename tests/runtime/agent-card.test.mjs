import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectAgentCard } from "../../runtime/agent-card.mjs";

import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const agent = {
  path: "/root/card",
  selectedModel: "claude-haiku-4-5",
  delegationMode: "leaf",
};

describe("Agent Card", () => {
  it("uses retained request and safe public activity without liveness inference", () => {
    assert.deepEqual(projectAgentCard(agent, {
      status: "running",
      startedAt: "2026-08-07T00:00:00.000Z",
      request: { effort: "low", write: false },
      publicProgress: { activity: "tool", updatedAt: "2026-08-07T00:00:05.000Z" },
    }, { now: new Date("2026-08-07T00:00:09.900Z") }), {
      agent_name: "/root/card",
      harness: null,
      route_maturity: null,
      model: "claude-haiku-4-5",
      reasoning_effort: "low",
      authority: "behavioral_read_only",
      delegation_mode: "leaf",
      phase: "tool",
      started_at: "2026-08-07T00:00:00.000Z",
      last_activity_at: "2026-08-07T00:00:05.000Z",
      elapsed_seconds: 9,
    });
  });

  it("keeps private hooks, pruned detail, and unknown authority nullable", () => {
    const hook = projectAgentCard(agent, {
      status: "running",
      startedAt: "2026-08-07T00:00:00.000Z",
      publicProgress: { activity: "hook", updatedAt: "2026-08-07T00:00:06.000Z", summary: "private" },
    }, { now: new Date("2026-08-07T00:00:10.000Z") });
    assert.equal(hook.phase, null);
    assert.equal(hook.last_activity_at, null);
    assert.equal(hook.authority, "unknown");
    assert.deepEqual(projectAgentCard(agent, null, { now: new Date("2026-08-07T00:00:10.000Z") }), {
      agent_name: "/root/card",
      harness: null,
      route_maturity: null,
      model: "claude-haiku-4-5",
      reasoning_effort: null,
      authority: "unknown",
      delegation_mode: "leaf",
      phase: null,
      started_at: null,
      last_activity_at: null,
      elapsed_seconds: null,
    });
  });

  it("uses terminal completion time without exposing activity absent a safe public phase", () => {
    const card = projectAgentCard(agent, {
      status: "completed",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:00:12.900Z",
      request: { write: true },
      result: { lastByteAt: "2026-08-07T00:00:12.000Z" },
    }, { now: new Date("2026-08-07T01:00:00.000Z") });
    assert.equal(card.authority, "behavioral_write");
    assert.equal(card.reasoning_effort, null);
    assert.equal(card.phase, null);
    assert.equal(card.last_activity_at, null);
    assert.equal(card.elapsed_seconds, 12);
  });

  it("rejects arbitrary retained effort and timestamp strings", () => {
    const card = projectAgentCard(agent, {
      status: "running",
      startedAt: "run /tmp/poison-start",
      request: { effort: "/tmp/poison-effort", write: false },
      publicProgress: { activity: "tool", updatedAt: "mailbox:poison-progress" },
      result: { lastByteAt: "cat /tmp/poison-activity" },
    }, { now: new Date("2026-08-07T01:00:00.000Z") });
    assert.equal(card.reasoning_effort, null);
    assert.equal(card.started_at, null);
    assert.equal(card.last_activity_at, null);
    assert.equal(card.elapsed_seconds, null);
    assert.equal(JSON.stringify(card).includes("poison"), false);
  });

  it("keeps terminal elapsed null when no valid completion timestamp exists", () => {
    const job = {
      status: "completed",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "invalid completion timestamp",
      request: { effort: "high", write: false },
    };
    assert.equal(projectAgentCard(agent, job, {
      now: new Date("2026-08-07T01:00:00.000Z"),
    }).elapsed_seconds, null);
    assert.equal(projectAgentCard(agent, { ...job, completedAt: null }, {
      now: new Date("2026-08-08T01:00:00.000Z"),
    }).elapsed_seconds, null);
  });
});

describe("Version-three Agent Card", () => {
  const route = versionThreeRoute({ topology: "native_orchestrator", authority: "behavioral_write" });
  const futureAgent = {
    version: 3,
    path: "/root/future_card",
    route,
    selectedModel: null,
    delegationMode: null,
  };

  it("reads immutable identity from the frozen route, not from turn intent", () => {
    const card = projectAgentCard(futureAgent, {
      status: "running",
      startedAt: "2026-08-13T00:00:00.000Z",
      // A version-three Agent's authority was frozen at creation; a per-turn
      // write intent is historical Claude evidence and must not override it.
      request: { effort: "high", write: false },
      publicProgress: { activity: "thinking", updatedAt: "2026-08-13T00:00:05.000Z" },
    }, { now: new Date("2026-08-13T00:00:08.000Z") });
    assert.deepEqual(card, {
      agent_name: "/root/future_card",
      harness: null,
      route_maturity: "experimental",
      model: "fake-service-large",
      // Version-three effort comes only from immutable route lineage.
      reasoning_effort: "high",
      authority: "behavioral_write",
      delegation_mode: "native_orchestrator",
      phase: "thinking",
      started_at: "2026-08-13T00:00:00.000Z",
      last_activity_at: "2026-08-13T00:00:05.000Z",
      elapsed_seconds: 8,
    });
  });

  it("keeps the frozen route authority without any observed turn", () => {
    const card = projectAgentCard(futureAgent, null, { now: new Date("2026-08-13T00:00:08.000Z") });
    assert.equal(card.authority, "behavioral_write");
    assert.equal(card.model, "fake-service-large");
    assert.equal(card.delegation_mode, "native_orchestrator");
    assert.equal(card.reasoning_effort, "high");
  });

  it("projects a bounded Driver-advertised effort without a fixed enum", () => {
    const card = projectAgentCard({
      ...futureAgent,
      route: versionThreeRoute({ effort: "provider-reasoning-v2" }),
    }, null);
    assert.equal(card.reasoning_effort, "provider-reasoning-v2");
  });
});
