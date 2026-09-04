import { afterEach, describe, expect, it } from "vitest";
import { openStorage, type Storage, type WorkRecord } from "../src/storage.js";
import { processNextJob, sendNextNotification, type WorkerDependencies } from "../src/worker.js";
import { formatClarificationComment } from "../src/clarification.js";
import { createRoutingService } from "../src/routing-service.js";
import type { RoutingSettings } from "../src/storage.js";

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
  blockReason: null,
  clarificationId: null,
  ...overrides,
});

const github = (overrides: Partial<WorkerDependencies["github"]> = {}): WorkerDependencies["github"] => ({
  setFlowState: async () => undefined,
  dispatchBuild: async () => undefined,
  dispatchCi: async () => undefined,
  dispatchAgentQuality: async () => undefined,
  verifyTrustedWorkflow: async () => true,
  verifyClarificationPublisher: async (_repository, _issueNumber, _clarification, publisher) =>
    publisher.login === "flow-ai[bot]",
  publishCheck: async () => undefined,
  openPullRequest: async () => 22,
  markPullRequestReady: async () => undefined,
  closeIssue: async () => undefined,
  canAnswerClarification: async () => false,
  getFlowState: async () => "ready",
  ...overrides,
});

let routeSequence = 0;
const routing: WorkerDependencies["routing"] = {
  reserveRoute: async (task, preferIndependentFrom) => {
    const provider = preferIndependentFrom === "codex" ? "claude" : "codex";
    const routeId = `test-route-${routeSequence += 1}`;
    return {
      status: "ready",
      action: "dispatch",
      delayMs: 0,
      route: {
        routeId,
        provider,
        model: `${provider}-test-model`,
        candidateId: `${provider}-test`,
        attempt: 1,
        reservationId: `reservation-${routeId}`,
        task,
      },
    };
  },
  completeRoute: async () => undefined,
  failRoute: async () => ({ status: "blocked", reason: "configuration", message: "Provider failure needs attention" }),
  cancelBeforeStart: async () => undefined,
};

