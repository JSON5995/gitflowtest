import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import {
  FLOW_STATES,
  type ClarificationRequest,
  type FeedbackBundle,
  type FlowState,
  type WorkPlan,
} from "./domain.js";
import { formatIssueBody, redactSecrets } from "./intake.js";
import type { Storage } from "./storage.js";
import {
  formatClarificationAnswerComment,
  formatClarificationComment,
  parseClarificationAnswerComment,
  parseClarificationComment,
  sanitizeFlowComment,
} from "./clarification.js";

export type GitHubApi = {
  request(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};

type GitHubGatewayOptions = {
  webhookSecret: string;
  botLogin?: string;
  getInstallationId(repository: string): Promise<number>;
  getApi(installationId: number): Promise<GitHubApi>;
};

export type PlannedIssueResult = {
  parentNumber: number;
  childNumbers: number[];
};

export type PublishedCheck = {
  name: "ci" | "ai-review" | "qa";
  headSha: string;
  conclusion: "success" | "failure";
  summary: string;
  detailsUrl: string;
  externalId: string;
};

export type TrustedWorkflow = {
  workflowId: number;
  path: string;
  headBranch: string;
  headSha: string;
};

export type WorkflowRoute = {
  provider: "codex" | "claude" | "cursor";
  model: string;
  routeId: string;
};

export type GitHubGateway = {
  verifyWebhook(payload: string, signature: string | undefined): boolean;
  hasRepositoryAccess(repository: string): Promise<{ installationId: number }>;
  createPlannedIssue(
    repository: string,
    plan: WorkPlan,
    source: FeedbackBundle["source"],
  ): Promise<PlannedIssueResult>;
  setFlowState(repository: string, issueNumber: number, state: FlowState): Promise<void>;
  dispatchBuild(repository: string, issueNumber: number, route: WorkflowRoute, ref?: string, repairContext?: string): Promise<void>;
  dispatchCi(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    ref?: string,
  ): Promise<void>;
  dispatchAgentQuality(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    kind: "review" | "qa",
    route: WorkflowRoute,
    ref?: string,
  ): Promise<void>;
  verifyTrustedWorkflow(repository: string, workflow: TrustedWorkflow): Promise<boolean>;
  verifyClarificationPublisher(
    repository: string,
    issueNumber: number,
    clarification: ClarificationRequest,
    publisher: { login: string; type: string },
  ): Promise<boolean>;
  publishCheck(repository: string, check: PublishedCheck): Promise<void>;
  openPullRequest(repository: string, issueNumber: number): Promise<number>;
  markPullRequestReady(repository: string, pullRequestNumber: number): Promise<void>;
  closeIssue(repository: string, issueNumber: number): Promise<void>;
  canAnswerClarification(repository: string, login: string): Promise<boolean>;
  getFlowState(repository: string, issueNumber: number): Promise<FlowState | null>;
  postClarificationAnswer(
    repository: string,
    issueNumber: number,
    answer: string,
    id: string,
  ): Promise<void>;
};

const splitRepository = (repository: string): { owner: string; repo: string } => {
  const match = repository.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner: match[1], repo: match[2] };
};

const responseStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
};

const WorkflowRouteSchema = z.object({
  provider: z.enum(["codex", "claude", "cursor"]),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  routeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
}).strict();

const IssueResponseSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  html_url: z.string().url(),
});

const ListedIssueSchema = IssueResponseSchema.extend({ body: z.string().nullable().optional() });

const issueMarker = (key: string, unit?: number): string =>
  `<!-- flow-source:${key}${unit === undefined ? "" : `:unit:${unit}`} -->`;

const labelName = (label: unknown): string | null => {
  if (typeof label === "string") return label;
  const parsed = z.object({ name: z.string().nullable() }).safeParse(label);
  return parsed.success ? parsed.data.name : null;
};

const redactWebhookString = (value: string): string =>
  sanitizeFlowComment(value, redactSecrets);

