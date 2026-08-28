/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * `runtime/native-reference.mjs` owns the exact core envelope shared by every
 * native session and turn reference, plus the byte/depth/key/scalar bounds and
 * forbidden-key rejection that keep a Driver locator from becoming an
 * open-ended, secret-shaped, or live-transport-carrying blob. This suite tests
 * the module directly, then proves it is actually wired through
 * `harness-contract.mjs` for the fake-service Driver's real turn/terminal
 * pipeline, and finally proves two distinct Harness identities (a fake Claude
 * process/session shape and the fake-service shape) are both admitted while
 * neither can answer for the other's Harness, Driver, instance, or kind.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAUDE_CODE_DRIVER_VERSION,
  CLAUDE_CODE_HARNESS_ID,
} from "../../runtime/claude-code-driver.mjs";
import {
  durableTurnEvidence,
  validateLiveHarnessTurn,
  validateNormalizedTerminalResult,
} from "../../runtime/harness-contract.mjs";
import {
  acceptDriverRoute,
  createDriverScope,
  inspectDriverInstances,
} from "../../runtime/harness-registry.mjs";
import {
  MAX_NATIVE_LOCATOR_BYTES,
  MAX_NATIVE_LOCATOR_DEPTH,
  MAX_NATIVE_LOCATOR_KEYS,
  MAX_NATIVE_LOCATOR_SCALAR_CHARS,
  NATIVE_REFERENCE_ENVELOPE_FIELDS,
  NATIVE_REFERENCE_ENVELOPE_VERSION,
  NATIVE_REFERENCE_KINDS,
  assertNativeReferenceEnvelopeShape,
  assertNativeReferenceLocatorShape,
  forbiddenNativeLocatorKeyCategory,
  validateNativeReferenceEnvelope,
} from "../../runtime/native-reference.mjs";
import {
  FAKE_SERVICE_HARNESS_ID,
  createFakeServiceDriver,
} from "./fixtures/fake-service-driver.mjs";

/**
 * A minimal Driver Contract v2 locator surface standing in for the future
 * `claude-code-driver.mjs` v2 façade (task 6, not implemented here). It
 * exists only to prove native-reference validation against a second,
 * distinctly shaped Harness identity: a verified process/turn identity
 * (`pid` plus `nativeSessionId`) alongside a separate reusable session
 * identity (`nativeSessionId` alone), matching design.md decision 14's
 * Claude row ("verified PID identity plus native session evidence").
 */
const FAKE_CLAUDE_HARNESS_ID = CLAUDE_CODE_HARNESS_ID;
const FAKE_CLAUDE_DRIVER_VERSION = CLAUDE_CODE_DRIVER_VERSION;
const FAKE_CLAUDE_INSTANCE_KEY = "claude-default";

function createFakeClaudeReferenceDriver() {
  return {
    harnessId: FAKE_CLAUDE_HARNESS_ID,
    driverVersion: FAKE_CLAUDE_DRIVER_VERSION,
    validateNativeSessionRef(ref) {
      if (ref.locatorVersion !== 1) {
        throw new Error("claude session locator version drift");
      }
      const keys = Object.keys(ref.locator).sort();
      if (keys.length !== 1 || keys[0] !== "nativeSessionId" || typeof ref.locator.nativeSessionId !== "string") {
        throw new Error("claude session locator must be exactly {nativeSessionId}");
      }
      return ref;
    },
    validateNativeTurnRef(ref) {
      if (ref.locatorVersion !== 1) {
        throw new Error("claude turn locator version drift");
      }
      const keys = Object.keys(ref.locator).sort();
      if (
        keys.length !== 2 || keys[0] !== "nativeSessionId" || keys[1] !== "pid" ||
        typeof ref.locator.pid !== "number"
      ) {
        throw new Error("claude turn locator must be exactly {nativeSessionId, pid}");
      }
      return ref;
    },
  };
}

function claudeSessionRef(overrides = {}) {
  return {
    version: 1,
    harnessId: FAKE_CLAUDE_HARNESS_ID,
    driverVersion: FAKE_CLAUDE_DRIVER_VERSION,
    instanceKey: FAKE_CLAUDE_INSTANCE_KEY,
    locatorVersion: 1,
    locator: { nativeSessionId: "claude-session-abc123" },
    ...overrides,
  };
}

function claudeTurnRef(overrides = {}) {
  return {
    version: 1,
    harnessId: FAKE_CLAUDE_HARNESS_ID,
    driverVersion: FAKE_CLAUDE_DRIVER_VERSION,
    instanceKey: FAKE_CLAUDE_INSTANCE_KEY,
    locatorVersion: 1,
    locator: { nativeSessionId: "claude-session-abc123", pid: 4242 },
    ...overrides,
  };
}

function serviceSessionRef(driver, overrides = {}) {
  return {
    version: 1,
    harnessId: driver.harnessId,
    driverVersion: driver.driverVersion,
    instanceKey: "tenant-alpha",
    locatorVersion: 1,
    locator: { sessionId: "session-xyz" },
    ...overrides,
  };
}