const dependencies = (
  storage: Storage,
  overrides: Partial<WorkerDependencies> = {},
): WorkerDependencies => ({
  storage,
  processTelegram: async () => undefined,
  github: github(),
  routing,
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

  it("retries an explicitly timed-out build and then hands the same job to the fallback provider", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork(), 0);
    const routingSettings: RoutingSettings = {
      candidates: (["codex", "claude"] as const).map((provider) => ({
        id: `${provider}-frontier`,
        provider,
        model: `${provider}-frontier-model`,
        tier: "frontier" as const,
        enabled: true,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      })),
      policy: {
        maxTransientRetriesPerCandidate: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        jitterRatio: 0,
        reservationTtlMs: 60_000,
        limits: {
          perJobTokens: 500_000,
          perJobCostMicros: 10_000_000,
          monthlyTokens: 1_000_000,
          monthlyCostMicros: 20_000_000,
        },
      },
    };
    storage.setRoutingSettings(routingSettings);
    const ids = ["route-1", "route-2", "route-3"];
    const router = createRoutingService({
      storage,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      routeId: () => ids.shift() ?? "unexpected",
    });
    const dispatched: Array<{ provider: string; model: string; routeId: string }> = [];
    const deps = dependencies(storage, {
      routing: router,
      github: github({
        dispatchBuild: async (_repository, _issue, route) => { dispatched.push(route); },
      }),
    });
    storage.enqueueJob("build", "build:acme/store#17", { repository: "acme/store", issueNumber: 17 }, 0);

    await processNextJob(deps, 0);
    await processNextJob(deps, 0);
    const failedRun = (routeId: string, delivery: string) => storage.enqueueJob("github", delivery, {
      event: "workflow_run",
      delivery,
      payload: {
        action: "completed",
        repository: { full_name: "acme/store" },
        workflow_run: {
          id: delivery === "timeout-1" ? 501 : 502,
          workflow_id: 190,
          name: "Flow Build",
          path: ".github/workflows/flow-build.yml",
          event: "workflow_dispatch",
          actor: { login: "flow-ai[bot]" },
          triggering_actor: { login: "flow-ai[bot]" },
          head_branch: "main",
          head_sha: "c".repeat(40),
          run_attempt: 1,
          display_title: `Flow Build · Issue #17 · Route ${routeId}`,
          conclusion: "timed_out",
          html_url: `https://github.com/acme/store/actions/runs/${delivery}`,
        },
      },
    }, 0);
    failedRun("route-1", "timeout-1");
    await processNextJob(deps, 0);
    await processNextJob(deps, 0);
    failedRun("route-2", "timeout-2");
    await processNextJob(deps, 0);
    await processNextJob(deps, 0);

    expect(dispatched).toEqual([
      { provider: "codex", model: "codex-frontier-model", routeId: "route-1" },
      { provider: "codex", model: "codex-frontier-model", routeId: "route-2" },
      { provider: "claude", model: "claude-frontier-model", routeId: "route-3" },
    ]);
    expect(storage.getWorkByIssue("acme/store", 17)?.providerJobId).toBe("route-3");
  });

  it("blocks and notifies when the trusted builder publishes a clarification", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "working" }), 0);
    storage.enqueueJob("github", "github:question", {
      event: "issue_comment",
      delivery: "question",
      payload: {
        action: "created",
        repository: { full_name: "acme/store" },
        issue: { number: 17, html_url: "https://github.com/acme/store/issues/17" },
        comment: {
          id: 501,
          body: formatClarificationComment({
            version: 1,
            id: "builder:123:17",
            source: "builder",
            question: "Which account role should see the control?",
          }),
          user: { login: "flow-ai[bot]", type: "Bot" },
        },
      },
    }, 0);

    await processNextJob(dependencies(storage), 0);

    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("blocked");
    expect(storage.claimNotification(Date.now() + 1_000, 1_000)?.text).toContain("Which account role");
  });

  it("ignores untrusted clarification answers and resumes once for a trusted writer", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "blocked", blockReason: "clarification", clarificationId: "question-1" }), 0);
    const answerPayload = (login: string, id: number, type = "User") => ({
      action: "created",
      repository: { full_name: "acme/store" },
      issue: { number: 17, html_url: "https://github.com/acme/store/issues/17" },
      comment: { id, body: "Only workspace owners should see it.", user: { login, type } },
    });
    storage.enqueueJob("github", "github:untrusted", {
      event: "issue_comment", delivery: "untrusted", payload: answerPayload("reader", 601),
    }, 0);
    storage.enqueueJob("github", "github:trusted-answer", {
      event: "issue_comment", delivery: "trusted-answer", payload: answerPayload("maintainer", 602),
    }, 1);
    const builds: string[] = [];
    const deps = dependencies(storage, { github: github({
      canAnswerClarification: async (_repository, login) => login === "maintainer",
      dispatchBuild: async (_repository, _issue, _route, _ref, context) => { builds.push(context ?? ""); },
    }) });

    await processNextJob(deps, 0);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("blocked");
    await processNextJob(deps, 1);
    await processNextJob(deps, Date.now() + 1_000);
    await processNextJob(deps, Date.now() + 1_001);

    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain("Only workspace owners should see it.");
    expect(builds[0]).toContain("untrusted clarification context");
  });

  it("ignores bot-authored answers that are not Flow clarification artifacts", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "blocked", blockReason: "clarification", clarificationId: "question-1" }), 0);
    storage.enqueueJob("github", "github:bot-answer", {
      event: "issue_comment",
      delivery: "bot-answer",
      payload: {
        action: "created",
        repository: { full_name: "acme/store" },
        issue: { number: 17, html_url: "https://github.com/acme/store/issues/17" },
        comment: { id: 603, body: "Try this answer", user: { login: "helper[bot]", type: "Bot" } },
      },
    }, 0);
    let checked = false;

    await processNextJob(dependencies(storage, { github: github({
      canAnswerClarification: async () => { checked = true; return true; },
    }) }), 0);

    expect(checked).toBe(false);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("blocked");
  });

  it("does not treat ordinary answers as route retries and requires the explicit retry command", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "blocked", blockReason: "route" }), 0);
    const comment = (id: number, body: string) => ({
      event: "issue_comment",
      delivery: String(id),
      payload: {
        action: "created",
        repository: { full_name: "acme/store" },
        issue: { number: 17, html_url: "https://github.com/acme/store/issues/17" },
        comment: { id, body, user: { login: "maintainer", type: "User" } },
      },
    });
    storage.enqueueJob("github", "github:route-answer", comment(700, "Try Claude instead."), 0);
    storage.enqueueJob("github", "github:route-retry", comment(701, "/flow retry"), 1);
    const deps = dependencies(storage, { github: github({ canAnswerClarification: async () => true }) });

    await processNextJob(deps, 0);
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ state: "blocked", blockReason: "route" });
    await processNextJob(deps, 1);

    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ state: "ready", blockReason: null });
    expect(storage.claimJob(Date.now() + 1_000)?.idempotencyKey).toContain("route-retry:");
  });

  it("never retries a workflow dispatch whose acceptance is ambiguous", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "working" }), 0);
    storage.enqueueJob("dispatch_build", "dispatch:route-ambiguous", {
      repository: "acme/store",
      issueNumber: 17,
      route: { provider: "codex", model: "gpt-test", routeId: "route-ambiguous" },
      context: "Implement the issue.",
    }, 0);
    let dispatches = 0;
    const deps = dependencies(storage, { github: github({
      dispatchBuild: async () => {
        dispatches += 1;
        throw new Error("response lost after GitHub may have accepted the dispatch");
      },
    }) });

    await processNextJob(deps, 0);
    await processNextJob(deps, 1_000_000);

    expect(dispatches).toBe(1);
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({ state: "blocked", blockReason: "route" });
  });

  it("blocks a workflow dispatch reclaimed after a crashed worker without sending it again", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "working" }), 0);
    storage.enqueueJob("dispatch_build", "dispatch:route-crashed", {
      repository: "acme/store",
      issueNumber: 17,
      route: { provider: "codex", model: "gpt-test", routeId: "route-crashed" },
      context: "Implement the issue.",
    }, 0);
    expect(storage.claimJob(0, 1_000)?.idempotencyKey).toBe("dispatch:route-crashed");
    let dispatches = 0;

    await processNextJob(dependencies(storage, { github: github({
      dispatchBuild: async () => { dispatches += 1; },
    }) }), 1_001);

    expect(dispatches).toBe(0);
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
      state: "blocked",
      blockReason: "route",
    });
    expect(storage.claimJob(2_000_000)).toBeNull();
  });

  it.each(["reserved", "work-saved", "dispatch-enqueued"] as const)(
    "recovers a build preparation crash after %s without reserving or dispatching twice",
    async (stage) => {
      const storage = openStorage(":memory:");
      storages.push(storage);
      storage.linkWork(linkedWork(), 0);
      storage.setRoutingSettings({
        candidates: [{
          id: "codex-frontier",
          provider: "codex",
          model: "codex-builder",
          tier: "frontier",
          enabled: true,
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 2_000_000,
        }],
        policy: {
          maxTransientRetriesPerCandidate: 1,
          baseBackoffMs: 0,
          maxBackoffMs: 0,
          jitterRatio: 0,
          reservationTtlMs: 60_000,
          limits: {
            perJobTokens: 500_000,
            perJobCostMicros: 10_000_000,
            monthlyTokens: 1_000_000,
            monthlyCostMicros: 20_000_000,
          },
        },
      });
      storage.enqueueJob("build", "build:acme/store#17", {
        repository: "acme/store",
        issueNumber: 17,
      }, 0);
      expect(storage.claimJob(0, 1_000)?.kind).toBe("build");
      const router = createRoutingService({
        storage,
        now: () => new Date("2026-09-04T12:00:00.000Z"),
        routeId: () => "recovered-build-route",
      });
      const decision = await router.reserveRoute({
        jobId: "build:acme/store#17",
        role: "build",
        complexity: "high",
        instruction: "Implement the issue.",
        evidenceRefs: ["github://acme/store/issues/17"],
        checkpointRef: "github://acme/store/issues/17",
        estimatedInputTokens: 20_000,
        maxOutputTokens: 80_000,
      });
      if (decision.status !== "ready") throw new Error("Expected a prepared route");
      if (stage !== "reserved") {
        storage.saveWork(linkedWork({
          state: "working",
          providerJobId: decision.route.routeId,
        }), 1);
      }
      if (stage === "dispatch-enqueued") {
        storage.enqueueJob("dispatch_build", `dispatch:${decision.route.routeId}`, {
          repository: "acme/store",
          issueNumber: 17,
          route: {
            provider: decision.route.provider,
            model: decision.route.model,
            routeId: decision.route.routeId,
          },
          context: decision.route.task.instruction,
        }, 1);
      }
      const dispatched: string[] = [];
      const deps = dependencies(storage, {
        routing: router,
        github: github({
          dispatchBuild: async (_repository, _issue, route) => { dispatched.push(route.routeId); },
        }),
      });

      await processNextJob(deps, 1_001);
      await processNextJob(deps, 1_001);

      expect(dispatched).toEqual(["recovered-build-route"]);
      expect(storage.listRoutingAttempts("build:acme/store#17")).toHaveLength(1);
      expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
        state: "working",
        providerJobId: "recovered-build-route",
      });
    },
  );

  it("does not erase a clarification when a crashed build parent is reclaimed", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork(), 0);
    storage.setRoutingSettings({
      candidates: [{
        id: "codex-frontier",
        provider: "codex",
        model: "codex-builder",
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
          perJobTokens: 500_000,
          perJobCostMicros: 10_000_000,
          monthlyTokens: 1_000_000,
          monthlyCostMicros: 20_000_000,
        },
      },
    });
    storage.enqueueJob("build", "build:acme/store#17", {
      repository: "acme/store",
      issueNumber: 17,
    }, 0);
    expect(storage.claimJob(0, 1_000)?.kind).toBe("build");
    const router = createRoutingService({ storage, routeId: () => "clarifying-active-route" });
    await router.reserveRoute({
      jobId: "build:acme/store#17",
      role: "build",
      complexity: "high",
      instruction: "Implement the issue.",
      evidenceRefs: ["github://acme/store/issues/17"],
      checkpointRef: "github://acme/store/issues/17",
      estimatedInputTokens: 20_000,
      maxOutputTokens: 80_000,
    });
    storage.saveWork(linkedWork({
      state: "blocked",
      blockReason: "clarification",
      clarificationId: "builder:901:17",
      providerJobId: "clarifying-active-route",
    }), 500);

    await processNextJob(dependencies(storage, { routing: router }), 1_001);

    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
      state: "blocked",
      blockReason: "clarification",
      clarificationId: "builder:901:17",
      providerJobId: "clarifying-active-route",
    });
  });

  it("isolates a failed review dispatch while CI and QA continue exactly once", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork(), 0);
    storage.setRoutingSettings({
      candidates: ([
        ["claude", "claude-quality"],
        ["codex", "codex-quality"],
      ] as const).map(([provider, model]) => ({
        id: `${provider}-frontier`,
        provider,
        model,
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
          perJobTokens: 500_000,
          perJobCostMicros: 10_000_000,
          monthlyTokens: 1_000_000,
          monthlyCostMicros: 20_000_000,
        },
      },
    });
    const routeIds = ["review-isolated", "qa-isolated"];
    const router = createRoutingService({
      storage,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      routeId: () => routeIds.shift() ?? "unexpected-route",
    });
    storage.enqueueJob("github", "github:quality-split", {
      event: "pull_request",
      delivery: "quality-split",
      payload: pullRequestPayload(),
    }, 0);
    const dispatched: string[] = [];
    const deps = dependencies(storage, {
      routing: router,
      github: github({
        dispatchCi: async () => { dispatched.push("ci"); },
        dispatchAgentQuality: async (_repository, _pr, _sha, kind) => {
          dispatched.push(kind);
          if (kind === "review") throw new Error("review dispatch response was lost");
        },
      }),
    });

    await processNextJob(deps, 0);
    await processNextJob(deps, 1);
    await processNextJob(deps, 2);
    await processNextJob(deps, 3);

    expect(dispatched).toEqual(["ci", "review", "qa"]);
    expect(storage.getRoutingAttempt("review-isolated")).toMatchObject({
      status: "failed",
      failureCategory: "unknown",
    });
    expect(storage.getRoutingAttempt("qa-isolated")).toMatchObject({ status: "reserved" });
  });

  it("does not repeat a reclaimed review dispatch or fail the QA route", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ pullRequestNumber: 22, state: "working", headSha: HEAD_SHA }), 0);
    storage.setRoutingSettings({
      candidates: [{
        id: "claude-frontier",
        provider: "claude",
        model: "claude-review",
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
          perJobTokens: 500_000,
          perJobCostMicros: 10_000_000,
          monthlyTokens: 1_000_000,
          monthlyCostMicros: 20_000_000,
        },
      },
    });
    const routeIds = ["review-crashed", "qa-untouched"];
    const router = createRoutingService({
      storage,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      routeId: () => routeIds.shift() ?? "unexpected-route",
    });
    const task = (role: "review" | "qa") => ({
      jobId: `${role}:acme/store#22@${HEAD_SHA}`,
      role,
      complexity: "high" as const,
      instruction: `${role} the change.`,
      evidenceRefs: [`github://acme/store/pull/22@${HEAD_SHA}`],
      checkpointRef: `github://acme/store/pull/22@${HEAD_SHA}`,
      estimatedInputTokens: 20_000,
      maxOutputTokens: 10_000,
    });
    const review = await router.reserveRoute(task("review"));
    const qa = await router.reserveRoute(task("qa"));
    if (review.status !== "ready" || qa.status !== "ready") throw new Error("Expected quality routes");
    storage.enqueueJob("dispatch_agent_quality", "dispatch:review:review-crashed", {
      repository: "acme/store",
      pullRequestNumber: 22,
      headSha: HEAD_SHA,
      kind: "review",
      route: { provider: "claude", model: "claude-review", routeId: "review-crashed" },
    }, 0);
    expect(storage.claimJob(0, 1_000)?.kind).toBe("dispatch_agent_quality");
    const dispatched: string[] = [];

    await processNextJob(dependencies(storage, {
      routing: router,
      github: github({
        dispatchAgentQuality: async (_repository, _pr, _sha, kind) => { dispatched.push(kind); },
      }),
    }), 1_001);

    expect(dispatched).toEqual([]);
    expect(storage.getRoutingAttempt("review-crashed")).toMatchObject({
      status: "failed",
      failureCategory: "unknown",
    });
    expect(storage.getRoutingAttempt("qa-untouched")).toMatchObject({ status: "reserved" });
    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
      state: "blocked",
      blockReason: "route",
    });
  });

  it("accepts only the App-owned Flow branch and dispatches quality for its exact head", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork(), 0);
    const quality: Array<{ pr: number; sha: string }> = [];
    storage.enqueueJob("github", "github:trusted", {
      event: "pull_request", delivery: "trusted", payload: pullRequestPayload(),
    }, 0);

    const deps = dependencies(storage, { github: github({
      dispatchCi: async (_repository, pr, sha) => { quality.push({ pr, sha }); },
    }) });
    await processNextJob(deps, 0);
    await processNextJob(deps, 1);
    await processNextJob(deps, 2);
    await processNextJob(deps, 3);

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
      dispatchCi: async (_repository, pr, sha) => { quality.push({ pr, sha }); },
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

    const deps = dependencies(storage, { github: github({
      dispatchCi: async (_repository, _pr, sha) => { quality.push(sha); },
    }) });
    await processNextJob(deps, 0);
    await processNextJob(deps, 1);
    await processNextJob(deps, 2);
    await processNextJob(deps, 3);

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
      dispatchBuild: async (_repository, issue, _route, _ref, context) => {
        builds.push({ issue, ...(context === undefined ? {} : { context }) });
      },
    }) });

    await processNextJob(deps, 0);
    await processNextJob(deps, 1);
    await processNextJob(deps, Date.now() + 1_000);
    await processNextJob(deps, Date.now() + 1_001);

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

  it("records successful independent checks that finish while another route is blocked", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({
      pullRequestNumber: 22,
      state: "blocked",
      blockReason: "route",
      headSha: HEAD_SHA,
    }), 0);
    storage.enqueueJob("github", "github:ci-pass-while-blocked", {
      event: "workflow_run",
      delivery: "ci-pass-while-blocked",
      payload: workflowPayload("Flow CI", "success"),
    }, 0);

    await processNextJob(dependencies(storage), 0);

    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
      state: "blocked",
      blockReason: "route",
      passedChecks: ["ci"],
    });
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

  it("does not open a pull request when a successful build asked for clarification", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "working" }), 0);
    storage.enqueueJob("github", "github:clarifying-build", {
      event: "workflow_run",
      delivery: "clarifying-build",
      payload: {
        action: "completed",
        repository: { full_name: "acme/store" },
        workflow_run: {
          id: 91,
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
          html_url: "https://github.com/acme/store/actions/runs/91",
        },
      },
    }, 0);
    const opened: number[] = [];

    await processNextJob(dependencies(storage, { github: github({
      getFlowState: async () => "blocked",
      openPullRequest: async (_repository, issue) => { opened.push(issue); return 22; },
    }) }), 0);

    expect(opened).toEqual([]);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("blocked");
  });

  it("retains a builder clarification that arrives before the completed workflow event", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork(linkedWork({ state: "working" }), 0);
    storage.enqueueJob("github", "github:early-clarification", {
      event: "issue_comment",
      delivery: "early-clarification",
      payload: {
        action: "created",
        repository: { full_name: "acme/store" },
        issue: { number: 17, html_url: "https://github.com/acme/store/issues/17" },
        comment: {
          id: 701,
          body: formatClarificationComment({
            version: 1,
            id: "builder:91:17",
            source: "builder",
            question: "Which role should see this control?",
          }),
          user: { login: "flow-ai[bot]", type: "Bot" },
        },
      },
    }, 0);
    storage.enqueueJob("github", "github:completed-after-question", {
      event: "workflow_run",
      delivery: "completed-after-question",
      payload: {
        action: "completed",
        repository: { full_name: "acme/store" },
        workflow_run: {
          id: 91,
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
          html_url: "https://github.com/acme/store/actions/runs/91",
        },
      },
    }, 1);
    const deps = dependencies(storage, { github: github({ getFlowState: async () => "blocked" }) });

    await processNextJob(deps, 0);
    await processNextJob(deps, 1);

    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
      state: "blocked",
      blockReason: "clarification",
      clarificationId: "builder:91:17",
    });
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
