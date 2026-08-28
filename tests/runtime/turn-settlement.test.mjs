import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateNormalizedTerminalResult } from "../../runtime/harness-contract.mjs";
import {
  acceptDriverRoute,
  createDriverScope,
  inspectDriverInstances,
} from "../../runtime/harness-registry.mjs";
import {
  CONTINUATION_MODES,
  EXECUTION_CONTINUITY_VALUES,
  NATIVE_TURN_STATES,
  NORMALIZED_SETTLEMENT_VALUES,
  PUBLISHABLE_SETTLEMENT_VALUES,
  TURN_SETTLEMENT_FACTS,
  UNREADABLE_TURN_EVIDENCE,
  TURN_SETTLEMENT_REASONS,
  TURN_STATUS_VALUES,
  assertPublishableTerminal,
  carriesTurnSettlementAxes,
  classifyTurnSettlement,
  isPublishableTerminal,
} from "../../runtime/turn-settlement.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";

/**
 * One complete axis set. Every test overrides exactly the axis under proof, so
 * an unrelated default can never explain a publishable or withheld verdict.
 */
function axes(overrides = {}) {
  const { executionWorld, continuation, ...rest } = overrides;
  return {
    status: "completed",
    nativeTurn: "terminal",
    executionWorld: { continuity: "preserved", settlement: "settled", ...(executionWorld ?? {}) },
    continuation: { mode: "exact_resume", nativeSessionRef: null, evidence: {}, ...(continuation ?? {}) },
    ...rest,
  };
}

function scopeInput(driver, overrides = {}) {
  return {
    driver,
    purpose: "turn",
    rootId: "root-fake-service",
    agentId: "agent-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    workspaceRoot: "/workspace",
    route: overrides.route ?? null,
    taskInput: "read the module and report",
    assignedInputs: [],
    deadlineAt: 1_000,
    signal: new AbortController().signal,
    env: { FAKE_SERVICE_HOME: "/srv/fake" },
    ...overrides,
  };
}

/** The exact terminal result a real Driver would return, through real validation. */
async function validatedServiceResult(resultOverride) {
  const { driver } = createFakeServiceDriver({ resultOverride });
  const inspections = await inspectDriverInstances(
    driver,
    createDriverScope(scopeInput(driver, { purpose: "inspect" })),
  );
  const accepted = acceptDriverRoute(
    driver,
    { harnessId: "fake-service", model: "standard-tier", effort: "high", topology: "leaf", authority: "behavioral_read_only" },
    inspections,
  );
  const scope = createDriverScope(scopeInput(driver, { route: accepted.route }));
  const preparedTurn = driver.prepareTurn({ route: accepted.route, taskInput: "read the module and report" });
  const launchContext = driver.revalidatePreparedTurn(preparedTurn, scope);
  const live = await driver.startTurn({ scope, preparedTurn, launchContext });
  return { driver, route: accepted.route, live };
}

