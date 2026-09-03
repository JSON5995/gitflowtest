import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { FlowState, WorkPlan } from "./domain.js";
import { formatIssueBody } from "./intake.js";
import type { Storage } from "./storage.js";

export type GitHubApi = {
  request(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};

type GitHubGatewayOptions = {
  webhookSecret: string;
  getInstallationId(repository: string): Promise<number>;
  getApi(installationId: number): Promise<GitHubApi>;
};

export type PlannedIssueResult = {
  parentNumber: number;
  childNumbers: number[];
};

export type GitHubGateway = {
  verifyWebhook(payload: string, signature: string | undefined): boolean;
  hasRepositoryAccess(repository: string): Promise<{ installationId: number }>;
  createPlannedIssue(
    repository: string,
    plan: WorkPlan,
    source: Parameters<typeof formatIssueBody>[1],
  ): Promise<PlannedIssueResult>;
  setFlowState(repository: string, issueNumber: number, state: FlowState): Promise<void>;
  dispatchBuild(repository: string, issueNumber: number, ref?: string): Promise<void>;
};

const splitRepository = (repository: string): { owner: string; repo: string } => {
  const match = repository.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner: match[1], repo: match[2] };
};

const IssueResponseSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  html_url: z.string().url(),
});

const labelName = (label: unknown): string | null => {
  if (typeof label === "string") return label;
  const parsed = z.object({ name: z.string().nullable() }).safeParse(label);
  return parsed.success ? parsed.data.name : null;
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
      const initialState: FlowState = plan.needsHumanInput
        ? "blocked"
        : plan.units.length === 1
          ? "ready"
          : "inbox";
      const unitBody = plan.units.length === 1 ? `\n\n## Work unit\n\n${plan.units[0]!.body}` : "";
      const parentResponse = await api.request("POST /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        title: plan.title,
        body: `${formatIssueBody(plan, source)}${unitBody}`,
        labels: [`flow:${initialState}`],
      });
      const parent = IssueResponseSchema.parse(parentResponse.data);
      const childNumbers: number[] = [];

      if (!plan.needsHumanInput && plan.units.length > 1) {
        for (const unit of plan.units) {
          const childResponse = await api.request("POST /repos/{owner}/{repo}/issues", {
            owner,
            repo,
            title: unit.title,
            body: `${unit.body}\n\nParent: #${parent.number}`,
            labels: ["flow:ready"],
          });
          const child = IssueResponseSchema.parse(childResponse.data);
          childNumbers.push(child.number);
          await api.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
            owner,
            repo,
            issue_number: parent.number,
            sub_issue_id: child.id,
          });
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

    async dispatchBuild(repository, issueNumber, ref = "main") {
      const { api, owner, repo } = await apiFor(repository);
      await api.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          owner,
          repo,
          workflow_id: "flow-build.yml",
          ref,
          inputs: { issue_number: String(issueNumber) },
        },
      );
    },
  };
};

export type GitHubRouteDependencies = {
  storage: Pick<Storage, "recordWebhook" | "enqueueJob">;
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
      if (!dependencies.storage.recordWebhook("github", delivery, hash)) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      dependencies.storage.enqueueJob("github", `github:${delivery}`, {
        event,
        delivery,
        payload: JSON.parse(raw) as unknown,
      });
      return reply.code(200).send({ ok: true });
    },
  );
};
