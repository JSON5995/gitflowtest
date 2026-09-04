import type { Provider } from "./domain.js";

export type AgentRole = "intake" | "plan" | "build" | "review" | "qa" | "security";
export type TaskComplexity = "low" | "medium" | "high";
export type ModelTier = "economy" | "frontier";

export type ModelCandidate = {
  id: string;
  provider: Provider;
  model: string;
  tier: ModelTier;
  enabled: boolean;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  roles?: AgentRole[];
};

export type RoutingTask = {
  jobId: string;
  role: AgentRole;
  complexity: TaskComplexity;
  instruction: string;
  evidenceRefs: readonly string[];
  checkpointRef: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type RouterLimits = {
  perJobTokens: number;
  perJobCostMicros: number;
  monthlyTokens: number;
  monthlyCostMicros: number;
};

export type RouterPolicy = {
  maxTransientRetriesPerCandidate: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  reservationTtlMs: number;
  limits: RouterLimits;
};

export type BudgetDenialReason =
  | "job_tokens"
  | "job_cost"
  | "monthly_tokens"
  | "monthly_cost";

export type UsageReservationRequest = {
  jobId: string;
  month: string;
  candidate: ModelCandidate;
  attempt: number;
  estimatedUsage: TokenUsage;
  estimatedCostMicros: number;
  limits: RouterLimits;
  expiresAt: string;
};

export type UsageSettlement = {
  reservationId: string;
  actualUsage: TokenUsage;
  actualCostMicros: number;
};

/**
 * Implementations must make reserve atomic. A SQLite implementation should use
 * BEGIN IMMEDIATE; Postgres should lock the job/month budget rows in one transaction.
 */
export type UsageLedger = {
  reserve(request: UsageReservationRequest): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; reason: BudgetDenialReason }
  >;
  settle(settlement: UsageSettlement): Promise<void>;
  release(reservationId: string): Promise<void>;
};

export type ProviderRequest = {
  task: RoutingTask;
  candidate: ModelCandidate;
  attempt: number;
};

export type ProviderRunResult<T> = {
  value: T;
  usage: TokenUsage;
};

export type ProviderAdapter<T> = {
  provider: Provider;
  execute(request: ProviderRequest): Promise<ProviderRunResult<T>>;
};

export const PROVIDER_FAILURE_CATEGORIES = [
  "rate_limit",
  "timeout",
  "network",
  "outage",
  "authentication",
  "invalid_request",
  "task_failure",
  "test_failure",
  "security",
  "policy",
  "unknown",
] as const;

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

type ProviderFailureOptions = {
  retryAfterMs?: number;
  usage?: TokenUsage;
};

export class ProviderExecutionError extends Error {
  readonly category: ProviderFailureCategory;
  readonly retryAfterMs: number | undefined;
  readonly usage: TokenUsage | undefined;

  constructor(category: ProviderFailureCategory, message: string, options: ProviderFailureOptions = {}) {
    super(message);
    this.name = "ProviderExecutionError";
    this.category = category;
    this.retryAfterMs = options.retryAfterMs;
    this.usage = options.usage;
  }
}

export type RouterState = "queued" | "selecting" | "running" | "retry_wait" | "handoff" | "complete" | "failed" | "blocked";

export type RouterEvent = {
  jobId: string;
  state: RouterState;
  occurredAt: string;
  provider?: Provider;
  model?: string;
  attempt?: number;
  reason?: string;
};

export type RouteResult<T> =
  | { status: "complete"; provider: Provider; model: string; value: T; usage: TokenUsage }
  | { status: "failed"; reason: "task_failure" | "test_failure"; provider: Provider; model: string; message: string }
  | {
      status: "blocked";
      reason: "budget" | "providers_unavailable" | "configuration" | "security" | "policy";
      message: string;
    };

type SelectDefaultRouteOptions = {
  role: AgentRole;
  complexity: TaskComplexity;
  catalog: readonly ModelCandidate[];
  preferIndependentFrom?: Provider;
};

const providerOrder: Record<AgentRole, readonly Provider[]> = {
  intake: ["codex", "claude", "cursor"],
  plan: ["claude", "codex", "cursor"],
  build: ["codex", "claude", "cursor"],
  review: ["claude", "codex", "cursor"],
  qa: ["claude", "codex", "cursor"],
  security: ["claude", "codex", "cursor"],
};

const preferredTier = (role: AgentRole, complexity: TaskComplexity): ModelTier =>
  role === "security" || complexity !== "low" ? "frontier" : "economy";

