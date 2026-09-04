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
  repairHeadSha: null,
  passedChecks: [],
  ...overrides,
});

describe("orchestration transitions", () => {
  it("moves the linked issue to working when a pull request opens", () => {
    const result = transition(
      working({ state: "ready", headSha: null }),
      { type: "pr_opened", pullRequestNumber: 22, headSha: "abc" },
      2,
    );

    expect(result.work).toMatchObject({ state: "working", headSha: "abc", passedChecks: [] });
    expect(result.commands).toEqual([
      { type: "set_state", state: "working" },
      { type: "notify", message: "Pull request #22 opened." },
    ]);
  });

  it("moves to human review only after every required check passes", () => {
    const afterCi = transition(working(), { type: "check_passed", name: "ci", headSha: "abc" }, 2);
    const afterReview = transition(afterCi.work, { type: "check_passed", name: "ai-review", headSha: "abc" }, 2);
    const afterQa = transition(afterReview.work, { type: "check_passed", name: "qa", headSha: "abc" }, 2);

    expect(afterCi.work.state).toBe("working");
    expect(afterReview.work.state).toBe("working");
    expect(afterQa.work.state).toBe("human");
    expect(afterQa.commands.map((command) => command.type)).toEqual(["set_state", "mark_ready", "notify"]);
  });

  it("counts at most one repair round per pull-request head", () => {
    const first = transition(working(), { type: "check_failed", name: "qa", headSha: "abc", summary: "failed" }, 2);
    const duplicate = transition(first.work, { type: "check_failed", name: "ci", headSha: "abc", summary: "failed too" }, 2);
    const nextHead = transition(first.work, { type: "pr_opened", pullRequestNumber: 22, headSha: "def" }, 2);
    const second = transition(nextHead.work, { type: "check_failed", name: "qa", headSha: "def", summary: "failed" }, 2);
    const finalHead = transition(second.work, { type: "pr_opened", pullRequestNumber: 22, headSha: "fed" }, 2);
    const third = transition(finalHead.work, { type: "check_failed", name: "qa", headSha: "fed", summary: "failed" }, 2);

    expect(first.commands[0]?.type).toBe("request_fix");
    expect(duplicate.commands).toEqual([]);
    expect(second.commands[0]?.type).toBe("request_fix");
    expect(third.work.state).toBe("blocked");
    expect(third.commands.map((command) => command.type)).toEqual(["set_state", "notify"]);
  });

  it("accepts a synchronized pull request head and resets its checks", () => {
    const result = transition(
      working({ state: "human", passedChecks: ["ci", "ai-review", "qa"], repairHeadSha: "abc" }),
      { type: "pr_opened", pullRequestNumber: 22, headSha: "def" },
      2,
    );

    expect(result.work).toMatchObject({ state: "working", headSha: "def", repairHeadSha: null, passedChecks: [] });
  });

  it("does not regress terminal work on delayed events", () => {
    const done = working({ state: "done" });
    expect(transition(done, { type: "check_failed", name: "qa", headSha: "abc", summary: "late" }, 2)).toEqual({ work: done, commands: [] });
    expect(transition(done, { type: "pr_opened", pullRequestNumber: 22, headSha: "def" }, 2)).toEqual({ work: done, commands: [] });
  });

  it("marks a draft pull request ready after every gate passes", () => {
    const result = transition(
      working({ passedChecks: ["ci", "ai-review"] }),
      { type: "check_passed", name: "qa", headSha: "abc" },
      2,
    );

    expect(result.commands.map((command) => command.type)).toEqual(["set_state", "mark_ready", "notify"]);
  });

  it("ignores stale check results from an older PR head", () => {
    const result = transition(working(), { type: "check_failed", name: "ci", headSha: "old", summary: "failed" }, 2);

    expect(result.work).toEqual(working());
    expect(result.commands).toEqual([]);
  });
});

