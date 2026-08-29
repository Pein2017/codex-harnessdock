/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * A Driver Contract v2 fixture backed by a fake operator-owned service.
 *
 * A fake Claude cannot prove the core stopped depending on process facts,
 * because it still owns a child process. This Driver owns none: a turn is a
 * record inside an in-memory service that outlives the turn, so there is no
 * PID, no exit status, and no spawn/identity evidence anywhere in its results.
 * Tests drive the service through the returned `control` handle; the Driver
 * object itself exposes only the contract surface.
 */

import { ROUTE_CAPABILITY_NAMES, ROUTE_CAPABILITY_SCHEMA_VERSION } from "../../../runtime/harness-capabilities.mjs";
import {
  DRIVER_CONTRACT_VERSION_V2,
  boundedDriverReceipt,
} from "../../../runtime/harness-contract.mjs";

export const FAKE_SERVICE_HARNESS_ID = "fake-service";
export const FAKE_SERVICE_DRIVER_VERSION = "fake-service@1";

function defaultInstances() {
  return [
    { instanceKey: "tenant-alpha", readiness: "ready", detailCode: "ready" },
    { instanceKey: "tenant-beta", readiness: "unavailable", detailCode: "service_unreachable" },
  ];
}

function defaultCapabilities(overrides = {}) {
  return {
    capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    driverMaturity: "experimental",
    values: {
      interaction: "noninteractive_fixed_policy",
      activeInput: "acknowledged_active_stream",
      continuation: "exact_resume",
      history: "unavailable",
      interruptRequest: "supported",
      turnObservation: "terminal_observable",
      automaticRecovery: "none",
      authorityEnforcement: "harness_policy",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "disabled",
      ...(overrides.values ?? {}),
    },
    maturity: {
      interaction: "validated",
      activeInput: "experimental",
      continuation: "experimental",
      history: "validated",
      interruptRequest: "experimental",
      turnObservation: "experimental",
      automaticRecovery: "validated",
      authorityEnforcement: "validated",
      leafEnforcement: "validated",
      nativeOrchestration: "validated",
      ...(overrides.maturity ?? {}),
    },
    provenance: {
      ...Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((name) => [name, "checkout_declared"])),
      ...(overrides.provenance ?? {}),
    },
  };
}

/**
 * @param {{
 *   harnessId?: string,
 *   driverVersion?: string,
 *   instances?: Array<{instanceKey: string, readiness: string, detailCode: string}>,
 *   capabilities?: {values?: Record<string, string>, maturity?: Record<string, string>},
 *   autoComplete?: boolean,
 *   observable?: boolean,
 *   routeOverride?: (route: any) => any,
 *   resultOverride?: (result: any) => any,
 *   liveTurnOverride?: (live: any) => any,
 *   inspectInstances?: (scope: any) => any,
 *   observeTurnOverride?: (observation: any, context: {ref: any, scope: any, turn: any}) => any,
 * }} [options]
 */