export const selectDefaultRoute = ({
  role,
  complexity,
  catalog,
  preferIndependentFrom,
}: SelectDefaultRouteOptions): ModelCandidate[] => {
  const enabled = catalog.filter((candidate) =>
    candidate.enabled && (!candidate.roles || candidate.roles.includes(role)));
  const tier = preferredTier(role, complexity);
  const ordered: ModelCandidate[] = [];
  const used = new Set<string>();

  for (const provider of providerOrder[role]) {
    for (const candidate of enabled) {
      if (candidate.provider === provider && candidate.tier === tier && !used.has(candidate.id)) {
        ordered.push(candidate);
        used.add(candidate.id);
      }
    }
  }
  for (const candidate of enabled) {
    if (!used.has(candidate.id)) ordered.push(candidate);
  }

  if (!preferIndependentFrom || new Set(ordered.map((candidate) => candidate.provider)).size < 2) {
    return ordered;
  }
  return [
    ...ordered.filter((candidate) => candidate.provider !== preferIndependentFrom),
    ...ordered.filter((candidate) => candidate.provider === preferIndependentFrom),
  ];
};

const transientCategories = new Set<ProviderFailureCategory>(["rate_limit", "timeout", "network", "outage"]);
const networkErrorCodes = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);

const numericProperty = (value: unknown, property: string): number | undefined => {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "number" ? candidate : undefined;
};

const stringProperty = (value: unknown, property: string): string | undefined => {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate : undefined;
};

export const classifyProviderError = (error: unknown): ProviderExecutionError => {
  if (error instanceof ProviderExecutionError) return error;
  const status = numericProperty(error, "status") ?? numericProperty(error, "statusCode");
  const message = error instanceof Error ? error.message : String(error);
  if (status === 429) return new ProviderExecutionError("rate_limit", message);
  if (status === 401 || status === 403) return new ProviderExecutionError("authentication", message);
  if (status === 408) return new ProviderExecutionError("timeout", message);
  if (status !== undefined && status >= 500 && status <= 599) {
    return new ProviderExecutionError("outage", message);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderExecutionError("invalid_request", message);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderExecutionError("timeout", message);
  }
  if (networkErrorCodes.has(stringProperty(error, "code") ?? "")) {
    return new ProviderExecutionError("network", message);
  }
  return new ProviderExecutionError("unknown", message);
};

const immutableTask = (task: RoutingTask): RoutingTask => Object.freeze({
  ...task,
  evidenceRefs: Object.freeze([...task.evidenceRefs]),
});

export const calculateCostMicros = (candidate: ModelCandidate, usage: TokenUsage): number => Math.ceil(
  (usage.inputTokens * candidate.inputMicrosPerMillionTokens
    + usage.outputTokens * candidate.outputMicrosPerMillionTokens) / 1_000_000,
);

const monthKey = (date: Date): string => date.toISOString().slice(0, 7);

const validNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validateInputs = (task: RoutingTask, policy: RouterPolicy, candidates: readonly ModelCandidate[]): void => {
  const numericValues = [
    task.estimatedInputTokens,
    task.maxOutputTokens,
    policy.maxTransientRetriesPerCandidate,
    policy.baseBackoffMs,
    policy.maxBackoffMs,
    policy.reservationTtlMs,
    policy.limits.perJobTokens,
    policy.limits.perJobCostMicros,
    policy.limits.monthlyTokens,
    policy.limits.monthlyCostMicros,
    ...candidates.flatMap((candidate) => [
      candidate.inputMicrosPerMillionTokens,
      candidate.outputMicrosPerMillionTokens,
    ]),
  ];
  if (!task.jobId || !task.instruction || !task.checkpointRef || numericValues.some((value) => !validNonNegativeInteger(value))) {
    throw new Error("Provider router received invalid task, budget, retry, or pricing configuration");
  }
  if (
    candidates.some((candidate) => !candidate.id || !candidate.model)
    || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
  ) {
    throw new Error("Provider router candidates require unique IDs and explicit model names");
  }
  if (policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error("Provider router jitterRatio must be between 0 and 1");
  }
};

const retryDelay = (
  retryNumber: number,
  error: ProviderExecutionError,
  policy: RouterPolicy,
  random: () => number,
): number => {
  const exponential = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (retryNumber - 1));
  const requested = error.retryAfterMs === undefined ? exponential : Math.min(policy.maxBackoffMs, error.retryAfterMs);
  const jitter = requested * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.min(policy.maxBackoffMs, Math.round(requested + jitter)));
};

type RouteProviderTaskOptions<T> = {
  task: RoutingTask;
  candidates: readonly ModelCandidate[];
  adapters: Partial<Record<Provider, ProviderAdapter<T>>>;
  ledger: UsageLedger;
  policy: RouterPolicy;
  appendEvent(event: RouterEvent): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now?: () => Date;
  random?: () => number;
};

const eventWithCandidate = (
  task: RoutingTask,
  state: RouterState,
  now: Date,
  candidate: ModelCandidate,
  attempt: number,
  reason?: string,
): RouterEvent => ({
  jobId: task.jobId,
  state,
  occurredAt: now.toISOString(),
  provider: candidate.provider,
  model: candidate.model,
  attempt,
  ...(reason ? { reason } : {}),
});