function serviceTurnRef(driver, overrides = {}) {
  return {
    version: 1,
    harnessId: driver.harnessId,
    driverVersion: driver.driverVersion,
    instanceKey: "tenant-alpha",
    locatorVersion: 1,
    locator: { sessionId: "session-xyz", turnId: "turn-1" },
    ...overrides,
  };
}

describe("native reference envelope shape", () => {
  it("closes the envelope field set and version", () => {
    assert.deepEqual(NATIVE_REFERENCE_ENVELOPE_FIELDS, [
      "version",
      "harnessId",
      "driverVersion",
      "instanceKey",
      "locatorVersion",
      "locator",
    ]);
    assert.equal(NATIVE_REFERENCE_ENVELOPE_VERSION, 1);
    assert.deepEqual(NATIVE_REFERENCE_KINDS, ["session", "turn"]);
  });

  it("accepts a well-formed envelope and returns a snapshot equal to it", () => {
    // The return value is a freshly built snapshot (read once, field by
    // field), not `ref` itself by identity -- see the "envelope snapshot"
    // hardening suite for why a getter/Proxy makes that distinction load-bearing.
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    const snapshot = assertNativeReferenceEnvelopeShape(ref, "test reference");
    assert.notEqual(snapshot, ref);
    assert.deepEqual(snapshot, ref);
  });

  it("rejects a non-object, an array, and null", () => {
    for (const bad of [null, undefined, "ref", 42, [], ["a"]]) {
      assert.throws(
        () => assertNativeReferenceEnvelopeShape(bad, "test reference"),
        /must be a plain object/,
      );
    }
  });

  it("rejects an unknown top-level field and a missing field", () => {
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    assert.throws(
      () => assertNativeReferenceEnvelopeShape({ ...ref, endpoint: "https://service.invalid" }, "test reference"),
      /declares an unknown field: endpoint/,
    );
    const { locatorVersion: _locatorVersion, ...withoutLocatorVersion } = ref;
    assert.throws(
      () => assertNativeReferenceEnvelopeShape(withoutLocatorVersion, "test reference"),
      /missing required field: locatorVersion/,
    );
  });

  it("rejects envelope version drift", () => {
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    for (const version of [0, 2, "1", null, undefined]) {
      assert.throws(
        () => assertNativeReferenceEnvelopeShape({ ...ref, version }, "test reference"),
        /unsupported envelope version/,
      );
    }
  });

  it("rejects an invalid Harness ID, Driver version, instance key, and locator version", () => {
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    assert.throws(
      () => assertNativeReferenceEnvelopeShape({ ...ref, harnessId: "Fake_Service" }, "test reference"),
      /invalid Harness ID/,
    );
    assert.throws(
      () => assertNativeReferenceEnvelopeShape({ ...ref, driverVersion: "" }, "test reference"),
      /invalid Driver version/,
    );
    assert.throws(
      () => assertNativeReferenceEnvelopeShape({ ...ref, driverVersion: "x".repeat(200) }, "test reference"),
      /invalid Driver version/,
    );
    assert.throws(
      () => assertNativeReferenceEnvelopeShape({ ...ref, instanceKey: "Tenant/Alpha" }, "test reference"),
      /invalid logical instance key/,
    );
    for (const locatorVersion of [0, -1, 1.5, "1", null]) {
      assert.throws(
        () => assertNativeReferenceEnvelopeShape({ ...ref, locatorVersion }, "test reference"),
        /invalid locator version/,
      );
    }
  });
});

