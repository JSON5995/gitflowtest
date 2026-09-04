import { App } from "@octokit/app";
import { z } from "zod";
import type { GitHubApi } from "./github.js";

type Requester = {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
};

type AppLike = {
  octokit: Requester;
  getInstallationOctokit(installationId: number): Promise<Requester>;
};

type GitHubAppAccessOptions = {
  appId: number;
  privateKey: string;
  createApp?: () => AppLike;
};

export type GitHubAppAccess = {
  getAppSlug(): Promise<string>;
  getInstallationId(repository: string): Promise<number>;
  getApi(installationId: number): Promise<GitHubApi>;
};

const repositoryParts = (repository: string): { owner: string; repo: string } => {
  const match = repository.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner: match[1], repo: match[2] };
};

const createLiveApp = (appId: number, privateKey: string): AppLike => {
  const app = new App({ appId, privateKey });
  const wrap = (client: typeof app.octokit): Requester => ({
    async request(route, parameters) {
      const request = client.request as unknown as Requester["request"];
      const response = await request(route, parameters);
      return { data: response.data };
    },
  });
  return {
    octokit: wrap(app.octokit),
    async getInstallationOctokit(installationId) {
      return wrap(await app.getInstallationOctokit(installationId));
    },
  };
};

export const createGitHubAppAccess = (options: GitHubAppAccessOptions): GitHubAppAccess => {
  const app = options.createApp?.() ?? createLiveApp(options.appId, options.privateKey);
  return {
    async getAppSlug() {
      const response = await app.octokit.request("GET /app", {});
      return z.object({ slug: z.string().min(1) }).parse(response.data).slug;
    },

    async getInstallationId(repository) {
      const { owner, repo } = repositoryParts(repository);
      const response = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
        owner,
        repo,
      });
      return z.object({ id: z.number().int().positive() }).parse(response.data).id;
    },

    async getApi(installationId) {
      return app.getInstallationOctokit(installationId);
    },
  };
};