export const routeProviderTask = async <T>({
  task: rawTask,
  candidates: rawCandidates,
  adapters,
  ledger,
  policy,
  appendEvent,
  sleep,
  now = () => new Date(),
  random = Math.random,
}: RouteProviderTaskOptions<T>): Promise<RouteResult<T>> => {
  validateInputs(rawTask, policy, rawCandidates);
  const task = immutableTask(rawTask);
  const candidates = rawCandidates.filter((candidate) => candidate.enabled);
  await appendEvent({ jobId: task.jobId, state: "queued", occurredAt: now().toISOString() });
  if (candidates.length === 0) {
    const message = "No enabled provider/model route is configured";
    await appendEvent({ jobId: task.jobId, state: "blocked", occurredAt: now().toISOString(), reason: "configuration" });
    return { status: "blocked", reason: "configuration", message };
  }

  const estimate = { inputTokens: task.estimatedInputTokens, outputTokens: task.maxOutputTokens };
  let totalAttempt = 0;
  let sawBudgetDenial = false;
  let sawTransientFailure = false;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    if (!candidate) continue;
    const adapter = adapters[candidate.provider];
    if (!adapter || adapter.provider !== candidate.provider) {
      await appendEvent(eventWithCandidate(task, "selecting", now(), candidate, totalAttempt, "adapter_unavailable"));
      continue;
    }

    for (let retry = 0; retry <= policy.maxTransientRetriesPerCandidate; retry += 1) {
      totalAttempt += 1;
      await appendEvent(eventWithCandidate(task, "selecting", now(), candidate, totalAttempt));
      const reservation = await ledger.reserve({
        jobId: task.jobId,
        month: monthKey(now()),
        candidate,
        attempt: totalAttempt,
        estimatedUsage: estimate,
        estimatedCostMicros: calculateCostMicros(candidate, estimate),
        limits: policy.limits,
        expiresAt: new Date(now().getTime() + policy.reservationTtlMs).toISOString(),
      });
      if (!reservation.ok) {
        sawBudgetDenial = true;
        await appendEvent(eventWithCandidate(task, "selecting", now(), candidate, totalAttempt, reservation.reason));
        break;
      }

      await appendEvent(eventWithCandidate(task, "running", now(), candidate, totalAttempt));
      try {
        const result = await adapter.execute({ task, candidate, attempt: totalAttempt });
        if (!validNonNegativeInteger(result.usage.inputTokens) || !validNonNegativeInteger(result.usage.outputTokens)) {
          throw new ProviderExecutionError("invalid_request", "Provider returned invalid token usage");
        }
        await ledger.settle({
          reservationId: reservation.reservationId,
          actualUsage: result.usage,
          actualCostMicros: calculateCostMicros(candidate, result.usage),
        });
        await appendEvent(eventWithCandidate(task, "complete", now(), candidate, totalAttempt));
        return {
          status: "complete",
          provider: candidate.provider,
          model: candidate.model,
          value: result.value,
          usage: result.usage,
        };
      } catch (caught) {
        const error = classifyProviderError(caught);
        // When a remote call has uncertain accounting, charge the reservation rather
        // than silently releasing budget that may already have been consumed.
        const chargedUsage = error.usage ?? estimate;
        await ledger.settle({
          reservationId: reservation.reservationId,
          actualUsage: chargedUsage,
          actualCostMicros: calculateCostMicros(candidate, chargedUsage),
        });

        if (error.category === "security" || error.category === "policy") {
          await appendEvent(eventWithCandidate(task, "blocked", now(), candidate, totalAttempt, error.category));
          return { status: "blocked", reason: error.category, message: error.message };
        }
        if (error.category === "task_failure" || error.category === "test_failure") {
          await appendEvent(eventWithCandidate(task, "failed", now(), candidate, totalAttempt, error.category));
          return {
            status: "failed",
            reason: error.category,
            provider: candidate.provider,
            model: candidate.model,
            message: error.message,
          };
        }
        if (!transientCategories.has(error.category)) {
          await appendEvent(eventWithCandidate(task, "blocked", now(), candidate, totalAttempt, error.category));
          return { status: "blocked", reason: "configuration", message: error.message };
        }

        sawTransientFailure = true;
        if (retry < policy.maxTransientRetriesPerCandidate) {
          const delay = retryDelay(retry + 1, error, policy, random);
          await appendEvent(eventWithCandidate(task, "retry_wait", now(), candidate, totalAttempt, error.category));
          await sleep(delay);
          continue;
        }

        const next = candidates[candidateIndex + 1];
        if (next) {
          await appendEvent(eventWithCandidate(task, "handoff", now(), next, totalAttempt, error.category));
        }
        break;
      }
    }
  }

  const reason = sawBudgetDenial ? "budget" : sawTransientFailure ? "providers_unavailable" : "configuration";
  const message = reason === "providers_unavailable"
    ? "All configured providers are unavailable and no fallback remains"
    : reason === "budget"
      ? "The job or monthly token/cost budget is exhausted"
      : "No configured provider adapter can execute this route";
  await appendEvent({ jobId: task.jobId, state: "blocked", occurredAt: now().toISOString(), reason });
  return { status: "blocked", reason, message };
};