describe("Telegram orchestration", () => {
  it("refuses to connect Telegram until Admin has activated the repository gate", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.saveManagedRepository({
      repository: "acme/store",
      installationId: 99,
      codeowners: ["@acme/platform"],
      setupPullRequestUrl: "https://github.com/acme/store/pull/7",
      mergeGateInstalled: false,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    let checkedAccess = false;

    await processTelegramUpdate({
      updateId: "pending-connect",
      chatId: "-100",
      topicId: null,
      userId: "123",
      messageId: 1,
      action: { type: "connect", repository: "acme/store" },
    }, {
      storage,
      adminIds: ["123"],
      telegram: {
        downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
        sendMessage: async () => undefined,
        setWebhook: async () => undefined,
      },
      transcribe: async () => "",
      analyzeVideo: async () => ({ transcript: "", images: [] }),
      model: { createPlan: async () => { throw new Error("not used"); } },
      github: {
        hasRepositoryAccess: async () => { checkedAccess = true; return { installationId: 99 }; },
        createPlannedIssue: async () => ({ parentNumber: 17, childNumbers: [] }),
        postClarificationAnswer: async () => undefined,
        setFlowState: async () => undefined,
      },
    });

    expect(checkedAccess).toBe(false);
    expect(storage.getChatBinding("-100", null)).toBeNull();
    expect(storage.claimNotification(Date.now() + 1_000)?.text).toContain("not active in Flow Admin");
  });

  it("binds, collects, plans, creates, and links one request", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.saveManagedRepository({
      repository: "acme/store",
      installationId: 99,
      codeowners: ["@acme/platform"],
      setupPullRequestUrl: "https://github.com/acme/store/pull/7",
      mergeGateInstalled: true,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
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
      analyzeVideo: async () => ({ transcript: "", images: [] }),
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
        postClarificationAnswer: async () => undefined,
        setFlowState: async () => undefined,
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

  it("dispatches Cursor through the same trusted GitHub build workflow", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.bindChat("-100", null, 99, "acme/store");
    const draftId = storage.startDraft("-100", null, "123");
    storage.appendDraftItem(draftId, 2, { kind: "text", text: "Fix checkout" });

    await processTelegramUpdate({
      updateId: "3",
      chatId: "-100",
      topicId: null,
      userId: "123",
      messageId: 3,
      action: { type: "submit" },
    }, {
      storage,
      adminIds: ["123"],
      builder: "cursor",
      telegram: {
        downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
        sendMessage: async () => undefined,
        setWebhook: async () => undefined,
      },
      transcribe: async () => "",
      analyzeVideo: async () => ({ transcript: "", images: [] }),
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
        postClarificationAnswer: async () => undefined,
        setFlowState: async () => undefined,
        createPlannedIssue: async () => ({ parentNumber: 17, childNumbers: [] }),
      },
    });

    expect(storage.claimJob(Date.now() + 1_000, 1_000)).toMatchObject({
      kind: "build",
      idempotencyKey: "build:acme/store#17",
      payload: { repository: "acme/store", issueNumber: 17 },
    });
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ state: "ready" });
  });

  it("reuses the stored submission plan when a completed GitHub request is retried", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.bindChat("-100", null, 99, "acme/store");
    const draftId = storage.startDraft("-100", null, "123");
    storage.appendDraftItem(draftId, 2, { kind: "text", text: "Fix checkout" });
    let plans = 0;
    let creates = 0;
    const update = {
      updateId: "retry-3",
      chatId: "-100",
      topicId: null,
      userId: "123",
      messageId: 3,
      action: { type: "submit" as const },
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
      analyzeVideo: async () => ({ transcript: "", images: [] }),
      model: { createPlan: async () => {
        plans += 1;
        return {
          title: "Repair checkout",
          problem: "Checkout does not submit an order.",
          evidence: [],
          acceptanceCriteria: ["Checkout submits one order."],
          nonGoals: [],
          risks: [],
          needsHumanInput: false,
          units: [{ title: "Repair checkout", body: "Fix checkout.", canRunInParallel: true }],
        };
      } },
      github: {
        hasRepositoryAccess: async () => ({ installationId: 99 }),
        postClarificationAnswer: async () => undefined,
        setFlowState: async () => undefined,
        createPlannedIssue: async () => {
          creates += 1;
          if (creates === 1) throw new Error("response lost after GitHub accepted it");
          return { parentNumber: 17, childNumbers: [] };
        },
      },
    };

    await expect(processTelegramUpdate(update, dependencies)).rejects.toThrow("response lost");
    await processTelegramUpdate(update, dependencies);

    expect(plans).toBe(1);
    expect(creates).toBe(2);
    expect(storage.getDraftBySubmission("retry-3")).toMatchObject({ id: draftId });
    expect(storage.claimJob(Date.now() + 1_000, 1_000)?.idempotencyKey).toBe("build:acme/store#17");
  });

  it("posts a Telegram answer to GitHub and resumes the blocked issue idempotently", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.bindChat("-100", "77", 99, "acme/store");
    storage.linkWork({
      repository: "acme/store",
      issueNumber: 17,
      chatId: "-100",
      topicId: "77",
      pullRequestNumber: null,
      providerJobId: null,
      fixRounds: 0,
      state: "blocked",
      headSha: null,
      repairHeadSha: null,
      passedChecks: [],
      blockReason: "clarification",
      clarificationId: "intake:answer-100",
    });
    const answers: string[] = [];
    const states: string[] = [];
    const dependencies = {
      storage,
      adminIds: ["123"],
      telegram: {
        downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
        sendMessage: async () => undefined,
        setWebhook: async () => undefined,
      },
      transcribe: async () => "",
      analyzeVideo: async () => ({ transcript: "", images: [] }),
      model: { createPlan: async () => { throw new Error("not used"); } },
      github: {
        hasRepositoryAccess: async () => ({ installationId: 99 }),
        createPlannedIssue: async () => ({ parentNumber: 17, childNumbers: [] }),
        postClarificationAnswer: async (_repository: string, _issue: number, text: string) => { answers.push(text); },
        setFlowState: async (_repository: string, _issue: number, state: string) => { states.push(state); },
      },
    };
    const update = {
      updateId: "answer-100",
      chatId: "-100",
      topicId: "77",
      userId: "123",
      messageId: 100,
      action: { type: "answer" as const, issueNumber: 17, text: "Only owners should see it." },
    };

    await processTelegramUpdate(update, dependencies);
    await processTelegramUpdate(update, dependencies);

    expect(answers).toEqual(["Only owners should see it."]);
    expect(states).toEqual(["ready"]);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("ready");
    expect(storage.claimJob(Date.now() + 1_000, 1_000)).toMatchObject({
      idempotencyKey: "clarification:acme/store#17:telegram:answer-100",
      payload: expect.objectContaining({
        repository: "acme/store",
        issueNumber: 17,
        clarificationContext: expect.stringContaining("Only owners should see it."),
      }),
    });
    expect(storage.claimJob(Date.now() + 1_000, 1_000)).toBeNull();
  });
});
