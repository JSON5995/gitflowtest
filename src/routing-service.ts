import { randomUUID } from "node:crypto";
import type { Provider } from "./domain.js";
import {
  calculateCostMicros,
  selectDefaultRoute,
  type ProviderFailureCategory,
  type RouterEvent,
  type RoutingTask,
  type TokenUsage,
} from "./provider-router.js";
import type { Storage, StoredRoutingAttempt } from "./storage.js";

export type RouteAttempt = {
  routeId: string;
  provider: Provider;
  model: string;
  candidateId: string;
  attempt: number;
  reservationId: string;
  task: RoutingTask;
};

export type RouteDecision =
  | {
      status: "ready";
      action: "dispatch" | "retry" | "handoff";
      delayMs: number;
      route: RouteAttempt;
    }
  | {
      status: "blocked";
      reason: "budget" | "providers_unavailable" | "configuration" | "security" | "policy";
      message: string;
    }
  | {
      status: "failed";
      reason: "task_failure" | "test_failure";
      message: string;
    };

type RoutingStorage = Pick<
  Storage,
  | "getRoutingSettings"
  | "reserveUsage"
  | "getUsageReservation"
  | "saveRoutingAttempt"
  | "getRoutingAttempt"
  | "listRoutingAttempts"
  | "finalizeRoutingAttempt"
  | "appendRoutingEvent"
>;

type CreateRoutingServiceOptions = {
  storage: RoutingStorage;
  now?: () => Date;
  routeId?: () => string;
};

const transientFailures = new Set<ProviderFailureCategory>([
  "rate_limit",
  "timeout",
  "network",
  "outage",
]);

const immutableTask = (task: RoutingTask): RoutingTask => Object.freeze({
  ...task,
  evidenceRefs: Object.freeze([...task.evidenceRefs]),
});

const estimatedUsage = (task: RoutingTask): TokenUsage => ({
  inputTokens: task.estimatedInputTokens,
  outputTokens: task.maxOutputTokens,
});

const attemptEvent = (
  attempt: StoredRoutingAttempt,
  state: RouterEvent["state"],
  occurredAt: string,
  reason?: string,
): RouterEvent => ({
  jobId: attempt.task.jobId,
  state,
  occurredAt,
  provider: attempt.candidate.provider,
  model: attempt.candidate.model,
  attempt: attempt.attempt,
  ...(reason ? { reason } : {}),
});

const delayForAttempt = (
  candidateAttempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number => Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, candidateAttempt - 2));