const redactWebhookPayload = (_event: string, payload: unknown): unknown => {
  if (typeof payload === "string") return redactWebhookString(payload);
  if (Array.isArray(payload)) return payload.map((value) => redactWebhookPayload(_event, value));
  if (typeof payload !== "object" || payload === null) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key,
    redactWebhookPayload(_event, value),
  ]));
};

export const verifyGitHubSignature = (
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export const createGitHubGateway = (options: GitHubGatewayOptions): GitHubGateway => {
  const apiFor = async (repository: string): Promise<{
    api: GitHubApi;
    installationId: number;
    owner: string;
    repo: string;
  }> => {
    const { owner, repo } = splitRepository(repository);
    const installationId = await options.getInstallationId(repository);
    return { api: await options.getApi(installationId), installationId, owner, repo };
  };

  const dispatchAgentQuality = async (
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    kind: "review" | "qa",
    rawRoute: WorkflowRoute,
    ref?: string,
  ): Promise<void> => {
    const route = WorkflowRouteSchema.parse(rawRoute);
    const { api, owner, repo } = await apiFor(repository);
    const targetRef = ref ?? z.object({ default_branch: z.string().min(1) }).parse((await api.request(
      "GET /repos/{owner}/{repo}", { owner, repo },
    )).data).default_branch;
    await api.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      owner,
      repo,
      workflow_id: kind === "review" ? "flow-review.yml" : "flow-qa.yml",
      ref: targetRef,
      inputs: {
        pr_number: String(pullRequestNumber),
        head_sha: headSha,
        provider: route.provider,
        model: route.model,
        route_id: route.routeId,
      },
    });
  };

  const dispatchCi = async (
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    ref?: string,
  ): Promise<void> => {
    const { api, owner, repo } = await apiFor(repository);
    const targetRef = ref ?? z.object({ default_branch: z.string().min(1) }).parse((await api.request(
      "GET /repos/{owner}/{repo}", { owner, repo },
    )).data).default_branch;
    await api.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      owner,
      repo,
      workflow_id: "flow-ci.yml",
      ref: targetRef,
      inputs: {
        pr_number: String(pullRequestNumber),
        head_sha: headSha,
      },
    });
  };

  const verifyTrustedWorkflow = async (
    repository: string,
    workflow: TrustedWorkflow,
  ): Promise<boolean> => {
    const { api, owner, repo } = await apiFor(repository);
    try {
      const repositoryData = z.object({ default_branch: z.string().min(1) }).parse((await api.request(
        "GET /repos/{owner}/{repo}", { owner, repo },
      )).data);
      if (workflow.headBranch !== repositoryData.default_branch) return false;
      const registered = z.object({
        id: z.number().int().positive(),
        path: z.string().min(1),
        state: z.literal("active"),
      }).safeParse((await api.request(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}",
        { owner, repo, workflow_id: workflow.workflowId },
      )).data);
      if (
        !registered.success
        || registered.data.id !== workflow.workflowId
        || registered.data.path !== workflow.path
      ) return false;
      const defaultHead = z.object({
        object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
      }).parse((await api.request(
        "GET /repos/{owner}/{repo}/git/ref/heads/{ref}",
        { owner, repo, ref: repositoryData.default_branch },
      )).data).object.sha;
      if (defaultHead === workflow.headSha) return true;
      const comparison = z.object({ status: z.enum(["ahead", "behind", "diverged", "identical"]) }).parse(
        (await api.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner,
          repo,
          basehead: `${workflow.headSha}...${defaultHead}`,
        })).data,
      );
      return comparison.status === "ahead" || comparison.status === "identical";
    } catch (error) {
      if ([404, 422].includes(responseStatus(error) ?? 0)) return false;
      throw error;
    }
  };

  const verifyClarificationPublisher = async (
    repository: string,
    issueNumber: number,
    clarification: ClarificationRequest,
    publisher: { login: string; type: string },
  ): Promise<boolean> => {
    if (publisher.type.toLowerCase() !== "bot") return false;
    if (options.botLogin && publisher.login.toLowerCase() === options.botLogin.toLowerCase()) return true;
    if (publisher.login.toLowerCase() !== "github-actions[bot]" || clarification.source !== "builder") return false;
    const marker = clarification.id.match(/^builder:([1-9][0-9]*):([1-9][0-9]*)$/);
    if (!marker?.[1] || Number(marker[2]) !== issueNumber || !options.botLogin) return false;
    const { api, owner, repo } = await apiFor(repository);
    try {
      const run = z.object({
        id: z.number().int().positive(),
        workflow_id: z.number().int().positive(),
        name: z.literal("Flow Build"),
        path: z.literal(".github/workflows/flow-build.yml"),
        event: z.literal("workflow_dispatch"),
        head_branch: z.string().min(1),
        head_sha: z.string().regex(/^[0-9a-f]{40}$/),
        display_title: z.string(),
        actor: z.object({ login: z.string() }),
        triggering_actor: z.object({ login: z.string() }),
      }).parse((await api.request(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
        { owner, repo, run_id: Number(marker[1]) },
      )).data);
      if (
        run.id !== Number(marker[1])
        || run.actor.login.toLowerCase() !== options.botLogin.toLowerCase()
        || run.triggering_actor.login.toLowerCase() !== options.botLogin.toLowerCase()
        || !new RegExp(`^Flow Build · Issue #${issueNumber} · Route [A-Za-z0-9_-]{1,200}$`).test(run.display_title)
      ) return false;
      return verifyTrustedWorkflow(repository, {
        workflowId: run.workflow_id,
        path: run.path,
        headBranch: run.head_branch,
        headSha: run.head_sha,
      });
    } catch (error) {
      if ([404, 422].includes(responseStatus(error) ?? 0)) return false;
      throw error;
    }
  };

  return {
    verifyWebhook(payload, signature) {
      return verifyGitHubSignature(payload, signature, options.webhookSecret);
    },

    async hasRepositoryAccess(repository) {
      const { installationId } = await apiFor(repository);
      return { installationId };
    },

    async createPlannedIssue(repository, plan, source) {
      const { api, owner, repo } = await apiFor(repository);
      const key = createHmac("sha256", options.webhookSecret)
        .update([source.chatId, source.topicId ?? "", source.userId, ...source.messageIds.map(String)].join("\u0000"))
        .digest("hex");
      const listed = z.array(ListedIssueSchema).parse((await api.request(
        "GET /repos/{owner}/{repo}/issues",
        { owner, repo, state: "all", sort: "created", direction: "desc", per_page: 100 },
      )).data);
      const initialState: FlowState = plan.needsHumanInput
        ? "blocked"
        : plan.units.length === 1
          ? "ready"
          : "inbox";
      const unitBody = plan.units.length === 1 ? `\n\n## Work unit\n\n${plan.units[0]!.body}` : "";
      const parentTag = issueMarker(key);
      const existingParent = listed.find((issue) => issue.body?.includes(parentTag));
      const parent = existingParent ?? IssueResponseSchema.parse((await api.request(
        "POST /repos/{owner}/{repo}/issues",
        {
          owner,
          repo,
          title: plan.title,
          body: `${formatIssueBody(plan)}${unitBody}\n\n${parentTag}`,
          labels: [`flow:${initialState}`],
        },
      )).data);
      const childNumbers: number[] = [];

      if (plan.needsHumanInput) {
        const comments = z.array(z.object({ body: z.string().nullable() })).parse((await api.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          { owner, repo, issue_number: parent.number, per_page: 100 },
        )).data);
        const existingIds = new Set(comments.flatMap((comment) => {
          const parsed = comment.body ? parseClarificationComment(comment.body) : null;
          return parsed ? [parsed.id] : [];
        }));
        for (const [index, clarification] of (plan.clarifications ?? []).entries()) {
          const id = `intake:${key}:${index}`;
          if (existingIds.has(id)) continue;
          await api.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner,
            repo,
            issue_number: parent.number,
            body: formatClarificationComment({
              version: 1,
              id,
              source: "intake",
              ...clarification,
            }),
          });
        }
      }

      if (!plan.needsHumanInput && plan.units.length > 1) {
        const linked = z.array(z.object({ id: z.number().int() })).parse((await api.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
          { owner, repo, issue_number: parent.number, per_page: 100 },
        )).data);
        const linkedIds = new Set(linked.map((issue) => issue.id));
        for (const [index, unit] of plan.units.entries()) {
          const childTag = issueMarker(key, index);
          const existingChild = listed.find((issue) => issue.body?.includes(childTag));
          const child = existingChild ?? IssueResponseSchema.parse((await api.request(
            "POST /repos/{owner}/{repo}/issues",
            {
              owner,
              repo,
              title: unit.title,
              body: `${unit.body}\n\nParent: #${parent.number}\n\n${childTag}`,
              labels: ["flow:ready"],
            },
          )).data);
          childNumbers.push(child.number);
          if (!linkedIds.has(child.id)) {
            await api.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
              owner,
              repo,
              issue_number: parent.number,
              sub_issue_id: child.id,
            });
          }
        }
      }

      return { parentNumber: parent.number, childNumbers };
    },

    async setFlowState(repository, issueNumber, state) {
      const { api, owner, repo } = await apiFor(repository);
      const response = await api.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
      });
      const issue = z.object({ labels: z.array(z.unknown()) }).parse(response.data);
      const labels = issue.labels
        .map(labelName)
        .filter((name): name is string => name !== null && !name.startsWith("flow:"));
      await api.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
        labels: [...labels, `flow:${state}`],
      });
    },

    async dispatchBuild(repository, issueNumber, rawRoute, ref, repairContext) {
      const route = WorkflowRouteSchema.parse(rawRoute);
      const { api, owner, repo } = await apiFor(repository);
      const targetRef = ref ?? z.object({ default_branch: z.string().min(1) }).parse((await api.request(
        "GET /repos/{owner}/{repo}", { owner, repo },
      )).data).default_branch;
      let expectedSha: string | undefined;
      try {
        expectedSha = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) }).parse((await api.request(
          "GET /repos/{owner}/{repo}/git/ref/heads/{ref}",
          { owner, repo, ref: `flow/${issueNumber}` },
        )).data).object.sha;
      } catch (error) {
        if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 404) throw error;
      }
      await api.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          owner,
          repo,
          workflow_id: "flow-build.yml",
          ref: targetRef,
          inputs: {
            issue_number: String(issueNumber),
            provider: route.provider,
            model: route.model,
            route_id: route.routeId,
            ...(repairContext ? { repair_context: repairContext.slice(0, 2_000) } : {}),
            ...(expectedSha ? { expected_sha: expectedSha } : {}),
          },
        },
      );
    },

    dispatchCi,
    dispatchAgentQuality,

    verifyTrustedWorkflow,
    verifyClarificationPublisher,

    async publishCheck(repository, check) {
      const { api, owner, repo } = await apiFor(repository);
      await api.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo,
        name: check.name,
        head_sha: check.headSha,
        status: "completed",
        conclusion: check.conclusion,
        details_url: check.detailsUrl,
        external_id: check.externalId,
        output: {
          title: check.conclusion === "success" ? `${check.name} passed` : `${check.name} failed`,
          summary: check.summary,
        },
      });
    },

    async openPullRequest(repository, issueNumber) {
      const { api, owner, repo } = await apiFor(repository);
      const repositoryResponse = await api.request("GET /repos/{owner}/{repo}", { owner, repo });
      const defaultBranch = z.object({ default_branch: z.string().min(1) }).parse(
        repositoryResponse.data,
      ).default_branch;
      const head = `flow/${issueNumber}`;
      const existingResponse = await api.request("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        state: "open",
        head: `${owner}:${head}`,
        base: defaultBranch,
      });
      const existing = z.array(z.object({ number: z.number().int().positive() })).parse(
        existingResponse.data,
      )[0];
      if (existing) return existing.number;
      const response = await api.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        head,
        base: defaultBranch,
        draft: true,
        title: `Flow #${issueNumber}`,
        body: `Closes #${issueNumber}\n\n## Automated evidence\n\n- The builder repository contract passed.\n- Independent review, CI, and QA run next.\n- Final merge requires human approval.`,
      });
      return z.object({ number: z.number().int().positive() }).parse(response.data).number;
    },

    async markPullRequestReady(repository, pullRequestNumber) {
      const { api, owner, repo } = await apiFor(repository);
      try {
        await api.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/ready_for_review", {
          owner,
          repo,
          pull_number: pullRequestNumber,
        });
      } catch (error) {
        if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 422) throw error;
      }
    },

    async closeIssue(repository, issueNumber) {
      const { api, owner, repo } = await apiFor(repository);
      await api.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
        state: "closed",
        state_reason: "completed",
      });
    },

    async canAnswerClarification(repository, login) {
      const { api, owner, repo } = await apiFor(repository);
      try {
        const permission = z.object({
          permission: z.enum(["admin", "maintain", "write", "triage", "read", "none"]),
        }).parse((await api.request(
          "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
          { owner, repo, username: login },
        )).data).permission;
        return permission === "admin" || permission === "maintain" || permission === "write";
      } catch (error) {
        if (responseStatus(error) === 404) return false;
        throw error;
      }
    },

    async getFlowState(repository, issueNumber) {
      const { api, owner, repo } = await apiFor(repository);
      const issue = z.object({ labels: z.array(z.unknown()) }).parse((await api.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo, issue_number: issueNumber },
      )).data);
      const states = new Set<string>(FLOW_STATES);
      const state = issue.labels
        .map(labelName)
        .find((name) => name?.startsWith("flow:") && states.has(name.slice("flow:".length)));
      return state ? state.slice("flow:".length) as FlowState : null;
    },

    async postClarificationAnswer(repository, issueNumber, answer, id) {
      const { api, owner, repo } = await apiFor(repository);
      const comments = z.array(z.object({ body: z.string().nullable() })).parse((await api.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: issueNumber, per_page: 100 },
      )).data);
      if (comments.some((comment) => {
        const parsed = comment.body ? parseClarificationAnswerComment(comment.body) : null;
        return parsed?.id === id;
      })) return;
      await api.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: issueNumber,
        body: formatClarificationAnswerComment({ version: 1, id, answer }),
      });
    },
  };
};