describe("native reference locator bounds", () => {
  it("admits a small flat locator and returns a canonical frozen clone", () => {
    const locator = { sessionId: "session-xyz", turnId: "turn-1" };
    const canonical = assertNativeReferenceLocatorShape(locator, "test");
    assert.deepEqual(canonical, locator);
    assert.notEqual(canonical, locator);
    assert.ok(Object.isFrozen(canonical));
    assert.throws(() => { canonical.turnId = "tampered"; }, TypeError);
  });

  it("rejects a locator that is not a plain object", () => {
    for (const bad of [null, "x", 1, true, [], ["sessionId"]]) {
      assert.throws(
        () => assertNativeReferenceLocatorShape(bad, "test"),
        /locator must be a bounded plain object/,
      );
    }
  });

  it("rejects functions, thenables, class instances, and built-in containers", () => {
    class Handle {}
    const cases = [
      { locator: { onDone: () => {} }, pattern: /must not carry a function or callback/ },
      // A real Promise is refused by the plain-object prototype check (its
      // prototype is Promise.prototype, never Object.prototype) -- `.then`
      // is never read, so this is safe even against a Promise subclass whose
      // `then` is a malicious getter. See the "array then getter" and
      // "envelope field defined as a getter" hardening tests for the direct
      // "a getter is never invoked" proof.
      { locator: { pending: Promise.resolve(1) }, pattern: /must be a plain data object/ },
      { locator: { handle: new Handle() }, pattern: /must be a plain data object/ },
      { locator: { when: new Date() }, pattern: /must be a plain data object/ },
      { locator: { seen: new Map() }, pattern: /must be a plain data object/ },
      { locator: { id: Symbol("x") }, pattern: /must not carry a symbol value/ },
      { locator: { id: 10n }, pattern: /must not carry a bigint value/ },
    ];
    for (const { locator, pattern } of cases) {
      assert.throws(() => assertNativeReferenceLocatorShape(locator, "test"), pattern);
    }
  });

  it("rejects a getter/setter accessor and a non-enumerable field", () => {
    const withGetter = {};
    Object.defineProperty(withGetter, "sessionId", { get: () => "x", enumerable: true, configurable: true });
    assert.throws(
      () => assertNativeReferenceLocatorShape(withGetter, "test"),
      /getter\/setter accessor/,
    );
    const withHidden = {};
    Object.defineProperty(withHidden, "sessionId", { value: "x", enumerable: false, configurable: true, writable: true });
    assert.throws(
      () => assertNativeReferenceLocatorShape(withHidden, "test"),
      /must be an enumerable own property/,
    );
    const withSymbol = { sessionId: "x" };
    withSymbol[Symbol("hidden")] = "y";
    assert.throws(
      () => assertNativeReferenceLocatorShape(withSymbol, "test"),
      /must not carry symbol-keyed fields/,
    );
  });

  it("rejects a cycle without recursing forever", () => {
    const cyclic = { sessionId: "session-xyz" };
    cyclic.self = cyclic;
    assert.throws(() => assertNativeReferenceLocatorShape(cyclic, "test"), /contains a cycle/);
    const arrayCycle = { items: [] };
    arrayCycle.items.push(arrayCycle);
    assert.throws(() => assertNativeReferenceLocatorShape(arrayCycle, "test"), /contains a cycle/);
  });

  it("enforces the explicit depth bound", () => {
    let nested = { leaf: 1 };
    for (let level = 0; level < MAX_NATIVE_LOCATOR_DEPTH; level += 1) {
      nested = { child: nested };
    }
    assert.throws(
      () => assertNativeReferenceLocatorShape(nested, "test"),
      new RegExp(`maximum nesting depth of ${MAX_NATIVE_LOCATOR_DEPTH}`),
    );
  });

  it("enforces the explicit key-count bound for objects and arrays", () => {
    const wideObject = {};
    for (let i = 0; i < MAX_NATIVE_LOCATOR_KEYS + 1; i += 1) wideObject[`k${i}`] = i;
    assert.throws(
      () => assertNativeReferenceLocatorShape(wideObject, "test"),
      new RegExp(`exceeds ${MAX_NATIVE_LOCATOR_KEYS} fields`),
    );
    const wideArray = { items: Array.from({ length: MAX_NATIVE_LOCATOR_KEYS + 1 }, (_v, i) => i) };
    assert.throws(
      () => assertNativeReferenceLocatorShape(wideArray, "test"),
      new RegExp(`exceeds ${MAX_NATIVE_LOCATOR_KEYS} items`),
    );
  });

  it("enforces the explicit scalar-length bound independent of total byte size", () => {
    const overSized = { sessionId: "x".repeat(MAX_NATIVE_LOCATOR_SCALAR_CHARS + 1) };
    assert.throws(
      () => assertNativeReferenceLocatorShape(overSized, "test"),
      new RegExp(`exceeds ${MAX_NATIVE_LOCATOR_SCALAR_CHARS} characters`),
    );
  });

  it("enforces the explicit total byte bound even when every scalar is individually admitted", () => {
    const locator = {};
    for (let i = 0; i < 9; i += 1) locator[`field${i}`] = "y".repeat(MAX_NATIVE_LOCATOR_SCALAR_CHARS);
    assert.ok(JSON.stringify({ field0: "y".repeat(MAX_NATIVE_LOCATOR_SCALAR_CHARS) }).length < MAX_NATIVE_LOCATOR_BYTES);
    assert.throws(
      () => assertNativeReferenceLocatorShape(locator, "test"),
      new RegExp(`exceeds ${MAX_NATIVE_LOCATOR_BYTES} bytes`),
    );
  });

  it("rejects a NUL byte, NaN, Infinity, and an explicit undefined value", () => {
    assert.throws(() => assertNativeReferenceLocatorShape({ sessionId: "a\0b" }, "test"), /NUL byte/);
    assert.throws(() => assertNativeReferenceLocatorShape({ retries: NaN }, "test"), /finite number/);
    assert.throws(() => assertNativeReferenceLocatorShape({ retries: Infinity }, "test"), /finite number/);
    assert.throws(() => assertNativeReferenceLocatorShape({ sessionId: undefined }, "test"), /undefined value/);
  });

  it("classifies forbidden secret/config/prompt/output/endpoint/environment keys and admits ordinary identity keys", () => {
    const forbidden = {
      apiKey: "secret",
      api_key: "secret",
      authorization: "secret",
      cookie: "secret",
      headers: "secret",
      config: "secret",
      settings: "secret",
      prompt: "secret",
      systemPrompt: "secret",
      output: "secret",
      finalMessage: "secret",
      endpoint: "secret",
      baseUrl: "secret",
      env: "secret",
      environment: "secret",
    };
    const expectedCategory = {
      apiKey: "secret", api_key: "secret", authorization: "secret", cookie: "secret", headers: "secret",
      config: "config", settings: "config",
      prompt: "prompt", systemPrompt: "prompt",
      output: "output", finalMessage: "output",
      endpoint: "endpoint", baseUrl: "endpoint",
      env: "environment", environment: "environment",
    };
    for (const [key, category] of Object.entries(expectedCategory)) {
      assert.equal(forbiddenNativeLocatorKeyCategory(key), category, key);
      assert.throws(
        () => assertNativeReferenceLocatorShape({ [key]: forbidden[key] }, "test"),
        new RegExp(`forbidden ${category}-shaped key`),
      );
    }
    for (const admitted of ["sessionId", "turnId", "nativeSessionId", "pid", "instanceKey", "sequence"]) {
      assert.equal(forbiddenNativeLocatorKeyCategory(admitted), null, admitted);
    }
    assert.deepEqual(
      assertNativeReferenceLocatorShape({ sessionId: "s1", turnId: "t1", pid: 99 }, "test"),
      { sessionId: "s1", turnId: "t1", pid: 99 },
    );
  });
});