export function createFakeServiceDriver(options = {}) {
  const harnessId = options.harnessId ?? FAKE_SERVICE_HARNESS_ID;
  const driverVersion = options.driverVersion ?? FAKE_SERVICE_DRIVER_VERSION;
  const capabilities = defaultCapabilities(options.capabilities ?? {});
  const observable = options.observable ?? true;
  const autoComplete = options.autoComplete ?? true;
  const instances = (options.instances ?? defaultInstances()).map((instance) => ({ ...instance }));

  /** The service state that survives every turn, exactly like a real server. */
  const service = {
    sequence: 0,
    /** @type {Map<string, any>} */
    turns: new Map(),
    inspections: 0,
    prompts: [],
    deliveredInputs: [],
    interruptRequests: [],
    disposals: 0,
  };

  function sessionRef(sessionId) {
    return Object.freeze({
      version: 1,
      harnessId,
      driverVersion,
      instanceKey: instances.find((instance) => instance.readiness === "ready")?.instanceKey ?? "tenant-alpha",
      locatorVersion: 1,
      locator: Object.freeze({ sessionId }),
    });
  }

  function turnRef(instanceKey, sessionId, turnId) {
    return Object.freeze({
      version: 1,
      harnessId,
      driverVersion,
      instanceKey,
      locatorVersion: 1,
      locator: Object.freeze({ sessionId, turnId }),
    });
  }

  function terminalResult(turn, status = "completed") {
    const failed = status !== "completed";
    const result = {
      harnessId,
      driverVersion,
      contractVersion: DRIVER_CONTRACT_VERSION_V2,
      instanceKey: turn.instanceKey,
      nativeTurnRef: turn.nativeTurnRef,
      status,
      nativeTurn: "terminal",
      executionWorld: Object.freeze({ continuity: "preserved", settlement: "settled" }),
      continuation: Object.freeze({
        mode: "exact_resume",
        nativeSessionRef: turn.nativeSessionRef,
        evidence: Object.freeze({ source: "service_turn_status" }),
      }),
      failure: Object.freeze({
        class: failed ? "cancelled_or_interrupted" : null,
        reason: failed ? "the service reported an interrupted turn" : null,
        detail: null,
        resumable: false,
        requiresAttention: false,
      }),
      finalMessage: failed ? null : `fake service completed turn ${turn.turnId}`,
      finalMessageAbsenceReason: failed ? "cancelled_or_interrupted" : null,
      progress: Object.freeze({ toolUses: [], touchedFiles: [], attempts: [], recoveryAttempts: 0 }),
      metrics: null,
      driverReceipt: boundedDriverReceipt(harnessId, driverVersion, { serviceTurn: turn.turnId }),
    };
    return options.resultOverride ? options.resultOverride(result) : result;
  }

  const driver = {
    harnessId,
    driverVersion,
    contractVersion: DRIVER_CONTRACT_VERSION_V2,

    describe() {
      return {
        harnessId,
        driverVersion,
        contractVersion: DRIVER_CONTRACT_VERSION_V2,
        title: "Fake service Harness",
        maturity: "experimental",
        capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
        environmentKeys: ["FAKE_SERVICE_HOME"],
      };
    },

    async inspectInstances(scope) {
      if (options.inspectInstances) return options.inspectInstances(scope);
      service.inspections += 1;
      // A real service Driver may read its fixed environment view; it may not
      // start, repair, log into, or otherwise mutate anything.
      void scope.env.FAKE_SERVICE_HOME;
      return instances.map((instance) => ({
        harnessId,
        instanceKey: instance.instanceKey,
        readiness: instance.readiness,
        liveValidated: instance.readiness === "ready",
        maturity: "experimental",
        detailCode: instance.detailCode,
        routes: instance.readiness === "ready"
          ? {
            models: [`${harnessId}-standard`],
            effortsByModel: { [`${harnessId}-standard`]: ["high"] },
            interaction: capabilities.values.interaction,
          }
          : null,
        capabilityProvenance: capabilities.provenance,
        inspectionGeneration: options.inspectionGeneration ?? "unavailable",
      }));
    },

    validateRoute(request, inspection) {
      const route = {
        harnessId,
        instanceKey: inspection.instanceKey,
        model: request.model,
        topology: request.topology,
        authority: request.authority,
        effort: request.effort,
        driverVersion,
        capabilities,
      };
      return options.routeOverride ? options.routeOverride(route) : route;
    },

    prepareTurn(input) {
      return {
        harnessId,
        driverVersion,
        route: input.route,
        promptEnvelope: {
          taskInput: input.taskInput,
          authority: `authority=${input.route.authority}`,
          topology: `topology=${input.route.topology}`,
          returnContract: "return one final message",
        },
        inputDigest: `digest:${input.taskInput.length}`,
      };
    },

    revalidatePreparedTurn(prepared, scope) {
      if (prepared.route.instanceKey !== scope.route.instanceKey) {
        throw new Error("prepared turn belongs to another logical instance");
      }
      return Object.freeze({ endpointHandle: "fake-service://in-memory", revalidatedAt: 1 });
    },

    validateNativeSessionRef(ref) {
      if (ref?.harnessId !== harnessId || ref?.locatorVersion !== 1) {
        throw new Error("fake service native session reference is not valid for this Driver");
      }
      const keys = Object.keys(ref.locator ?? {});
      if (keys.length !== 1 || keys[0] !== "sessionId" || typeof ref.locator.sessionId !== "string") {
        throw new Error("fake service session locator must be exactly {sessionId}");
      }
      return ref;
    },

    validateNativeTurnRef(ref) {
      if (ref?.harnessId !== harnessId || ref?.locatorVersion !== 1) {
        throw new Error("fake service native turn reference is not valid for this Driver");
      }
      const keys = Object.keys(ref.locator ?? {}).sort();
      if (
        keys.length !== 2 || keys[0] !== "sessionId" || keys[1] !== "turnId" ||
        typeof ref.locator.turnId !== "string"
      ) {
        throw new Error("fake service turn locator must be exactly {sessionId, turnId}");
      }
      return ref;
    },

    async startTurn(input) {
      const { scope, preparedTurn } = input;
      service.sequence += 1;
      const sessionId = scope.route.continuationSessionId ?? `service-session-${service.sequence}`;
      const turnId = `service-turn-${service.sequence}`;
      service.prompts.push(preparedTurn.promptEnvelope);
      const turn = {
        turnId,
        instanceKey: scope.route.instanceKey,
        nativeSessionRef: sessionRef(sessionId),
        nativeTurnRef: turnRef(scope.route.instanceKey, sessionId, turnId),
        state: "active",
        settle: null,
      };
      const settled = new Promise((resolve) => {
        turn.settle = (status) => {
          if (turn.state === "terminal") return;
          turn.state = "terminal";
          turn.lastStatus = status;
          resolve(terminalResult(turn, status));
        };
      });
      service.turns.set(turnId, turn);

      const live = {
        nativeTurnRef: turn.nativeTurnRef,
        nativeSessionRef: turn.nativeSessionRef,
        result: settled,
        dispose: async () => {
          service.disposals += 1;
        },
      };
      if (capabilities.values.activeInput === "acknowledged_active_stream") {
        live.deliverActiveInput = async (assigned) => {
          service.deliveredInputs.push(assigned);
          return { accepted: turn.state === "active", sequence: service.deliveredInputs.length };
        };
      }
      if (capabilities.values.interruptRequest === "supported") {
        // Request acceptance is not settlement: the service acknowledges the
        // command and the turn stays active until its own status says otherwise.
        live.requestInterrupt = async (command) => {
          service.interruptRequests.push(command);
          return {
            commandId: command.commandId,
            requestState: "accepted",
            settlement: "pending",
            nativeTurnState: turn.state === "terminal" ? "terminal" : "active",
          };
        };
      }
      if (autoComplete) queueMicrotask(() => turn.settle("completed"));
      return options.liveTurnOverride ? options.liveTurnOverride(live) : live;
    },
  };

  if (observable) {
    // Exactly the closed `TurnObservation` shape
    // `runtime/v3-turn-reconciliation.mjs` owns, and nothing else: a
    // `nativeTurn` drawn from the same three-value native-turn-state
    // vocabulary every durable owner in this runtime already uses, plus --
    // only when that state is terminal -- the complete raw terminal payload a
    // fresh process needs to settle from, in exactly the shape
    // `startTurn().result` itself resolves with. A real Driver may not smuggle
    // extra evidence through this seam, so neither may this fixture.
    // `options.observeTurnOverride` lets a caller shape a contradictory,
    // foreign, or otherwise malformed observation without teaching this shared
    // fixture every test's own adversarial evidence.
    driver.observeTurn = async (ref, scope) => {
      const turn = service.turns.get(ref?.locator?.turnId);
      let observation;
      if (!turn) {
        observation = { nativeTurn: "unknown", terminalResult: null };
      } else if (turn.state !== "terminal") {
        observation = { nativeTurn: "active", terminalResult: null };
      } else {
        observation = {
          nativeTurn: "terminal",
          terminalResult: terminalResult(turn, turn.lastStatus ?? "completed"),
        };
      }
      return options.observeTurnOverride ? options.observeTurnOverride(observation, { ref, scope, turn }) : observation;
    };
  }

  return {
    driver: Object.freeze(driver),
    capabilities,
    control: {
      service,
      instances,
      complete: (turnId, status = "completed") => service.turns.get(turnId).settle(status),
      turnIds: () => [...service.turns.keys()],
    },
  };
}
