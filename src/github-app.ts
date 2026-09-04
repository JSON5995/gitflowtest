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
  getInstallation(installationId: number): Promise<GitHubInstallation>;
  listInstallations(): Promise<GitHubInstallation[]>;
  listInstallationRepositories(installationId: number): Promise<GitHubInstallationRepository[]>;
};

export type GitHubInstallation = {
  id: number;
  account: { login: string; type: string };
  htmlUrl: string;
  permissions: Record<string, string>;
};

export type GitHubInstallationRepository = {
  fullName: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
};

const InstallationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ login: z.string().min(1), type: z.string().min(1) }),
  html_url: z.string().url(),
  permissions: z.record(z.string(), z.string()),
});

const mapInstallation = (input: unknown): GitHubInstallation => {
  const installation = InstallationSchema.parse(input);
  return {
    id: installation.id,
    account: installation.account,
    htmlUrl: installation.html_url,
    permissions: installation.permissions,
  };
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

    async getInstallation(installationId) {
      const response = await app.octokit.request("GET /app/installations/{installation_id}", {
        installation_id: installationId,
      });
      return mapInstallation(response.data);
    },

    async listInstallations() {
      const installations: GitHubInstallation[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const response = await app.octokit.request("GET /app/installations", { per_page: 100, page });
        const batch = z.array(InstallationSchema).parse(response.data);
        installations.push(...batch.map(mapInstallation));
        if (batch.length < 100) break;
      }
      return installations;
    },

    async listInstallationRepositories(installationId) {
      const api = await app.getInstallationOctokit(installationId);
      const repositories: GitHubInstallationRepository[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const response = await api.request("GET /installation/repositories", { per_page: 100, page });
        const batch = z.object({
          repositories: z.array(z.object({
            full_name: z.string().min(3),
            private: z.boolean(),
            archived: z.boolean().default(false),
            disabled: z.boolean().default(false),
          })),
        }).parse(response.data).repositories;
        repositories.push(...batch.map((repository) => ({
          fullName: repository.full_name,
          private: repository.private,
          archived: repository.archived,
          disabled: repository.disabled,
        })));
        if (batch.length < 100) break;
      }
      return repositories;
    },
  };
};