describe("native reference Driver-integrated validation", () => {
  it("requires an explicit kind and the owning Driver", () => {
    const { driver } = createFakeServiceDriver();
    const ref = serviceSessionRef(driver);
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { driver }),
      /requires an explicit kind of session or turn/,
    );
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { kind: "session" }),
      /requires the owning Harness Driver/,
    );
  });

  it("validates a positive fake-service session and turn reference", () => {
    const { driver } = createFakeServiceDriver();
    const session = validateNativeReferenceEnvelope(serviceSessionRef(driver), { driver, kind: "session" });
    assert.equal(session.locator.sessionId, "session-xyz");
    const turn = validateNativeReferenceEnvelope(serviceTurnRef(driver), { driver, kind: "turn" });
    assert.equal(turn.locator.turnId, "turn-1");
  });

  it("refuses a session reference used as a turn reference, and a turn reference used as a session reference", () => {
    const { driver } = createFakeServiceDriver();
    assert.throws(
      () => validateNativeReferenceEnvelope(serviceSessionRef(driver), { driver, kind: "turn" }),
      /turn locator must be exactly \{sessionId, turnId\}/,
    );
    assert.throws(
      () => validateNativeReferenceEnvelope(serviceTurnRef(driver), { driver, kind: "session" }),
      /session locator must be exactly \{sessionId\}/,
    );
  });

  it("refuses a foreign Harness, foreign Driver version, and foreign logical instance", () => {
    const { driver } = createFakeServiceDriver();
    assert.throws(
      () => validateNativeReferenceEnvelope(
        serviceSessionRef(driver, { harnessId: "other-service" }),
        { driver, kind: "session" },
      ),
      /belongs to Harness "other-service"/,
    );
    assert.throws(
      () => validateNativeReferenceEnvelope(
        serviceSessionRef(driver, { driverVersion: "fake-service@2" }),
        { driver, kind: "session" },
      ),
      /foreign Driver version/,
    );
    const route = { instanceKey: "tenant-beta" };
    assert.throws(
      () => validateNativeReferenceEnvelope(serviceSessionRef(driver), { driver, kind: "session", route }),
      /belongs to logical instance "tenant-alpha"; expected tenant-beta/,
    );
    // No route supplied means no instance cross-check is possible or attempted.
    assert.equal(
      validateNativeReferenceEnvelope(serviceSessionRef(driver), { driver, kind: "session" }).instanceKey,
      "tenant-alpha",
    );
  });

  it("fails closed on a locator version the Driver no longer understands, without ever resuming or signalling", () => {
    const { driver } = createFakeServiceDriver();
    assert.throws(
      () => validateNativeReferenceEnvelope(
        serviceSessionRef(driver, { locatorVersion: 2 }),
        { driver, kind: "session" },
      ),
      /fake service native session reference is not valid for this Driver/,
    );
  });

  it("rejects a Driver that returns no validator for the requested kind", () => {
    const bareDriver = { harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" };
    assert.throws(
      () => validateNativeReferenceEnvelope(serviceSessionRef(bareDriver), { driver: bareDriver, kind: "session" }),
      /does not implement a native session reference validator/,
    );
  });

  it("rejects a Driver validator that alters, widens, or refuses to return the bounded envelope", () => {
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    const tamperingDriver = {
      harnessId: FAKE_SERVICE_HARNESS_ID,
      driverVersion: "fake-service@1",
      validateNativeSessionRef: (candidate) => ({ ...candidate, locator: { ...candidate.locator, extra: "x" } }),
    };
    // The identity-only contract (finding 3 of the independent review) unifies
    // every non-identical return -- clone, alteration, or refusal -- under one
    // message; a Driver may only confirm the exact object it was given.
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { driver: tamperingDriver, kind: "session" }),
      /must return the exact bounded reference object it was given, by identity/,
    );
    const silentDriver = {
      harnessId: FAKE_SERVICE_HARNESS_ID,
      driverVersion: "fake-service@1",
      validateNativeSessionRef: () => null,
    };
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { driver: silentDriver, kind: "session" }),
      /must return the exact bounded reference object it was given, by identity/,
    );
  });

  it("enforces bounds and forbidden keys before an overly permissive Driver ever sees the locator", () => {
    const permissiveDriver = {
      harnessId: FAKE_SERVICE_HARNESS_ID,
      driverVersion: "fake-service@1",
      validateNativeSessionRef: (candidate) => candidate,
      validateNativeTurnRef: (candidate) => candidate,
    };
    const withSecret = serviceSessionRef(permissiveDriver, { locator: { sessionId: "s1", apiKey: "sk-live" } });
    assert.throws(
      () => validateNativeReferenceEnvelope(withSecret, { driver: permissiveDriver, kind: "session" }),
      /forbidden secret-shaped key/,
    );
    const withCallback = serviceSessionRef(permissiveDriver, { locator: { sessionId: "s1", onEvent: () => {} } });
    assert.throws(
      () => validateNativeReferenceEnvelope(withCallback, { driver: permissiveDriver, kind: "session" }),
      /must not carry a function or callback/,
    );
  });

  it("returns canonical, deep-frozen, JSON-safe data", () => {
    const { driver } = createFakeServiceDriver();
    const canonical = validateNativeReferenceEnvelope(serviceTurnRef(driver), { driver, kind: "turn" });
    assert.deepEqual(JSON.parse(JSON.stringify(canonical)), canonical);
    assert.ok(Object.isFrozen(canonical));
    assert.ok(Object.isFrozen(canonical.locator));
    assert.throws(() => { canonical.locator.turnId = "tampered"; }, TypeError);
  });
});

