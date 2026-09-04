import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutingService } from "../src/routing-service.js";
import { openStorage, type RoutingSettings, type Storage } from "../src/storage.js";

const storages: Storage[] = [];
const cleanupPaths: string[] = [];
afterEach(() => {
  storages.splice(0).forEach((storage) => storage.close());
  cleanupPaths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const candidate = (
  id: string,
  provider: "codex" | "claude" | "cursor",
  tier: "economy" | "frontier",
) => ({
  id,
  provider,
  model: `${provider}-${tier}`,
  tier,
  enabled: true,
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 2_000_000,
});

const settings = (overrides: Partial<RoutingSettings["policy"]["limits"]> = {}): RoutingSettings => ({
  candidates: [
    candidate("codex-economy", "codex", "economy"),
    candidate("codex-frontier", "codex", "frontier"),
    candidate("claude-economy", "claude", "economy"),
    candidate("claude-frontier", "claude", "frontier"),
  ],
  policy: {
    maxTransientRetriesPerCandidate: 1,
    baseBackoffMs: 1_000,
    maxBackoffMs: 10_000,
    jitterRatio: 0,
    reservationTtlMs: 60_000,
    limits: {
      perJobTokens: 40_000,
      perJobCostMicros: 1_000_000,
      monthlyTokens: 100_000,
      monthlyCostMicros: 10_000_000,
      ...overrides,
    },
  },
});

const task = (jobId: string, role: "build" | "review" = "build") => ({
  jobId,
  role,
  complexity: "high" as const,
  instruction: "Implement the immutable GitHub issue.",
  evidenceRefs: ["github://acme/store/issues/17#sha256:abc"],
  checkpointRef: "github://acme/store/refs/heads/main@abc",
  estimatedInputTokens: 4_000,
  maxOutputTokens: 6_000,
});

describe("routing service", () => {
  it("reserves atomically and conservatively settles the full estimate when usage is unavailable", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings());
    const router = createRoutingService({
      storage,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      routeId: () => "route-1",
    });

    const decision = await router.reserveRoute(task("build:acme/store#17"));
    expect(decision).toMatchObject({ status: "ready", route: { routeId: "route-1", provider: "codex", model: "codex-frontier", attempt: 1 } });
    if (decision.status !== "ready") throw new Error("route not ready");
    await router.completeRoute(decision.route.routeId);

    expect(storage.getRoutingSummary(new Date("2026-09-04T12:01:00.000Z"))).toMatchObject({
      month: "2026-09",
      reservedTokens: 0,
      settledTokens: 10_000,
      settledCostMicros: 16_000,
    });
  });

  it("keeps a dispatched route reserved past its admission TTL until terminal completion", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings());
    let currentTime = new Date("2026-09-04T12:00:00.000Z");
    const router = createRoutingService({
      storage,
      now: () => currentTime,
      routeId: () => "long-running-route",
    });

    const decision = await router.reserveRoute(task("build:long-running"));
    if (decision.status !== "ready") throw new Error("route not ready");
    currentTime = new Date("2026-09-04T12:02:00.000Z");

    expect(storage.getRoutingSummary(currentTime)).toMatchObject({
      reservedTokens: 10_000,
      settledTokens: 0,
    });
    await router.completeRoute(decision.route.routeId);
    expect(storage.getRoutingSummary(currentTime)).toMatchObject({
      reservedTokens: 0,
      settledTokens: 10_000,
    });
  });

  it("does not mark a route complete when its usage reservation cannot be settled", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings());
    const router = createRoutingService({ storage, routeId: () => "released-route" });

    const decision = await router.reserveRoute(task("build:released"));
    if (decision.status !== "ready") throw new Error("route not ready");
    await storage.releaseUsage(decision.route.reservationId);

    await expect(router.completeRoute(decision.route.routeId)).rejects.toThrow(
      "Usage reservation is no longer active",
    );
    expect(storage.getRoutingAttempt(decision.route.routeId)?.status).toBe("reserved");
  });

  it("rolls back every terminal budget transition when the matching route update fails", async () => {
    type Router = ReturnType<typeof createRoutingService>;
    const cases: Array<{
      name: string;
      terminalStatus: "complete" | "failed";
      run(router: Router, routeId: string): Promise<unknown>;
    }> = [
      {
        name: "completion",
        terminalStatus: "complete",
        run: (router, routeId) => router.completeRoute(routeId),
      },
      {
        name: "failure",
        terminalStatus: "failed",
        run: (router, routeId) => router.failRoute(routeId, "task_failure"),
      },
      {
        name: "cancellation",
        terminalStatus: "failed",
        run: (router, routeId) => router.cancelBeforeStart(routeId),
      },
    ];

    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), `flow-routing-${testCase.name}-`));
      cleanupPaths.push(directory);
      const databasePath = join(directory, "flow.db");
      const initialStorage = openStorage(databasePath);
      initialStorage.setRoutingSettings(settings());
      const initialRouter = createRoutingService({
        storage: initialStorage,
        now: () => new Date("2026-09-04T12:00:00.000Z"),
        routeId: () => `atomic-${testCase.name}`,
      });
      const decision = await initialRouter.reserveRoute(task(`build:atomic-${testCase.name}`));
      if (decision.status !== "ready") throw new Error("route not ready");
      initialStorage.close();

      const database = new Database(databasePath);
      database.exec(`
        CREATE TRIGGER reject_terminal_route_update
        BEFORE UPDATE OF status ON routing_attempts
        WHEN NEW.status = '${testCase.terminalStatus}'
        BEGIN SELECT RAISE(ABORT, 'forced route update failure'); END;
      `);
      database.close();

      const storage = openStorage(databasePath);
      storages.push(storage);
      const router = createRoutingService({
        storage,
        now: () => new Date("2026-09-04T12:00:01.000Z"),
      });

      await expect(testCase.run(router, decision.route.routeId)).rejects.toThrow(
        "forced route update failure",
      );
      expect(storage.getUsageReservation(decision.route.reservationId)?.status).toBe("reserved");
      expect(storage.getRoutingAttempt(decision.route.routeId)?.status).toBe("reserved");
      expect(storage.getRoutingSummary(new Date("2026-09-04T12:00:01.000Z")).recentEvents)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ state: testCase.terminalStatus })]));
    }
  });

  it("blocks dispatch before exceeding job or monthly admission limits", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings({ monthlyTokens: 9_999 }));
    const router = createRoutingService({ storage, routeId: () => "never" });

    await expect(router.reserveRoute(task("build:budget"))).resolves.toMatchObject({
      status: "blocked",
      reason: "budget",
    });
    expect(storage.getRoutingSummary()).toMatchObject({ reservedTokens: 0, settledTokens: 0 });
  });

  it("retries an explicit timeout, then hands the identical task to another provider", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings());
    const ids = ["route-1", "route-2", "route-3"];
    const router = createRoutingService({
      storage,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      routeId: () => ids.shift() ?? "unexpected",
    });
    const original = task("build:handoff");

    const first = await router.reserveRoute(original);
    if (first.status !== "ready") throw new Error("first route missing");
    const retry = await router.failRoute(first.route.routeId, "timeout");
    if (retry.status !== "ready") throw new Error("retry route missing");
    const handoff = await router.failRoute(retry.route.routeId, "outage");

    expect(retry).toMatchObject({ status: "ready", action: "retry", delayMs: 1_000, route: { provider: "codex", attempt: 2 } });
    expect(handoff).toMatchObject({ status: "ready", action: "handoff", route: { provider: "claude", attempt: 1 } });
    if (handoff.status !== "ready") throw new Error("handoff route missing");
    expect(handoff.route.task).toEqual(original);
    expect(handoff.route.task).not.toBe(original);
  });

  it("blocks on an unknown failure and never changes provider", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings());
    const router = createRoutingService({ storage, routeId: () => "route-unknown" });
    const first = await router.reserveRoute(task("build:unknown"));
    if (first.status !== "ready") throw new Error("route missing");

    await expect(router.failRoute(first.route.routeId, "unknown")).resolves.toMatchObject({
      status: "blocked",
      reason: "configuration",
    });
    expect(storage.listRoutingAttempts("build:unknown")).toHaveLength(1);
  });

  it("prefers a reviewer from a provider other than the builder", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings(settings());
    const router = createRoutingService({ storage, routeId: () => "review-route" });

    await expect(router.reserveRoute(task("review:17", "review"), "claude")).resolves.toMatchObject({
      status: "ready",
      route: { provider: "codex" },
    });
  });
});
