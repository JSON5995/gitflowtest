import { afterEach, describe, expect, it } from "vitest";
import { openStorage, type Storage, type WorkRecord } from "../src/storage.js";
import { processNextJob, sendNextNotification, type WorkerDependencies } from "../src/worker.js";

const storages: Storage[] = [];
const HEAD_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

afterEach(() => storages.splice(0).forEach((storage) => storage.close()));

const linkedWork = (overrides: Partial<WorkRecord> = {}): WorkRecord => ({
  repository: "acme/store",
  issueNumber: 17,
  chatId: "-100",
  topicId: null,
  pullRequestNumber: null,
  providerJobId: null,
  fixRounds: 0,
  state: "ready",
  headSha: null,
  repairHeadSha: null,
  passedChecks: [],
  ...overrides,
});

const github = (overrides: Partial<WorkerDependencies["github"]> = {}): WorkerDependencies["github"] => ({
  setFlowState: async () => undefined,
  dispatchBuild: async () => undefined,
  dispatchQuality: async () => undefined,
  verifyTrustedWorkflow: async () => true,
  publishCheck: async () => undefined,
  openPullRequest: async () => 22,
  markPullRequestReady: async () => undefined,
  closeIssue: async () => undefined,
  ...overrides,
});

const dependencies = (
  storage: Storage,
  overrides: Partial<WorkerDependencies> = {},
): WorkerDependencies => ({
  storage,
  processTelegram: async () => undefined,
  github: github(),
  botLogin: "flow-ai[bot]",
  maxFixRounds: 2,
  ...overrides,
});

const pullRequestPayload = (sha = HEAD_SHA, action = "opened") => ({
  action,
  repository: { full_name: "acme/store", default_branch: "main" },
  pull_request: {
    number: 22,
    body: "Closes #17",
    merged: false,
    user: { login: "flow-ai[bot]" },
    base: { ref: "main" },
    head: { sha, ref: "flow/17", repo: { full_name: "acme/store" } },
  },
});

const workflowPayload = (
  name: "Flow CI" | "AI Review" | "Flow QA",
  conclusion: string,
  sha = HEAD_SHA,
) => {
  const metadata = {
    "Flow CI": { path: ".github/workflows/flow-ci.yml", title: "Flow CI" },
    "AI Review": { path: ".github/workflows/flow-review.yml", title: "AI Review" },
    "Flow QA": { path: ".github/workflows/flow-qa.yml", title: "Flow QA" },
  }[name];
  return {
    action: "completed",
    repository: { full_name: "acme/store" },
    workflow_run: {
      id: 101,
      workflow_id: 201,
      name,
      path: metadata.path,
      event: "workflow_dispatch",
      actor: { login: "flow-ai[bot]" },
      triggering_actor: { login: "flow-ai[bot]" },
      head_branch: "main",
      head_sha: "c".repeat(40),
      run_attempt: 1,
      display_title: `${metadata.title} · PR #22 · SHA ${sha}`,
      conclusion,
      html_url: "https://github.com/acme/store/actions/runs/101",
    },
  };
};