describe("distinct positive Claude and fake-service native identities", () => {
  it("admits both Harnesses' own session and turn shapes", () => {
    const claude = createFakeClaudeReferenceDriver();
    const { driver: service } = createFakeServiceDriver();

    const claudeSession = validateNativeReferenceEnvelope(claudeSessionRef(), { driver: claude, kind: "session" });
    const claudeTurn = validateNativeReferenceEnvelope(claudeTurnRef(), { driver: claude, kind: "turn" });
    assert.equal(claudeSession.harnessId, "claude-code");
    assert.equal(claudeTurn.locator.pid, 4242);

    const serviceSession = validateNativeReferenceEnvelope(serviceSessionRef(service), { driver: service, kind: "session" });
    const serviceTurn = validateNativeReferenceEnvelope(serviceTurnRef(service), { driver: service, kind: "turn" });
    assert.equal(serviceSession.harnessId, "fake-service");
    assert.equal(serviceTurn.locator.turnId, "turn-1");
  });

  it("never lets one Harness's reference validate against the other Harness's Driver", () => {
    const claude = createFakeClaudeReferenceDriver();
    const { driver: service } = createFakeServiceDriver();
    assert.throws(
      () => validateNativeReferenceEnvelope(serviceSessionRef(service), { driver: claude, kind: "session" }),
      /belongs to Harness "fake-service"; expected claude-code/,
    );
    assert.throws(
      () => validateNativeReferenceEnvelope(claudeSessionRef(), { driver: service, kind: "session" }),
      /belongs to Harness "claude-code"; expected fake-service/,
    );
  });

  it("never lets Claude's own session reference stand in for a Claude turn reference, or the reverse", () => {
    const claude = createFakeClaudeReferenceDriver();
    assert.throws(
      () => validateNativeReferenceEnvelope(claudeSessionRef(), { driver: claude, kind: "turn" }),
      /claude turn locator must be exactly \{nativeSessionId, pid\}/,
    );
    assert.throws(
      () => validateNativeReferenceEnvelope(claudeTurnRef(), { driver: claude, kind: "session" }),
      /claude session locator must be exactly \{nativeSessionId\}/,
    );
  });
});

/**
 * The generic turn path composed only from Harness-neutral exports, mirroring
 * `tests/runtime/harness-driver-contract.test.mjs`'s own helper. It exists
 * here, independently, so this suite can prove the wiring inside
 * `harness-contract.mjs` without importing another test file's internals.
 */
function routeRequest(overrides = {}) {
  return {
    harnessId: FAKE_SERVICE_HARNESS_ID,
    model: "standard-tier",
    effort: "high",
    topology: "leaf",
    authority: "behavioral_read_only",
    ...overrides,
  };
}