export type GitHubRouteDependencies = {
  storage: Pick<Storage, "recordWebhookJob">;
  webhookSecret: string;
};

export const registerGitHubRoutes = async (
  server: FastifyInstance,
  dependencies: GitHubRouteDependencies,
): Promise<void> => {
  await server.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  server.post(
    "/webhooks/github",
    { config: { rawBody: true } },
    async (request, reply) => {
      const raw = (request as typeof request & { rawBody?: string }).rawBody;
      const signatureHeader = request.headers["x-hub-signature-256"];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (!raw || !verifyGitHubSignature(raw, signature, dependencies.webhookSecret)) {
        return reply.code(401).send({ ok: false });
      }
      const deliveryHeader = request.headers["x-github-delivery"];
      const eventHeader = request.headers["x-github-event"];
      const delivery = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
      const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
      if (!delivery || !event) return reply.code(400).send({ ok: false });
      const hash = createHmac("sha256", dependencies.webhookSecret).update(raw).digest("hex");
      const payload = redactWebhookPayload(event, JSON.parse(raw) as unknown);
      if (!dependencies.storage.recordWebhookJob("github", delivery, hash, "github", `github:${delivery}`, {
        event,
        delivery,
        payload,
      })) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      return reply.code(200).send({ ok: true });
    },
  );
};