describe("worker", () => {
  it("processes a Telegram job exactly once", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const received: unknown[] = [];
    storage.enqueueJob("telegram", "telegram:1", { updateId: "1" }, 0);

    expect(await processNextJob(dependencies(storage, {
      processTelegram: async (update) => { received.push(update); },
    }), 0)).toBe(true);

    expect(received).toEqual([{ updateId: "1" }]);
    expect(storage.claimJob(1, 1_000)).toBeNull();
  });

  it("accepts only the App-owned Flow branch and dispatches quality for its exact head", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork(), 0);
    const quality: Array<{ pr: number; sha: string }> = [];
    storage.enqueueJob("github", "github:trusted", {
      event: "pull_request", delivery: "trusted", payload: pullRequestPayload(),
    }, 0);

    await processNextJob(dependencies(storage, { github: github({
      dispatchQuality: async (_repository, pr, sha) => { quality.push({ pr, sha }); },
    }) }), 0);

    expect(storage.getWorkByPullRequest("acme/store", 22)).toMatchObject({ state: "working", headSha: HEAD_SHA });
    expect(quality).toEqual([{ pr: 22, sha: HEAD_SHA }]);

    storage.enqueueJob("github", "github:fork", {
      event: "pull_request",
      delivery: "fork",
      payload: {
        ...pullRequestPayload(NEXT_SHA, "synchronize"),
        pull_request: {
          ...pullRequestPayload(NEXT_SHA).pull_request,
          head: { sha: NEXT_SHA, ref: "flow/17", repo: { full_name: "attacker/store" } },
        },
      },
    }, 1);
    await processNextJob(dependencies(storage, { github: github({
      dispatchQuality: async (_repository, pr, sha) => { quality.push({ pr, sha }); },
    }) }), 1);
    expect(quality).toHaveLength(1);
  });

  it("accepts a synchronized head and dispatches a fresh quality run", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ pullRequestNumber: 22, state: "human", headSha: HEAD_SHA, passedChecks: ["ci", "ai-review", "qa"] }), 0);
    storage.enqueueJob("github", "github:sync", {
      event: "pull_request", delivery: "sync", payload: pullRequestPayload(NEXT_SHA, "synchronize"),
    }, 0);
    const quality: string[] = [];

    await processNextJob(dependencies(storage, { github: github({
      dispatchQuality: async (_repository, _pr, sha) => { quality.push(sha); },
    }) }), 0);

    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ state: "working", headSha: NEXT_SHA, passedChecks: [] });
    expect(quality).toEqual([NEXT_SHA]);
  });

  it("ignores generic check runs and stale or wrong-path workflow results", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ pullRequestNumber: 22, state: "working", headSha: HEAD_SHA }), 0);
    const invalidEvents = [
      { event: "check_run", delivery: "generic", payload: {} },
      { event: "workflow_run", delivery: "stale", payload: workflowPayload("Flow CI", "success", NEXT_SHA) },
      { event: "workflow_run", delivery: "wrong-path", payload: {
        ...workflowPayload("Flow CI", "success"),
        workflow_run: { ...workflowPayload("Flow CI", "success").workflow_run, path: ".github/workflows/untrusted.yml" },
      } },
      { event: "workflow_run", delivery: "wrong-actor", payload: {
        ...workflowPayload("Flow CI", "success"),
        workflow_run: { ...workflowPayload("Flow CI", "success").workflow_run, actor: { login: "collaborator" } },
      } },
    ];
    invalidEvents.forEach((event, index) => storage.enqueueJob("github", `github:invalid:${index}`, event, 0));
    const checks: string[] = [];
    const deps = dependencies(storage, { github: github({ publishCheck: async () => { checks.push("published"); } }) });

    for (let index = 0; index < invalidEvents.length; index += 1) await processNextJob(deps, 0);

    expect(checks).toEqual([]);
  });

  it("queues one bounded repair per failed head and preserves its evidence", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ pullRequestNumber: 22, state: "working", headSha: HEAD_SHA }), 0);
    storage.enqueueJob("github", "github:qa-fail", {
      event: "workflow_run", delivery: "qa-fail", payload: workflowPayload("Flow QA", "failure"),
    }, 0);
    storage.enqueueJob("github", "github:ci-fail", {
      event: "workflow_run", delivery: "ci-fail", payload: workflowPayload("Flow CI", "failure"),
    }, 1);
    const builds: Array<{ issue: number; context?: string }> = [];
    const deps = dependencies(storage, { github: github({
      dispatchBuild: async (_repository, issue, _ref, context) => {
        builds.push({ issue, ...(context === undefined ? {} : { context }) });
      },
    }) });

    await processNextJob(deps, 0);
    await processNextJob(deps, 1);
    await processNextJob(deps, Date.now() + 1_000);

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ issue: 17, context: expect.stringContaining("Flow QA failure") });
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ fixRounds: 1, repairHeadSha: HEAD_SHA });
  });

  it("publishes only trusted exact-head results and marks the draft ready", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ pullRequestNumber: 22, state: "working", headSha: HEAD_SHA, passedChecks: ["ci", "ai-review"] }), 0);
    storage.enqueueJob("github", "github:qa-pass", {
      event: "workflow_run", delivery: "qa-pass", payload: workflowPayload("Flow QA", "success"),
    }, 0);
    const ready: number[] = [];
    const checks: string[] = [];

    await processNextJob(dependencies(storage, { github: github({
      publishCheck: async (_repository, check) => { checks.push(`${check.name}:${check.headSha}`); },
      markPullRequestReady: async (_repository, pr) => { ready.push(pr); },
    }) }), 0);

    expect(checks).toEqual([`qa:${HEAD_SHA}`]);
    expect(ready).toEqual([22]);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("human");
  });

  it("opens a pull request only for the exact trusted builder workflow", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork(), 0);
    storage.enqueueJob("github", "github:build", {
      event: "workflow_run",
      delivery: "build",
      payload: {
        action: "completed",
        repository: { full_name: "acme/store" },
        workflow_run: {
          id: 90,
          workflow_id: 190,
          name: "Flow Build",
          path: ".github/workflows/flow-build.yml",
          event: "workflow_dispatch",
          actor: { login: "flow-ai[bot]" },
          triggering_actor: { login: "flow-ai[bot]" },
          head_branch: "main",
          head_sha: "c".repeat(40),
          run_attempt: 1,
          display_title: "Flow Build · Issue #17",
          conclusion: "success",
          html_url: "https://github.com/acme/store/actions/runs/90",
        },
      },
    }, 0);
    const opened: number[] = [];

    await processNextJob(dependencies(storage, { github: github({
      openPullRequest: async (_repository, issue) => { opened.push(issue); return 22; },
    }) }), 0);

    expect(opened).toEqual([17]);
  });

  it("delivers the outbox through Telegram", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const sent: string[] = [];
    storage.enqueueNotification("notice:1", "-100", "77", "Ready", 0);

    expect(await sendNextNotification(storage, {
      sendMessage: async (_chatId, _topicId, text) => { sent.push(text); },
    }, 0)).toBe(true);
    expect(sent).toEqual(["Ready"]);
  });
});