export const createRoutingService = ({
  storage,
  now = () => new Date(),
  routeId = randomUUID,
}: CreateRoutingServiceOptions) => {
  const reserveNext = async (
    rawTask: RoutingTask,
    preferIndependentFrom?: Provider,
    retryCandidateId?: string,
  ): Promise<RouteDecision> => {
    const settings = storage.getRoutingSettings();
    if (!settings) {
      return {
        status: "blocked",
        reason: "configuration",
        message: "Model routing has not been configured in Flow Admin",
      };
    }

    const task = immutableTask(rawTask);
    const previous = storage.listRoutingAttempts(task.jobId);
    if (previous.some((item) => item.status === "reserved")) {
      return {
        status: "blocked",
        reason: "configuration",
        message: "This job already has an active provider route",
      };
    }
    const lastCompletedIndex = previous.map((item) => item.status === "complete").lastIndexOf(true);
    const currentStage = previous.slice(lastCompletedIndex + 1);

    const defaultOrder = selectDefaultRoute({
      role: task.role,
      complexity: task.complexity,
      catalog: settings.candidates,
      ...(preferIndependentFrom ? { preferIndependentFrom } : {}),
    });
    const candidates = retryCandidateId
      ? [
          ...defaultOrder.filter((item) => item.id === retryCandidateId),
          ...defaultOrder.filter((item) => item.id !== retryCandidateId),
        ]
      : defaultOrder;

    if (candidates.length === 0) {
      return {
        status: "blocked",
        reason: "providers_unavailable",
        message: "No enabled provider and model is available",
      };
    }

    let sawBudgetDenial = false;
    for (const candidate of candidates) {
      const candidateAttempts = currentStage.filter((item) => item.candidate.id === candidate.id);
      const candidateAttempt = candidateAttempts.length + 1;
      if (candidateAttempt > settings.policy.maxTransientRetriesPerCandidate + 1) continue;

      const timestamp = now();
      const usage = estimatedUsage(task);
      const reservation = await storage.reserveUsage({
        jobId: task.jobId,
        month: timestamp.toISOString().slice(0, 7),
        candidate,
        attempt: candidateAttempt,
        estimatedUsage: usage,
        estimatedCostMicros: calculateCostMicros(candidate, usage),
        limits: settings.policy.limits,
        expiresAt: new Date(timestamp.getTime() + settings.policy.reservationTtlMs).toISOString(),
      }, timestamp);
      if (!reservation.ok) {
        sawBudgetDenial = true;
        continue;
      }

      const prior = currentStage.at(-1);
      const action = !prior
        ? "dispatch" as const
        : prior.candidate.id === candidate.id
          ? "retry" as const
          : "handoff" as const;
      const delayMs = action === "retry"
        ? delayForAttempt(candidateAttempt, settings.policy.baseBackoffMs, settings.policy.maxBackoffMs)
        : 0;
      const stored: StoredRoutingAttempt = {
        routeId: routeId(),
        task,
        candidate,
        attempt: candidateAttempt,
        reservationId: reservation.reservationId,
        status: "reserved",
        failureCategory: null,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
      };
      storage.saveRoutingAttempt(stored);
      storage.appendRoutingEvent(attemptEvent(stored, action === "retry" ? "retry_wait" : action === "handoff" ? "handoff" : "running", stored.createdAt));
      return {
        status: "ready",
        action,
        delayMs,
        route: {
          routeId: stored.routeId,
          provider: candidate.provider,
          model: candidate.model,
          candidateId: candidate.id,
          attempt: candidateAttempt,
          reservationId: reservation.reservationId,
          task,
        },
      };
    }

    return sawBudgetDenial
      ? {
          status: "blocked",
          reason: "budget",
          message: "The job or monthly token/cost budget would be exceeded",
        }
      : {
          status: "blocked",
          reason: "providers_unavailable",
          message: "All enabled provider routes have exhausted their retry allowance",
        };
  };

  const settlementFor = (attempt: StoredRoutingAttempt, usage?: TokenUsage) => {
    const reservation = storage.getUsageReservation(attempt.reservationId);
    if (!reservation || reservation.status !== "reserved") {
      throw new Error("Usage reservation is no longer active");
    }
    const actualUsage = usage ?? reservation.estimatedUsage;
    return {
      reservationId: attempt.reservationId,
      actualUsage,
      actualCostMicros: calculateCostMicros(attempt.candidate, actualUsage),
    };
  };

  return {
    listJobAttempts(jobId: string): StoredRoutingAttempt[] {
      return storage.listRoutingAttempts(jobId);
    },

    reserveRoute(task: RoutingTask, preferIndependentFrom?: Provider): Promise<RouteDecision> {
      return reserveNext(task, preferIndependentFrom);
    },

    async completeRoute(route: string, usage?: TokenUsage): Promise<void> {
      const attempt = storage.getRoutingAttempt(route);
      if (!attempt) throw new Error("Unknown provider route");
      if (attempt.status !== "reserved") return;
      const timestamp = now();
      const finalized = await storage.finalizeRoutingAttempt({
        routeId: route,
        status: "complete",
        failureCategory: null,
        settlement: settlementFor(attempt, usage),
        event: attemptEvent(attempt, "complete", timestamp.toISOString()),
      }, timestamp);
      if (!finalized) throw new Error("Usage reservation is no longer active");
    },

    async failRoute(route: string, category: ProviderFailureCategory, usage?: TokenUsage): Promise<RouteDecision> {
      const attempt = storage.getRoutingAttempt(route);
      if (!attempt) throw new Error("Unknown provider route");
      if (attempt.status !== "reserved") {
        return {
          status: "blocked",
          reason: "configuration",
          message: "The provider route is no longer active",
        };
      }
      const timestamp = now();
      const finalized = await storage.finalizeRoutingAttempt({
        routeId: route,
        status: "failed",
        failureCategory: category,
        settlement: settlementFor(attempt, usage),
        event: attemptEvent(attempt, "failed", timestamp.toISOString(), category),
      }, timestamp);
      if (!finalized) throw new Error("Usage reservation is no longer active");

      if (category === "security" || category === "policy") {
        return { status: "blocked", reason: category, message: `Provider stopped for ${category}` };
      }
      if (category === "task_failure" || category === "test_failure") {
        return { status: "failed", reason: category, message: `Provider reported ${category}` };
      }
      if (!transientFailures.has(category)) {
        return {
          status: "blocked",
          reason: "configuration",
          message: `Provider failed with non-retryable category: ${category}`,
        };
      }
      return reserveNext(attempt.task, undefined, attempt.candidate.id);
    },

    async cancelBeforeStart(route: string): Promise<void> {
      const attempt = storage.getRoutingAttempt(route);
      if (!attempt || attempt.status !== "reserved") return;
      const timestamp = now();
      const finalized = await storage.finalizeRoutingAttempt({
        routeId: route,
        status: "failed",
        failureCategory: "task_failure",
        settlement: null,
        event: attemptEvent(attempt, "failed", timestamp.toISOString(), "cancelled_before_start"),
      }, timestamp);
      if (!finalized) throw new Error("Usage reservation is no longer active");
    },
  };
};