function scopeInput(driver, overrides = {}) {
  return {
    driver,
    purpose: "turn",
    rootId: "root-native-reference",
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

async function acceptFakeServiceRoute(driver) {
  const inspectionScope = createDriverScope(scopeInput(driver, { purpose: "inspect" }));
  const inspections = await inspectDriverInstances(driver, inspectionScope);
  return acceptDriverRoute(driver, routeRequest(), inspections);
}

async function runGenericServiceTurn(driver) {
  const accepted = await acceptFakeServiceRoute(driver);
  const taskInput = "read the module and report";
  const scope = createDriverScope(scopeInput(driver, { route: accepted.route, taskInput }));
  const preparedTurn = driver.prepareTurn({ route: accepted.route, taskInput });
  const launchContext = driver.revalidatePreparedTurn(preparedTurn, scope);
  const live = await driver.startTurn({ scope, preparedTurn, launchContext });
  return { accepted, scope, preparedTurn, live };
}

describe("native-reference integration through harness-contract.mjs", () => {
  it("accepts a genuine fake-service turn's evidence as canonical, JSON-safe, persist-ready data", async () => {
    const { driver } = createFakeServiceDriver();
    const { accepted, live: rawLive } = await runGenericServiceTurn(driver);
    const live = validateLiveHarnessTurn(rawLive, { driver, route: accepted.route });
    const evidence = durableTurnEvidence(live);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
    assert.equal(evidence.nativeTurnRef.locator.turnId, "service-turn-1");

    const result = validateNormalizedTerminalResult(await live.result, { driver, route: accepted.route });
    assert.equal(result.nativeTurnRef.locator.turnId, "service-turn-1");
    assert.equal(result.continuation.nativeSessionRef.locator.sessionId, "service-session-1");
    await live.dispose();
  });

  it("fails a live turn closed, before input can be considered accepted, when the Driver returns an open-ended turn locator", async () => {
    const { driver } = createFakeServiceDriver({
      liveTurnOverride: (live) => ({
        ...live,
        nativeTurnRef: {
          ...live.nativeTurnRef,
          locator: { ...live.nativeTurnRef.locator, apiKey: "sk-live-secret" },
        },
      }),
    });
    const { accepted, live } = await runGenericServiceTurn(driver);
    assert.throws(
      () => validateLiveHarnessTurn(live, { driver, route: accepted.route }),
      /forbidden secret-shaped key/,
    );
  });

  it("fails a live turn closed when the Driver returns a locator over its explicit byte bound", async () => {
    const { driver } = createFakeServiceDriver({
      liveTurnOverride: (live) => ({
        ...live,
        nativeTurnRef: {
          ...live.nativeTurnRef,
          locator: { ...live.nativeTurnRef.locator, blob: "y".repeat(MAX_NATIVE_LOCATOR_BYTES) },
        },
      }),
    });
    const { accepted, live } = await runGenericServiceTurn(driver);
    assert.throws(
      () => validateLiveHarnessTurn(live, { driver, route: accepted.route }),
      /exceeds .* characters|exceeds .* bytes/,
    );
  });

  it("fails a terminal result closed when its continuation session locator carries a live callback", async () => {
    const { driver } = createFakeServiceDriver({
      resultOverride: (result) => ({
        ...result,
        continuation: {
          ...result.continuation,
          nativeSessionRef: {
            ...result.continuation.nativeSessionRef,
            locator: { ...result.continuation.nativeSessionRef.locator, onUpdate: () => {} },
          },
        },
      }),
    });
    const { accepted, live } = await runGenericServiceTurn(driver);
    const result = await live.result;
    assert.throws(
      () => validateNormalizedTerminalResult(result, { driver, route: accepted.route }),
      /must not carry a function or callback/,
    );
  });

  it("still refuses a session reference substituted for a turn reference through the live-turn path", async () => {
    const { driver } = createFakeServiceDriver({
      liveTurnOverride: (live) => ({ ...live, nativeTurnRef: live.nativeSessionRef }),
    });
    const { accepted, live } = await runGenericServiceTurn(driver);
    assert.throws(
      () => validateLiveHarnessTurn(live, { driver, route: accepted.route }),
      /turn locator must be exactly \{sessionId, turnId\}/,
    );
  });
});

/**
 * Independent-review correction: every test below reproduces a specific
 * exploit the reviewer demonstrated against the first pass. Each proves not
 * merely that validation throws, but that no attacker-controlled getter,
 * Proxy trap, or `Array.prototype`/`Object.prototype` method was ever
 * invoked while reaching that rejection — the "hooks never execute" property
 * is the thing under test, not just the final throw.
 */
describe("hardening: array traversal never trusts reflection (finding 1)", () => {
  it("never calls a globally hijacked Array.prototype.map", () => {
    const original = Array.prototype.map;
    let called = false;
    Array.prototype.map = function hijacked(...args) {
      called = true;
      return original.apply(this, args);
    };
    try {
      const canonical = assertNativeReferenceLocatorShape({ items: ["a", "b"] }, "test");
      assert.equal(called, false);
      assert.deepEqual(canonical.items, ["a", "b"]);
    } finally {
      Array.prototype.map = original;
    }
  });

  it("rejects an array carrying an own accessor field (array 'then' getter) without invoking it", () => {
    const arr = ["a"];
    let getterCalls = 0;
    Object.defineProperty(arr, "then", {
      get() { getterCalls += 1; return () => {}; },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: arr }, "test"),
      /non-index field/,
    );
    assert.equal(getterCalls, 0);
  });

  it("rejects an array element defined as a getter/setter accessor without invoking it", () => {
    const arr = ["a", "b"];
    let getterCalls = 0;
    Object.defineProperty(arr, "0", {
      get() { getterCalls += 1; return "hijacked"; },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: arr }, "test"),
      /accessor/,
    );
    assert.equal(getterCalls, 0);
  });

  it("rejects a sparse array with a hole", () => {
    const arr = [1, , 3]; // eslint-disable-line no-sparse-arrays
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: arr }, "test"),
      /hole/,
    );
  });

  it("rejects an array with a non-canonical extra own key", () => {
    const arr = ["a", "b"];
    arr.extra = "smuggled";
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: arr }, "test"),
      /non-index field: "extra"/,
    );
  });

  it("rejects a subclassed or prototype-swapped array", () => {
    class EvilArray extends Array {}
    const subclassed = EvilArray.from([1, 2, 3]);
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: subclassed }, "test"),
      /ordinary Array/,
    );
    const swapped = [1, 2, 3];
    Object.setPrototypeOf(swapped, {});
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: swapped }, "test"),
      /ordinary Array/,
    );
  });

  it("rejects a Proxy-wrapped array or object before any reflective operation", () => {
    let trapCalls = 0;
    const proxyArray = new Proxy(["a", "b"], {
      get(target, prop, receiver) { trapCalls += 1; return Reflect.get(target, prop, receiver); },
      ownKeys(target) { trapCalls += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) { trapCalls += 1; return Reflect.getOwnPropertyDescriptor(target, prop); },
    });
    assert.throws(
      () => assertNativeReferenceLocatorShape({ items: proxyArray }, "test"),
      /must not be a Proxy/,
    );
    assert.equal(trapCalls, 0);

    const proxyObject = new Proxy({ sessionId: "s1" }, {
      get(target, prop, receiver) { trapCalls += 1; return Reflect.get(target, prop, receiver); },
    });
    assert.throws(
      () => assertNativeReferenceLocatorShape(proxyObject, "test"),
      /must not be a Proxy/,
    );
    assert.equal(trapCalls, 0);
  });

  it("rejects the combined reviewer exploit payload (apiKey/endpoint/socket/callback/depth overflow) in one pass", () => {
    class FakeSocket {}
    const payload = {
      sessionId: "s1",
      apiKey: "sk-live-should-be-rejected",
      endpoint: "https://evil.example/exfiltrate",
      socket: new FakeSocket(),
      callback: () => {},
      nested: { a: { b: { c: { d: { e: 1 } } } } },
    };
    assert.throws(() => assertNativeReferenceLocatorShape(payload, "test"));
  });
});

