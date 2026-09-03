import { createHash } from "node:crypto";
import { z } from "zod";

type CursorGatewayOptions = {
  apiKey: string;
  fetch?: typeof fetch;
};

export type CursorBuildRequest = {
  repository: string;
  issueNumber: number;
  prompt: string;
  startingRef: string;
  idempotencyKey: string;
};

export type CursorBuildResult = {
  agentId: string;
  runId: string;
  url: string;
};

export type CursorGateway = {
  startBuild(request: CursorBuildRequest): Promise<CursorBuildResult>;
  requestFix(agentId: string, prompt: string): Promise<{ runId: string }>;
};

const deterministicAgentId = (key: string): string => {
  const characters = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  characters[12] = "5";
  characters[16] = ((Number.parseInt(characters[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = characters.join("");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const CreateResponseSchema = z.object({
  agent: z.object({ id: z.string(), url: z.string().url() }),
  run: z.object({ id: z.string(), status: z.string() }),
});

const RunResponseSchema = z.object({ id: z.string() });

export const createCursorGateway = (options: CursorGatewayOptions): CursorGateway => {
  const request = options.fetch ?? fetch;
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const response = await request(`https://api.cursor.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Cursor request failed with ${response.status}`);
    return response.json();
  };

  return {
    async startBuild(build) {
      const response = CreateResponseSchema.parse(await call("/v1/agents", {
        agentId: deterministicAgentId(build.idempotencyKey),
        name: `GitHub #${build.issueNumber}`,
        prompt: { text: build.prompt },
        repos: [{ url: `https://github.com/${build.repository}`, startingRef: build.startingRef }],
        mode: "agent",
        workOnCurrentBranch: false,
        autoCreatePR: true,
      }));
      return { agentId: response.agent.id, runId: response.run.id, url: response.agent.url };
    },

    async requestFix(agentId, prompt) {
      const response = RunResponseSchema.parse(await call(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
        prompt: { text: prompt },
        mode: "agent",
      }));
      return { runId: response.id };
    },
  };
};
