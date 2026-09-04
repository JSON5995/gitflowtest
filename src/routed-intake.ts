import { createHash } from "node:crypto";
import type { Provider } from "./domain.js";
import {
  createAnthropicIntakeClient,
  createOpenAIIntakeClient,
  type IntakeModel,
  type PlanningInput,
} from "./intake.js";
import { classifyProviderError, ProviderExecutionError, type RoutingTask } from "./provider-router.js";
import type { RouteDecision, createRoutingService } from "./routing-service.js";

type RoutedIntakeRouter = Pick<
  ReturnType<typeof createRoutingService>,
  "listJobAttempts" | "reserveRoute" | "completeRoute" | "failRoute"
>;

type ExecutePlanning = (
  provider: Provider,
  model: string,
  input: PlanningInput,
  validationErrors?: string[],
) => Promise<unknown>;

type RoutedIntakeOptions = {
  routing: RoutedIntakeRouter;
  getCredential(provider: Provider): string | null;
  execute?: ExecutePlanning;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

const blockedError = (decision: Exclude<RouteDecision, { status: "ready" }>): Error =>
  new Error(decision.message);

const interruptedIntakeError = (): Error & { permanent: true } => Object.assign(
  new Error(
    "A previous intake attempt ended without a recoverable result. Flow will not repeat an ambiguous provider request; submit a new Telegram request to try again.",
  ),
  { permanent: true as const },
);

export const createRoutedIntakeModel = ({
  routing,
  getCredential,
  fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  execute,
}: RoutedIntakeOptions): IntakeModel => {
  const run: ExecutePlanning = execute ?? (async (provider, model, input, validationErrors) => {
    const apiKey = getCredential(provider);
    if (!apiKey) throw new ProviderExecutionError("authentication", `${provider} is not connected`);
    if (provider === "codex") {
      return createOpenAIIntakeClient({ apiKey, planningModel: model, ...(fetch ? { fetch } : {}) })
        .createPlan(input, validationErrors);
    }
    if (provider === "claude") {
      return createAnthropicIntakeClient({ apiKey, model, ...(fetch ? { fetch } : {}) })
        .createPlan(input, validationErrors);
    }
    throw new ProviderExecutionError(
      "invalid_request",
      "Cursor cannot run hosted intake; enable OpenAI or Anthropic for planning",
    );
  });

  return {
    async createPlan(input, validationErrors) {
      const evidenceHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const submissionHash = createHash("sha256")
        .update(`${input.repository}\0${input.submissionId}`)
        .digest("hex");
      const jobId = `intake:${submissionHash}`;
      const priorAttempts = routing.listJobAttempts(jobId);
      const activeAttempt = priorAttempts.find((attempt) => attempt.status === "reserved");
      if (activeAttempt) {
        await routing.failRoute(activeAttempt.routeId, "unknown");
        throw interruptedIntakeError();
      }
      if (priorAttempts.length > 0 && !validationErrors?.length) {
        throw interruptedIntakeError();
      }
      const task: RoutingTask = {
        jobId,
        role: "intake",
        complexity: input.images?.length ? "high" : "medium",
        instruction: "Convert the captured feedback and repository context into a validated work plan.",
        evidenceRefs: [`flow://intake/sha256:${evidenceHash}`],
        checkpointRef: `github://${input.repository}`,
        estimatedInputTokens: Math.min(50_000, 2_000 + Math.ceil(JSON.stringify(input).length / 4)),
        maxOutputTokens: 5_000,
      };
      let decision = await routing.reserveRoute(task);
      while (decision.status === "ready") {
        if (decision.delayMs > 0) await sleep(decision.delayMs);
        try {
          const value = await run(decision.route.provider, decision.route.model, input, validationErrors);
          await routing.completeRoute(decision.route.routeId);
          return value;
        } catch (error) {
          decision = await routing.failRoute(decision.route.routeId, classifyProviderError(error).category);
        }
      }
      throw blockedError(decision);
    },
  };
};