describe("turn settlement axes", () => {
  it("keeps native turn, execution settlement, continuity, and continuation independent", () => {
    let checked = 0;
    for (const status of TURN_STATUS_VALUES) {
      for (const nativeTurn of NATIVE_TURN_STATES) {
        for (const settlement of NORMALIZED_SETTLEMENT_VALUES) {
          for (const continuity of EXECUTION_CONTINUITY_VALUES) {
            for (const mode of CONTINUATION_MODES) {
              const result = axes({
                status,
                nativeTurn,
                executionWorld: { continuity, settlement },
                continuation: { mode },
              });
              // Expectation is recomputed here from the two decisive axes only.
              // Continuity and continuation never appear in it, so a passing
              // matrix is itself the independence proof.
              const contradictory =
                status === "completed" && (nativeTurn !== "terminal" || settlement === "active");
              const expected =
                !contradictory &&
                nativeTurn === "terminal" &&
                PUBLISHABLE_SETTLEMENT_VALUES.includes(settlement);
              const classification = classifyTurnSettlement(result);
              assert.equal(
                classification.publishable,
                expected,
                `${status}/${nativeTurn}/${settlement}/${continuity}/${mode}`,
              );
              assert.equal(isPublishableTerminal(result), expected);
              assert.equal(classification.continuity, continuity);
              assert.equal(classification.continuationMode, mode);
              assert.ok(TURN_SETTLEMENT_REASONS.includes(classification.reason));
              checked += 1;
            }
          }
        }
      }
    }
    assert.equal(checked, 3 * 3 * 3 * 4 * 4);
  });

  it("publishes a terminal settled turn whose service, session, and shell stay resident", () => {
    // A persistent operator-owned server and an exactly resumable transcript
    // are residency facts, not outstanding turn-owned work.
    const resident = classifyTurnSettlement(
      axes({ executionWorld: { continuity: "preserved", settlement: "settled" }, continuation: { mode: "exact_resume" } }),
    );
    assert.equal(resident.publishable, true);
    assert.equal(resident.reason, "publishable");
    assert.equal(resident.continuity, "preserved");
    assert.equal(resident.continuationMode, "exact_resume");

    // An idle service turn that owns no execution world states that on the
    // continuity axis; its turn-owned work is still settled, because "nothing
    // to settle" is settled work, not a fourth settlement value.
    const noWorld = classifyTurnSettlement(
      axes({ executionWorld: { continuity: "not_applicable", settlement: "settled" }, continuation: { mode: "none" } }),
    );
    assert.equal(noWorld.publishable, true);
    assert.equal(noWorld.settlement, "settled");
    assert.equal(noWorld.continuity, "not_applicable");
  });

  it("withholds completion when a terminal native turn leaves execution active or unknown", () => {
    const active = classifyTurnSettlement(
      axes({ status: "failed", executionWorld: { continuity: "preserved", settlement: "active" } }),
    );
    assert.equal(active.publishable, false);
    assert.equal(active.reason, "execution_settlement_active");
    assert.equal(active.nativeTurn, "terminal");

    const unknown = classifyTurnSettlement(
      axes({ status: "interrupted", executionWorld: { continuity: "unknown", settlement: "unknown" } }),
    );
    assert.equal(unknown.publishable, false);
    assert.equal(unknown.reason, "execution_settlement_unknown");
    // The unknown evidence is preserved, not rewritten into a terminal claim.
    assert.equal(unknown.settlement, "unknown");
    assert.equal(unknown.nativeTurn, "terminal");
  });

  it("withholds completion for an active or unknown native turn even when execution settled", () => {
    for (const [nativeTurn, reason] of [["active", "native_turn_active"], ["unknown", "native_turn_unknown"]]) {
      const classification = classifyTurnSettlement(axes({ status: "failed", nativeTurn }));
      assert.equal(classification.publishable, false);
      assert.equal(classification.reason, reason);
      assert.equal(classification.settlement, "settled");
    }
  });

  it("names a self-contradictory terminal claim instead of publishing it", () => {
    for (const contradiction of [
      { status: "completed", executionWorld: { settlement: "active" } },
      { status: "completed", nativeTurn: "active" },
      { status: "completed", nativeTurn: "unknown" },
    ]) {
      const classification = classifyTurnSettlement(axes(contradiction));
      assert.equal(classification.publishable, false);
      assert.equal(classification.reason, "contradictory_terminal_evidence");
    }
  });

  it("never lets transcript continuation stand in for execution settlement", () => {
    // Exact transcript resume with a lost execution world is publishable, and
    // a dead transcript with a preserved shell is not: the axes cannot borrow
    // each other's evidence in either direction.
    const resumableLostWorld = classifyTurnSettlement(
      axes({ executionWorld: { continuity: "lost", settlement: "settled" }, continuation: { mode: "exact_resume" } }),
    );
    assert.equal(resumableLostWorld.publishable, true);

    const preservedShellNoTranscript = classifyTurnSettlement(
      axes({ status: "failed", executionWorld: { continuity: "preserved", settlement: "unknown" }, continuation: { mode: "none" } }),
    );
    assert.equal(preservedShellNoTranscript.publishable, false);
    assert.equal(preservedShellNoTranscript.reason, "execution_settlement_unknown");

    for (const mode of CONTINUATION_MODES) {
      assert.equal(isPublishableTerminal(axes({ continuation: { mode } })), true, mode);
      assert.equal(
        isPublishableTerminal(axes({ status: "failed", executionWorld: { settlement: "unknown" }, continuation: { mode } })),
        false,
        mode,
      );
    }
  });

  it("infers nothing from resumability, exit, signal, or other process evidence", () => {
    const processShaped = {
      exitStatus: 0,
      exitCode: 0,
      pid: 4242,
      processId: 4242,
      spawnAccepted: true,
      identityProven: true,
      signalDelivered: true,
      failure: { class: "transport_closed_resumable", reason: null, detail: null, resumable: true, requiresAttention: false },
    };
    assert.equal(
      isPublishableTerminal(axes({ status: "failed", executionWorld: { settlement: "unknown" }, ...processShaped })),
      false,
    );
    assert.equal(
      isPublishableTerminal(
        axes({ status: "failed", ...processShaped, exitStatus: 1, exitCode: 1, failure: { resumable: false } }),
      ),
      true,
    );
    // Process facts are not structural settlement facts, so none of them are
    // reported back either.
    const classification = classifyTurnSettlement(axes({ ...processShaped }));
    for (const field of Object.keys(processShaped)) {
      assert.equal(Object.hasOwn(classification, field), false, field);
    }
  });

  it("returns only bounded structural facts and never the turn's content", () => {
    const classification = classifyTurnSettlement(
      axes({
        finalMessage: "SECRET-ANSWER",
        finalMessageAbsenceReason: null,
        driverReceipt: { harnessId: "fake-service", token: "SECRET-RECEIPT" },
        nativeTurnRef: { locator: { turnId: "SECRET-TURN" } },
        continuation: { evidence: { transcript: "SECRET-TRANSCRIPT" } },
        progress: { touchedFiles: ["SECRET-PATH"] },
      }),
    );
    assert.deepEqual(Object.keys(classification).sort(), [...TURN_SETTLEMENT_FACTS].sort());
    const serialized = JSON.stringify(classification);
    for (const secret of ["SECRET-ANSWER", "SECRET-RECEIPT", "SECRET-TURN", "SECRET-TRANSCRIPT", "SECRET-PATH"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(Object.isFrozen(classification), true);
  });

  it("refuses unknown vocabulary and malformed evidence without throwing", () => {
    for (const malformed of [
      null,
      undefined,
      [],
      "terminal",
      42,
      {},
      axes({ nativeTurn: "finished" }),
      axes({ nativeTurn: null }),
      axes({ status: "cancelled" }),
      axes({ status: null }),
      axes({ executionWorld: { settlement: "done" } }),
      // `not_applicable` is a continuity fact; it is not a settlement value.
      axes({ executionWorld: { settlement: "not_applicable" } }),
      axes({ executionWorld: { continuity: "maybe" } }),
      axes({ continuation: { mode: "resume" } }),
      { ...axes(), executionWorld: null },
      { ...axes(), executionWorld: [] },
      { ...axes(), continuation: null },
    ]) {
      const classification = classifyTurnSettlement(malformed);
      assert.equal(classification.publishable, false);
      assert.equal(classification.reason, "invalid_evidence");
      assert.equal(isPublishableTerminal(malformed), false);
    }
  });

  it("reads each axis once from plain data properties and refuses accessors or a Proxy", () => {
    const reads = [];
    const accessor = axes();
    Object.defineProperty(accessor, "nativeTurn", {
      get() {
        reads.push("nativeTurn");
        return "terminal";
      },
      enumerable: true,
      configurable: true,
    });
    assert.equal(classifyTurnSettlement(accessor).reason, "invalid_evidence");

    const nestedAccessor = axes();
    Object.defineProperty(nestedAccessor.executionWorld, "settlement", {
      get() {
        reads.push("settlement");
        return "settled";
      },
      enumerable: true,
      configurable: true,
    });
    assert.equal(classifyTurnSettlement(nestedAccessor).reason, "invalid_evidence");

    const traps = [];
    const proxied = new Proxy(axes(), {
      get(target, key, receiver) {
        traps.push(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        traps.push(`has:${String(key)}`);
        return Reflect.has(target, key);
      },
    });
    assert.equal(classifyTurnSettlement(proxied).reason, "invalid_evidence");
    assert.equal(isPublishableTerminal(proxied), false);
    assert.deepEqual(reads, []);
    assert.deepEqual(traps, []);
  });

  it("never mutates, freezes, or synthesizes the evidence it reads", () => {
    const result = axes({ status: "failed", executionWorld: { settlement: "unknown" } });
    const before = structuredClone(result);
    classifyTurnSettlement(result);
    isPublishableTerminal(result);
    assert.deepEqual(result, before);
    assert.equal(Object.isFrozen(result), false);
    assert.equal(Object.isFrozen(result.executionWorld), false);
    assert.equal(result.executionWorld.settlement, "unknown");
    assert.equal(result.nativeTurn, "terminal");
  });

  it("asserts publishability with a closed reason and no repair", () => {
    const publishable = axes();
    assert.equal(assertPublishableTerminal(publishable, "completion").reason, "publishable");
    assert.throws(
      () => assertPublishableTerminal(axes({ status: "failed", executionWorld: { settlement: "unknown" } }), "completion"),
      /completion.*execution_settlement_unknown/,
    );
    assert.throws(
      () => assertPublishableTerminal(axes({ nativeTurn: "active", status: "failed" }), "completion"),
      /native_turn_active/,
    );
    assert.throws(() => assertPublishableTerminal(null, "completion"), /invalid_evidence/);
  });

  it("detects settlement axes without claiming anything about legacy evidence", () => {
    assert.equal(carriesTurnSettlementAxes(axes()), true);
    assert.equal(carriesTurnSettlementAxes({ nativeTurn: "unknown" }), true);
    assert.equal(carriesTurnSettlementAxes({ executionWorld: {} }), true);
    // The version-one process-shaped result carries no axis at all.
    assert.equal(
      carriesTurnSettlementAxes({ status: "completed", exitStatus: 0, rawOutput: "done", nativeSession: null }),
      false,
    );
    assert.equal(carriesTurnSettlementAxes(null), false);
    assert.equal(carriesTurnSettlementAxes("terminal"), false);
    assert.equal(carriesTurnSettlementAxes([{ nativeTurn: "terminal" }]), false);
    // Detection stays wider than classification: wrapped or exotic evidence is
    // a claim that must reach the predicate, never one that skips it.
    assert.equal(carriesTurnSettlementAxes(new Proxy({ rawOutput: "done" }, {})), true);
    assert.equal(carriesTurnSettlementAxes(Object.assign([], { nativeTurn: "terminal" })), true);
    for (const wrapped of [
      new Proxy(axes({ status: "failed", executionWorld: { settlement: "unknown" } }), {}),
      new Proxy(axes(), {}),
      Object.assign([], axes()),
    ]) {
      assert.equal(carriesTurnSettlementAxes(wrapped), true);
      assert.equal(isPublishableTerminal(wrapped), false);
      assert.equal(classifyTurnSettlement(wrapped).reason, "invalid_evidence");
    }
  });

  it("detects inherited, class, and partially inherited axes instead of waving them through", () => {
    const unsettled = {
      status: "failed",
      nativeTurn: "terminal",
      executionWorld: { continuity: "preserved", settlement: "unknown" },
      continuation: { mode: "none", nativeSessionRef: null, evidence: {} },
    };
    class TerminalEvidence {}
    Object.assign(TerminalEvidence.prototype, unsettled);
    const partial = Object.create(
      { executionWorld: { continuity: "preserved", settlement: "unknown" } },
      {
        status: { value: "failed", enumerable: true },
        nativeTurn: { value: "terminal", enumerable: true },
        continuation: { value: { mode: "none" }, enumerable: true },
      },
    );
    for (const evidence of [Object.create(unsettled), new TerminalEvidence(), partial]) {
      // Presence on the prototype chain is still a settlement claim: it must
      // reach the predicate and be refused there, never skip detection.
      assert.equal(carriesTurnSettlementAxes(evidence), true);
      assert.equal(classifyTurnSettlement(evidence).reason, "invalid_evidence");
      assert.equal(isPublishableTerminal(evidence), false);
    }
    // A settled-looking inherited claim is refused for the same reason: only
    // the object's own readable axes can publish anything.
    assert.equal(isPublishableTerminal(Object.create(axes())), false);
  });

  it("detects a Proxy anywhere in the evidence prototype chain even when it lies in `has`", () => {
    const unsettled = {
      status: "failed",
      nativeTurn: "terminal",
      executionWorld: { continuity: "preserved", settlement: "unknown" },
      continuation: { mode: "none", nativeSessionRef: null, evidence: {} },
    };
    const traps = [];
    // A lying `has` trap: every axis field reads as absent, the opposite of
    // what `in` would report for the ordinary data one level further up.
    const lyingProto = new Proxy(unsettled, {
      has(target, key) {
        traps.push(`has:${String(key)}`);
        return false;
      },
    });
    const evidence = Object.create(lyingProto);
    assert.equal(carriesTurnSettlementAxes(evidence), true);
    assert.equal(classifyTurnSettlement(evidence).reason, "invalid_evidence");
    assert.equal(isPublishableTerminal(evidence), false);
    // The lying trap is never consulted: presence is decided before any trap
    // on that link could run.
    assert.deepEqual(traps, []);

    const deeplyNested = Object.create(Object.create(lyingProto));
    assert.equal(carriesTurnSettlementAxes(deeplyNested), true);
    assert.equal(isPublishableTerminal(deeplyNested), false);
    assert.deepEqual(traps, []);
  });

  it("never invokes a throwing or alternating `has` trap anywhere in the prototype chain", () => {
    let callCount = 0;
    const throwingProto = new Proxy(
      {
        status: "completed",
        nativeTurn: "terminal",
        executionWorld: { continuity: "preserved", settlement: "settled" },
        continuation: { mode: "exact_resume", nativeSessionRef: null, evidence: {} },
      },
      {
        has() {
          callCount += 1;
          // Alternates between throwing and lying so neither behavior can be
          // relied on by a caller that still invokes the trap.
          if (callCount % 2 === 1) throw new Error("malicious has trap");
          return false;
        },
      },
    );
    const evidence = Object.create(throwingProto);
    assert.doesNotThrow(() => carriesTurnSettlementAxes(evidence));
    assert.equal(carriesTurnSettlementAxes(evidence), true);
    assert.doesNotThrow(() => classifyTurnSettlement(evidence));
    assert.equal(classifyTurnSettlement(evidence).reason, "invalid_evidence");
    assert.doesNotThrow(() => isPublishableTerminal(evidence));
    assert.equal(isPublishableTerminal(evidence), false);
    assert.equal(callCount, 0);
  });

  it("detects axis presence without invoking a single getter", () => {
    let calls = 0;
    const proto = {};
    for (const field of ["nativeTurn", "executionWorld"]) {
      Object.defineProperty(proto, field, {
        get() {
          calls += 1;
          return field === "nativeTurn" ? "terminal" : { continuity: "preserved", settlement: "settled" };
        },
        enumerable: true,
        configurable: true,
      });
    }
    const evidence = Object.create(proto);
    assert.equal(carriesTurnSettlementAxes(evidence), true);
    assert.equal(classifyTurnSettlement(evidence).reason, "invalid_evidence");
    assert.equal(isPublishableTerminal(evidence), false);
    assert.equal(calls, 0);
  });

  it("reads null-prototype canonical evidence exactly like ordinary evidence", () => {
    const bare = (fields) => Object.assign(Object.create(null), fields);
    const settled = bare({
      status: "completed",
      nativeTurn: "terminal",
      executionWorld: bare({ continuity: "preserved", settlement: "settled" }),
      continuation: bare({ mode: "exact_resume" }),
    });
    assert.equal(carriesTurnSettlementAxes(settled), true);
    assert.equal(isPublishableTerminal(settled), true);
    const unknown = bare({
      status: "failed",
      nativeTurn: "terminal",
      executionWorld: bare({ continuity: "unknown", settlement: "unknown" }),
      continuation: bare({ mode: "unknown" }),
    });
    assert.equal(classifyTurnSettlement(unknown).reason, "execution_settlement_unknown");
    assert.equal(isPublishableTerminal(unknown), false);
  });

  it("classifies the unreadable-evidence sentinel as invalid without inventing an axis", () => {
    assert.equal(classifyTurnSettlement(UNREADABLE_TURN_EVIDENCE).reason, "invalid_evidence");
    assert.equal(classifyTurnSettlement(UNREADABLE_TURN_EVIDENCE).publishable, false);
    assert.equal(isPublishableTerminal(UNREADABLE_TURN_EVIDENCE), false);
    assert.throws(
      () => assertPublishableTerminal(UNREADABLE_TURN_EVIDENCE, "completion"),
      /terminal settlement is invalid_evidence/,
    );
    assert.equal(Object.isFrozen(UNREADABLE_TURN_EVIDENCE), true);
  });

  it("keeps one settlement vocabulary with no not-applicable settlement value", () => {
    // The settlement axis has exactly one vocabulary and one publishable value.
    // "Not applicable" is a residency fact and lives only on continuity.
    assert.deepEqual([...NORMALIZED_SETTLEMENT_VALUES], ["settled", "active", "unknown"]);
    assert.deepEqual([...PUBLISHABLE_SETTLEMENT_VALUES], ["settled"]);
    assert.equal(NORMALIZED_SETTLEMENT_VALUES.includes("not_applicable"), false);
    assert.equal(EXECUTION_CONTINUITY_VALUES.includes("not_applicable"), true);
    for (const settlement of PUBLISHABLE_SETTLEMENT_VALUES) {
      assert.ok(NORMALIZED_SETTLEMENT_VALUES.includes(settlement), settlement);
    }
    for (const frozen of [
      NATIVE_TURN_STATES,
      NORMALIZED_SETTLEMENT_VALUES,
      PUBLISHABLE_SETTLEMENT_VALUES,
      EXECUTION_CONTINUITY_VALUES,
      CONTINUATION_MODES,
      TURN_STATUS_VALUES,
      TURN_SETTLEMENT_REASONS,
      TURN_SETTLEMENT_FACTS,
    ]) {
      assert.equal(Object.isFrozen(frozen), true);
    }
  });
});

describe("turn settlement over validated Driver results", () => {
  it("publishes a validated settled service result", async () => {
    const { driver, route, live } = await validatedServiceResult();
    const validated = validateNormalizedTerminalResult(await live.result, { driver, route });
    assert.equal(isPublishableTerminal(validated), true);
    assert.equal(classifyTurnSettlement(validated).reason, "publishable");
  });

  it("keeps honest unknown settlement valid as evidence while refusing to publish it", async () => {
    const { driver, route, live } = await validatedServiceResult((result) => ({
      ...result,
      status: "failed",
      executionWorld: Object.freeze({ continuity: "unknown", settlement: "unknown" }),
      failure: Object.freeze({
        class: "transport_closed_resumable",
        reason: "the worker lost the service turn",
        detail: null,
        resumable: false,
        requiresAttention: true,
      }),
      finalMessage: null,
      finalMessageAbsenceReason: "transport_closed_resumable",
    }));
    // Validation accepts it: unknown owned work is evidence, not corruption.
    const validated = validateNormalizedTerminalResult(await live.result, { driver, route });
    assert.equal(validated.executionWorld.settlement, "unknown");
    assert.equal(validated.nativeTurn, "terminal");
    // Publication is the only thing that is refused.
    assert.equal(isPublishableTerminal(validated), false);
    assert.equal(classifyTurnSettlement(validated).reason, "execution_settlement_unknown");
  });

  it("validates every shape the predicate publishes, including an idle service turn", async () => {
    const { driver, route, live } = await validatedServiceResult((result) => ({
      ...result,
      executionWorld: Object.freeze({ continuity: "not_applicable", settlement: "settled" }),
      continuation: Object.freeze({
        mode: "none",
        nativeSessionRef: null,
        evidence: Object.freeze({ source: "service_turn_status" }),
      }),
    }));
    const valid = await live.result;
    const idle = validateNormalizedTerminalResult(valid, { driver, route });
    assert.equal(idle.executionWorld.continuity, "not_applicable");
    assert.equal(idle.executionWorld.settlement, "settled");
    assert.equal(idle.continuation.mode, "none");
    assert.equal(isPublishableTerminal(idle), true);

    // The normalized schema admits exactly what the predicate may publish.
    for (const settlement of PUBLISHABLE_SETTLEMENT_VALUES) {
      const candidate = { ...valid, executionWorld: { continuity: "preserved", settlement } };
      const validated = validateNormalizedTerminalResult(candidate, { driver, route });
      assert.equal(isPublishableTerminal(validated), true, settlement);
    }
    // And it rejects the settlement value the predicate refuses to read.
    assert.throws(
      () => validateNormalizedTerminalResult(
        { ...valid, executionWorld: { continuity: "not_applicable", settlement: "not_applicable" } },
        { driver, route },
      ),
      /unsupported execution settlement/,
    );
  });

  it("leaves structurally contradictory results rejected before settlement is consulted", async () => {
    const { driver, route, live } = await validatedServiceResult();
    const valid = await live.result;
    assert.throws(
      () => validateNormalizedTerminalResult(
        { ...valid, executionWorld: { continuity: "preserved", settlement: "active" } },
        { driver, route },
      ),
      /completed turn cannot report active owned work/,
    );
    assert.throws(
      () => validateNormalizedTerminalResult({ ...valid, nativeTurn: "unknown" }, { driver, route }),
      /must report nativeTurn=terminal/,
    );
    assert.equal(isPublishableTerminal({ ...valid, nativeTurn: "unknown" }), false);
  });
});