describe("hardening: envelope snapshot never trusts reflection (finding 2)", () => {
  it("rejects a Proxy-wrapped envelope before any reflective operation", () => {
    const { driver } = createFakeServiceDriver();
    let trapCalls = 0;
    const proxyRef = new Proxy(serviceSessionRef(driver), {
      get(target, prop, receiver) { trapCalls += 1; return Reflect.get(target, prop, receiver); },
      getOwnPropertyDescriptor(target, prop) { trapCalls += 1; return Reflect.getOwnPropertyDescriptor(target, prop); },
      ownKeys(target) { trapCalls += 1; return Reflect.ownKeys(target); },
    });
    assert.throws(
      () => validateNativeReferenceEnvelope(proxyRef, { driver, kind: "session" }),
      /must not be a Proxy/,
    );
    assert.equal(trapCalls, 0);
  });

  it("rejects an envelope field defined as a getter without ever invoking it, even though it would return the correct value", () => {
    const { driver } = createFakeServiceDriver();
    let getterCalls = 0;
    const ref = {
      version: 1,
      driverVersion: driver.driverVersion,
      instanceKey: "tenant-alpha",
      locatorVersion: 1,
      locator: { sessionId: "s1" },
    };
    Object.defineProperty(ref, "harnessId", {
      get() { getterCalls += 1; return driver.harnessId; },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { driver, kind: "session" }),
      /getter\/setter accessor/,
    );
    assert.equal(getterCalls, 0);
  });

  it("rejects a symbol-keyed envelope field", () => {
    const { driver } = createFakeServiceDriver();
    const withSymbol = { ...serviceSessionRef(driver) };
    withSymbol[Symbol("hidden")] = "y";
    assert.throws(
      () => validateNativeReferenceEnvelope(withSymbol, { driver, kind: "session" }),
      /symbol-keyed/,
    );
  });

  it("rejects a non-enumerable required field and a prototype-inherited (not own) required field", () => {
    const { driver } = createFakeServiceDriver();
    const base = {
      version: 1,
      driverVersion: driver.driverVersion,
      instanceKey: "tenant-alpha",
      locatorVersion: 1,
      locator: { sessionId: "s1" },
    };
    const withHiddenField = { ...base };
    Object.defineProperty(withHiddenField, "harnessId", {
      value: driver.harnessId, enumerable: false, configurable: true, writable: true,
    });
    assert.throws(
      () => validateNativeReferenceEnvelope(withHiddenField, { driver, kind: "session" }),
      /enumerable own property/,
    );

    // `Object.create({harnessId: ...})` inherits harnessId from a prototype
    // that is not itself `Object.prototype`, so the exact-plain-object check
    // refuses it before a per-field own-key check would even run -- a
    // strictly earlier and stronger rejection than "missing required field".
    const inherited = Object.assign(Object.create({ harnessId: driver.harnessId }), base);
    assert.throws(
      () => validateNativeReferenceEnvelope(inherited, { driver, kind: "session" }),
      /must be a plain object/,
    );
  });
});

