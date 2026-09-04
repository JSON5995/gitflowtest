import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutedIntakeModel } from "../src/routed-intake.js";
import { createRoutingService } from "../src/routing-service.js";
import { openStorage, type Storage } from "../src/storage.js";
import { createHash } from "node:crypto";

const storages: Storage[] = [];
const cleanupPaths: string[] = [];
afterEach(() => {
  storages.splice(0).forEach((storage) => storage.close());
  cleanupPaths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("routed intake", () => {
  it("hands the same planning input to Claude when the selected OpenAI model is unavailable", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings({
      candidates: (["codex", "claude"] as const).map((provider) => ({
        id: `${provider}-frontier`,
        provider,
        model: `${provider}-planner`,
        tier: "frontier" as const,
        enabled: true,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      })),
      policy: {
        maxTransientRetriesPerCandidate: 0,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        jitterRatio: 0,
        reservationTtlMs: 60_000,
        limits: {
          perJobTokens: 100_000,
          perJobCostMicros: 1_000_000,
          monthlyTokens: 1_000_000,
          monthlyCostMicros: 10_000_000,
        },
      },
    });
    const router = createRoutingService({ storage });
    const executions: Array<{ provider: string; model: string; input: unknown }> = [];
    const expected = { title: "Plan created" };
    const model = createRoutedIntakeModel({
      routing: router,
      getCredential: () => "configured",
      execute: async (provider, selectedModel, input) => {
        executions.push({ provider, model: selectedModel, input });
        if (provider === "codex") throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
        return expected;
      },
      sleep: async () => undefined,
    });
    const input = {
      submissionId: "telegram:update-100",
      feedback: "Save is broken",
      repository: "acme/store",
      context: {},
    };

    await expect(model.createPlan(input)).resolves.toBe(expected);
    expect(executions).toEqual([
      { provider: "codex", model: "codex-planner", input },
      { provider: "claude", model: "claude-planner", input },
    ]);
    expect(executions[1]?.input).toBe(input);
  });

  it("reuses one durable budget identity across a restart but isolates a new submission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flow-routed-intake-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "flow.db");
    let storage = openStorage(databasePath);
    storages.push(storage);
    storage.setRoutingSettings({
      candidates: [{
        id: "codex-frontier",
        provider: "codex",
        model: "codex-planner",
        tier: "frontier",
        enabled: true,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      }],
      policy: {
        maxTransientRetriesPerCandidate: 0,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        jitterRatio: 0,
        reservationTtlMs: 60_000,
        limits: {
          perJobTokens: 10_000,
          perJobCostMicros: 1_000_000,
          monthlyTokens: 100_000,
          monthlyCostMicros: 10_000_000,
        },
      },
    });
    const createModel = (currentStorage: Storage) => createRoutedIntakeModel({
      routing: createRoutingService({ storage: currentStorage }),
      getCredential: () => "configured",
      execute: async () => ({ title: "Plan created" }),
    });
    const input = {
      submissionId: "telegram:update-101",
      feedback: "Save is broken",
      repository: "acme/store",
      context: {},
    };

    await expect(createModel(storage).createPlan(input)).resolves.toEqual({ title: "Plan created" });
    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    storage = openStorage(databasePath);
    storages.push(storage);

    await expect(createModel(storage).createPlan({ ...input }, ["units are required"])).rejects.toThrow(
      "budget would be exceeded",
    );
    await expect(createModel(storage).createPlan({
      ...input,
      submissionId: "telegram:update-102",
    })).resolves.toEqual({ title: "Plan created" });
  });

  it("blocks instead of repeating a synchronous intake request left active by a crashed process", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.setRoutingSettings({
      candidates: [{
        id: "codex-frontier",
        provider: "codex",
        model: "codex-planner",
        tier: "frontier",
        enabled: true,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      }],
      policy: {
        maxTransientRetriesPerCandidate: 2,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        jitterRatio: 0,
        reservationTtlMs: 60_000,
        limits: {
          perJobTokens: 100_000,
          perJobCostMicros: 1_000_000,
          monthlyTokens: 1_000_000,
          monthlyCostMicros: 10_000_000,
        },
      },
    });
    const input = {
      submissionId: "telegram:update-crashed",
      feedback: "Save is broken",
      repository: "acme/store",
      context: {},
    };
    const jobId = `intake:${createHash("sha256")
      .update(`${input.repository}\0${input.submissionId}`)
      .digest("hex")}`;
    const router = createRoutingService({ storage, routeId: () => "orphaned-intake-route" });
    await router.reserveRoute({
      jobId,
      role: "intake",
      complexity: "medium",
      instruction: "Plan the request.",
      evidenceRefs: ["flow://evidence"],
      checkpointRef: "github://acme/store",
      estimatedInputTokens: 2_000,
      maxOutputTokens: 5_000,
    });
    let executions = 0;
    const recovered = createRoutedIntakeModel({
      routing: router,
      getCredential: () => "configured",
      execute: async () => { executions += 1; return { title: "duplicate" }; },
    });

    await expect(recovered.createPlan(input)).rejects.toThrow(/previous intake attempt/i);
    expect(executions).toBe(0);
    expect(storage.getRoutingAttempt("orphaned-intake-route")).toMatchObject({
      status: "failed",
      failureCategory: "unknown",
    });
  });
});
