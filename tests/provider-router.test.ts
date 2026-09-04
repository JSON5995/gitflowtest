import { describe, expect, it, vi } from "vitest";
import {
  ProviderExecutionError,
  routeProviderTask,
  selectDefaultRoute,
  type ModelCandidate,
  type ProviderAdapter,
  type RouterEvent,
  type RoutingTask,
  type UsageLedger,
  type UsageReservationRequest,
} from "../src/provider-router.js";

const task: RoutingTask = {
  jobId: "job-42",
  role: "build",
  complexity: "high",
  instruction: "Implement issue #42 exactly as accepted.",
  evidenceRefs: ["github://acme/app/issues/42#sha256:abc"],
  checkpointRef: "github://acme/app/git/refs/heads/flow/42@0123456789abcdef",
  estimatedInputTokens: 4_000,
  maxOutputTokens: 8_000,
};

const candidate = (
  id: string,
  provider: ModelCandidate["provider"],
  tier: ModelCandidate["tier"],
): ModelCandidate => ({
  id,
  provider,
  model: `${provider}-${tier}`,
  tier,
  enabled: true,
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 2_000_000,
});

const openai = candidate("codex-frontier", "codex", "frontier");
const anthropic = candidate("claude-frontier", "claude", "frontier");
const cursor = candidate("cursor-auto", "cursor", "frontier");

const ledger = (deniedCandidateId?: string): UsageLedger => ({
  reserve: vi.fn(async (request: UsageReservationRequest) =>
    request.candidate.id === deniedCandidateId
      ? { ok: false as const, reason: "monthly_cost" as const }
      : { ok: true as const, reservationId: `${request.jobId}:${request.candidate.id}:${request.attempt}` }),
  settle: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
});

const policy = {
  maxTransientRetriesPerCandidate: 1,
  baseBackoffMs: 100,
  maxBackoffMs: 1_000,
  jitterRatio: 0,
  reservationTtlMs: 60_000,
  limits: {
    perJobTokens: 30_000,
    perJobCostMicros: 1_000_000,
    monthlyTokens: 1_000_000,
    monthlyCostMicros: 20_000_000,
  },
} as const;

describe("provider router", () => {
  it("routes each agent role only to candidates configured for that role", () => {
    const catalog: ModelCandidate[] = [
      { ...candidate("codex-build", "codex", "frontier"), roles: ["intake", "plan", "build"] },
      { ...candidate("codex-review", "codex", "frontier"), roles: ["review", "security"] },
      { ...candidate("claude-qa", "claude", "frontier"), roles: ["qa"] },
    ];

    expect(selectDefaultRoute({ role: "build", complexity: "high", catalog }).map((item) => item.id))
      .toEqual(["codex-build"]);
    expect(selectDefaultRoute({ role: "review", complexity: "high", catalog }).map((item) => item.id))
      .toEqual(["codex-review"]);
    expect(selectDefaultRoute({ role: "qa", complexity: "high", catalog }).map((item) => item.id))
      .toEqual(["claude-qa"]);
  });

  it("selects a role/complexity route and keeps the builder last for independent review", () => {
    const route = selectDefaultRoute({
      role: "review",
      complexity: "high",
      catalog: [openai, cursor, anthropic],
      preferIndependentFrom: "claude",
    });

    expect(route.map((item) => item.provider)).toEqual(["codex", "cursor", "claude"]);
  });

  it("retries transient failures with bounded backoff, then hands the identical task to another provider", async () => {
    const seen: RoutingTask[] = [];
    const codex: ProviderAdapter<string> = {
      provider: "codex",
      execute: vi.fn(async ({ task: routedTask }) => {
        seen.push(routedTask);
        throw new ProviderExecutionError("outage", "OpenAI unavailable");
      }),
    };
    const claude: ProviderAdapter<string> = {
      provider: "claude",
      execute: vi.fn(async ({ task: routedTask }) => {
        seen.push(routedTask);
        return { value: "done", usage: { inputTokens: 3_000, outputTokens: 2_000 } };
      }),
    };
    const events: RouterEvent[] = [];
    const sleep = vi.fn(async () => undefined);

    const result = await routeProviderTask({
      task,
      candidates: [openai, anthropic],
      adapters: { codex, claude },
      ledger: ledger(),
      policy,
      appendEvent: async (event) => { events.push(event); },
      sleep,
      now: () => new Date("2026-09-04T10:00:00.000Z"),
      random: () => 0.5,
    });

    expect(result).toMatchObject({ status: "complete", provider: "claude", model: "claude-frontier", value: "done" });
    expect(seen).toHaveLength(3);
    expect(seen.every((routedTask) => routedTask === seen[0])).toBe(true);
    expect(seen[0]).not.toBe(task);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.evidenceRefs)).toBe(true);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(events.some((event) => event.state === "handoff" && event.provider === "claude")).toBe(true);
  });

  it.each(["task_failure", "test_failure"] as const)("does not retry or fail over a deterministic %s", async (category) => {
    const first: ProviderAdapter<string> = {
      provider: "codex",
      execute: vi.fn(async () => { throw new ProviderExecutionError(category, "candidate failed"); }),
    };
    const fallback: ProviderAdapter<string> = {
      provider: "claude",
      execute: vi.fn(async () => ({ value: "unsafe retry", usage: { inputTokens: 1, outputTokens: 1 } })),
    };

    const result = await routeProviderTask({
      task,
      candidates: [openai, anthropic],
      adapters: { codex: first, claude: fallback },
      ledger: ledger(),
      policy,
      appendEvent: async () => undefined,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ status: "failed", reason: category });
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it.each(["security", "policy"] as const)("blocks without retrying or changing provider on %s failures", async (category) => {
    const first: ProviderAdapter<string> = {
      provider: "codex",
      execute: vi.fn(async () => { throw new ProviderExecutionError(category, "refused"); }),
    };
    const fallback: ProviderAdapter<string> = {
      provider: "claude",
      execute: vi.fn(async () => ({ value: "must not run", usage: { inputTokens: 1, outputTokens: 1 } })),
    };

    const result = await routeProviderTask({
      task,
      candidates: [openai, anthropic],
      adapters: { codex: first, claude: fallback },
      ledger: ledger(),
      policy,
      appendEvent: async () => undefined,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ status: "blocked", reason: category });
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it("reports a single-provider outage as blocked after bounded retries", async () => {
    const only: ProviderAdapter<string> = {
      provider: "codex",
      execute: vi.fn(async () => { throw new ProviderExecutionError("rate_limit", "slow down", { retryAfterMs: 250 }); }),
    };
    const sleep = vi.fn(async () => undefined);

    const result = await routeProviderTask({
      task,
      candidates: [openai],
      adapters: { codex: only },
      ledger: ledger(),
      policy,
      appendEvent: async () => undefined,
      sleep,
    });

    expect(result).toMatchObject({ status: "blocked", reason: "providers_unavailable" });
    expect(only.execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("skips a model that cannot reserve budget and uses a cheaper configured fallback", async () => {
    const second: ProviderAdapter<string> = {
      provider: "claude",
      execute: vi.fn(async () => ({ value: "within budget", usage: { inputTokens: 100, outputTokens: 50 } })),
    };

    const result = await routeProviderTask({
      task,
      candidates: [openai, anthropic],
      adapters: { claude: second },
      ledger: ledger(openai.id),
      policy,
      appendEvent: async () => undefined,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ status: "complete", provider: "claude" });
    expect(second.execute).toHaveBeenCalledTimes(1);
  });
});