describe("hardening: Driver validator confirms or refuses by identity only (finding 3)", () => {
  it("rejects a Driver validator that returns a deep-equal clone instead of the exact bounded reference", () => {
    const cloningDriver = {
      harnessId: FAKE_SERVICE_HARNESS_ID,
      driverVersion: "fake-service@1",
      validateNativeSessionRef: (candidate) => ({ ...candidate, locator: { ...candidate.locator } }),
    };
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { driver: cloningDriver, kind: "session" }),
      /exact bounded reference/,
    );
  });

  it("rejects a Proxy-wrapped identical return without invoking any trap on it", () => {
    let trapCalls = 0;
    const proxyDriver = {
      harnessId: FAKE_SERVICE_HARNESS_ID,
      driverVersion: "fake-service@1",
      validateNativeSessionRef: (candidate) => new Proxy(candidate, {
        get(target, prop, receiver) { trapCalls += 1; return Reflect.get(target, prop, receiver); },
      }),
    };
    const ref = serviceSessionRef({ harnessId: FAKE_SERVICE_HARNESS_ID, driverVersion: "fake-service@1" });
    assert.throws(
      () => validateNativeReferenceEnvelope(ref, { driver: proxyDriver, kind: "session" }),
      /exact bounded reference/,
    );
    assert.equal(trapCalls, 0);
  });

  it("still refuses a genuinely foreign locator shape from the Driver's own exact-schema validator", () => {
    const { driver } = createFakeServiceDriver();
    assert.throws(
      () => validateNativeReferenceEnvelope(serviceSessionRef(driver), { driver, kind: "turn" }),
      /turn locator must be exactly \{sessionId, turnId\}/,
    );
    assert.throws(
      () => validateNativeReferenceEnvelope(
        serviceSessionRef(driver, { locatorVersion: 2 }),
        { driver, kind: "session" },
      ),
      /fake service native session reference is not valid for this Driver/,
    );
  });
});

describe("hardening: canonical locator clone resists structural pollution (finding 4)", () => {
  it("rejects a __proto__-named locator field from a JSON.parse payload without polluting anything", () => {
    const evil = JSON.parse('{"sessionId":"s1","__proto__":{"polluted":true}}');
    // Sanity: JSON.parse's own handling of a literal "__proto__" key is
    // already safe -- it creates a genuine own property, not a prototype
    // rewrite. The exploit is entirely in how a *naive* clone re-assigns it.
    assert.equal(Object.getPrototypeOf(evil), Object.prototype);
    assert.throws(
      () => assertNativeReferenceLocatorShape(evil, "test"),
      /__proto__/,
    );
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it("rejects locator fields named prototype/constructor as structural pollution", () => {
    assert.throws(
      () => assertNativeReferenceLocatorShape({ sessionId: "s1", constructor: {} }, "test"),
      /constructor/,
    );
    assert.throws(
      () => assertNativeReferenceLocatorShape({ sessionId: "s1", prototype: {} }, "test"),
      /prototype/,
    );
  });

  it("produces canonical locator data with an ordinary prototype, exact own fields, and a faithful JSON roundtrip", () => {
    const locator = { sessionId: "s1", turnId: "t1" };
    const canonical = assertNativeReferenceLocatorShape(locator, "test");
    assert.equal(Object.getPrototypeOf(canonical), Object.prototype);
    assert.deepEqual(Object.keys(canonical).sort(), ["sessionId", "turnId"]);
    assert.deepEqual(JSON.parse(JSON.stringify(canonical)), canonical);
  });

  it("enforces the byte bound on nested content accumulation, not only a flat top level", () => {
    const locator = {};
    for (const key of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
      locator[key] = { chunk: "y".repeat(MAX_NATIVE_LOCATOR_SCALAR_CHARS) };
    }
    assert.throws(
      () => assertNativeReferenceLocatorShape(locator, "test"),
      new RegExp(`exceeds ${MAX_NATIVE_LOCATOR_BYTES} bytes`),
    );
  });
});

describe("hardening: nonblocking direct fixes (finding 7)", () => {
  it("classifies privateKey/passwd/pwd/jwt as forbidden secret-shaped keys", () => {
    for (const key of ["privateKey", "passwd", "pwd", "jwt"]) {
      assert.equal(forbiddenNativeLocatorKeyCategory(key), "secret", key);
    }
  });

  it("rejects a URL/URI-shaped scalar locator value structurally", () => {
    assert.throws(
      () => assertNativeReferenceLocatorShape({ sessionId: "https://evil.example/exfiltrate" }, "test"),
      /URL|URI|endpoint/i,
    );
    assert.throws(
      () => assertNativeReferenceLocatorShape({ sessionId: "ws://evil.example/socket" }, "test"),
      /URL|URI|endpoint/i,
    );
    // An ordinary bounded identifier that merely contains "://"-free text is unaffected.
    assert.equal(
      assertNativeReferenceLocatorShape({ sessionId: "session-abc123" }, "test").sessionId,
      "session-abc123",
    );
  });
});
