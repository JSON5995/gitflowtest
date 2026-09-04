import { describe, expect, it } from "vitest";
import { createGitHubTokenApi, readCurrentGitHubRepository } from "../src/github-token.js";

describe("GitHub CLI provisioning API", () => {
  it("detects the GitHub repository for the current project folder", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const repository = await readCurrentGitHubRepository("/projects/store", async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: "acme/store\n" };
    });

    expect(repository).toBe("acme/store");
    expect(calls).toEqual([{
      args: ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      cwd: "/projects/store",
    }]);
  });

  it("explains how to connect a folder with no GitHub remote", async () => {
    await expect(readCurrentGitHubRepository("/projects/store", async () => {
      throw new Error("no git remotes found");
    })).rejects.toThrow([
      "No GitHub remote was found for /projects/store.",
      "git remote add origin https://github.com/OWNER/REPO.git",
      "flow-ai repo add OWNER/REPO",
    ].join("\n"));
  });

  it("uses the CLI token as a bearer credential and expands REST routes safely", async () => {
    let url = "";
    let authorization = "";
    const api = createGitHubTokenApi({
      token: "secret-token",
      fetch: async (input, init) => {
        url = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await api.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "store" });

    expect(url).toBe("https://api.github.com/repos/acme/store");
    expect(authorization).toBe("Bearer secret-token");
    expect(response.data).toEqual({ default_branch: "main" });
  });
});
