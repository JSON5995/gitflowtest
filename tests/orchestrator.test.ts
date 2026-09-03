import { afterEach, describe, expect, it } from "vitest";
import type { WorkPlan } from "../src/domain.js";
import {
  processTelegramUpdate,
  transition,
  type WorkSnapshot,
} from "../src/orchestrator.js";
import { openStorage, type Storage } from "../src/storage.js";

const storages: Storage[] = [];

afterEach(() => storages.splice(0).forEach((storage) => storage.close()));

const working = (overrides: Partial<WorkSnapshot> = {}): WorkSnapshot => ({
  state: "working",
  fixRounds: 0,
  headSha: "abc",
  passedChecks: [],
  ...overrides,
});

describe("orchestration transitions", () => {
  it("moves to human review only after every required check passes", () => {
    const afterCi = transition(working(), { type: "check_passed", name: "ci", headSha: "abc" }, 2);
    const afterReview = transition(afterCi.work, { type: "check_passed", name: "ai-review", headSha: "abc" }, 2);
    const afterQa = transition(afterReview.work, { type: "check_passed", name: "qa", headSha: "abc" }, 2);

    expect(afterCi.work.state).toBe("working");
    expect(afterReview.work.state).toBe("working");
    expect(afterQa.work.state).toBe("human");
    expect(afterQa.commands.map((command) => command.type)).toEqual(["set_state", "notify"]);
  });

  it("requests two fix rounds then blocks the third failure", () => {
    const first = transition(working(), { type: "check_failed", name: "qa", headSha: "abc", summary: "failed" }, 2);
    const second = transition(first.work, { type: "check_failed", name: "qa", headSha: "abc", summary: "failed" }, 2);
    const third = transition(second.work, { type: "check_failed", name: "qa", headSha: "abc", summary: "failed" }, 2);

    expect(first.commands[0]?.type).toBe("request_fix");
    expect(second.commands[0]?.type).toBe("request_fix");
    expect(third.work.state).toBe("blocked");
    expect(third.commands.map((command) => command.type)).toEqual(["set_state", "notify"]);
  });

  it("ignores stale check results from an older PR head", () => {
    const result = transition(working(), { type: "check_failed", name: "ci", headSha: "old", summary: "failed" }, 2);

    expect(result.work).toEqual(working());
    expect(result.commands).toEqual([]);
  });
});

describe("Telegram orchestration", () => {
  it("binds, collects, plans, creates, and links one request", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const created: Array<{ repository: string; plan: WorkPlan }> = [];
    const baseUpdate = {
      updateId: "1",
      chatId: "-100",
      topicId: "77",
      userId: "123",
      messageId: 1,
    };
    const dependencies = {
      storage,
      adminIds: ["123"],
      telegram: {
        downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
        sendMessage: async () => undefined,
        setWebhook: async () => undefined,
      },
      transcribe: async () => "",
      model: { createPlan: async () => ({
        title: "Repair checkout",
        problem: "Checkout does not submit an order.",
        evidence: [],
        acceptanceCriteria: ["Checkout submits one order."],
        nonGoals: [],
        risks: [],
        needsHumanInput: false,
        units: [{ title: "Repair checkout", body: "Fix checkout.", canRunInParallel: true }],
      }) },
      github: {
        hasRepositoryAccess: async () => ({ installationId: 99 }),
        createPlannedIssue: async (repository: string, plan: WorkPlan) => {
          created.push({ repository, plan });
          return { parentNumber: 17, childNumbers: [] };
        },
      },
    };

    await processTelegramUpdate({
      ...baseUpdate,
      action: { type: "connect", repository: "acme/store" },
    }, dependencies);
    await processTelegramUpdate({
      ...baseUpdate,
      updateId: "2",
      messageId: 2,
      action: { type: "append", item: { kind: "text", text: "Checkout is broken" } },
    }, dependencies);
    await processTelegramUpdate({
      ...baseUpdate,
      updateId: "3",
      messageId: 3,
      action: { type: "submit" },
    }, dependencies);

    expect(created).toHaveLength(1);
    expect(created[0]?.repository).toBe("acme/store");
    expect(storage.getChatBinding("-100", "77")?.installationId).toBe(99);
    expect(storage.getOpenDraft("-100", "77", "123")).toBeNull();
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ state: "ready", chatId: "-100" });
  });
});
