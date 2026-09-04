import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubApi } from "./github.js";

const execFileAsync = promisify(execFile);

type GitHubCliExecutor = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string }>;

const executeGitHubCli: GitHubCliExecutor = async (args, cwd) => {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return { stdout };
};

type TokenApiOptions = { token: string; fetch?: typeof fetch };

export const readGitHubCliToken = async (): Promise<string> => {
  const { stdout } = await execFileAsync("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const token = stdout.trim();
  if (!token) throw new Error("GitHub CLI did not return an authentication token");
  return token;
};

export const readCurrentGitHubRepository = async (
  cwd: string,
  execute: GitHubCliExecutor = executeGitHubCli,
): Promise<string> => {
  let stdout: string;
  try {
    ({ stdout } = await execute(
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      cwd,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no git remotes? found/i.test(message)) {
      throw new Error([
        `No GitHub remote was found for ${cwd}.`,
        "git remote add origin https://github.com/OWNER/REPO.git",
        "flow-ai repo add OWNER/REPO",
        "If origin is your fork, add the source project separately:",
        "git remote add upstream https://github.com/ORIGINAL_OWNER/REPO.git",
      ].join("\n"));
    }
    throw error;
  }
  const repository = stdout.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("The current folder is not connected to a GitHub repository");
  }
  return repository;
};

export const createGitHubTokenApi = (options: TokenApiOptions): GitHubApi => ({
  async request(route, parameters) {
    const match = route.match(/^([A-Z]+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) throw new Error(`Invalid GitHub route: ${route}`);
    const method = match[1];
    const remaining = { ...parameters };
    const path = match[2].replace(/\{([^}]+)\}/g, (_placeholder, key: string) => {
      const value = remaining[key];
      if (value === undefined) throw new Error(`Missing GitHub route parameter: ${key}`);
      delete remaining[key];
      return encodeURIComponent(String(value));
    });
    const url = new URL(`https://api.github.com${path}`);
    let body: string | undefined;
    if (method === "GET" || method === "HEAD") {
      for (const [key, value] of Object.entries(remaining)) {
        if (["string", "number", "boolean"].includes(typeof value)) {
          url.searchParams.set(key, String(value));
        }
      }
    } else {
      body = JSON.stringify(remaining);
    }
    const response = await (options.fetch ?? fetch)(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "flow-ai-cli",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path} failed with ${response.status}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return { data: response.status === 204 ? undefined : await response.json() };
  },
});
