import { describe, expect, it } from "vitest";
import { createGitHubAppAccess } from "../src/github-app.js";

describe("GitHub App authentication", () => {
  it("resolves the repository installation and creates its API client", async () => {
    const calls: string[] = [];
    const installationApi = {
      request: async (route: string) => {
        calls.push(route);
        return { data: { ok: true } };
      },
    };
    const access = createGitHubAppAccess({
      appId: 42,
      privateKey: "private-key",
      createApp: () => ({
        octokit: {
          request: async (route: string, parameters: Record<string, unknown>) => {
            if (route === "GET /app") {
              calls.push(route);
              return { data: { slug: "flow-ai" } };
            }
            calls.push(`${route}:${parameters.owner}/${parameters.repo}`);
            return { data: { id: 99 } };
          },
        },
        getInstallationOctokit: async (installationId: number) => {
          calls.push(`installation:${installationId}`);
          return installationApi;
        },
      }),
    });

    expect(await access.getAppSlug()).toBe("flow-ai");
    expect(await access.getInstallationId("acme/store")).toBe(99);
    const api = await access.getApi(99);
    await api.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "store" });

    expect(calls).toEqual([
      "GET /app",
      "GET /repos/{owner}/{repo}/installation:acme/store",
      "installation:99",
      "GET /repos/{owner}/{repo}",
    ]);
  });

  it("rejects malformed repository names before making a request", async () => {
    const access = createGitHubAppAccess({ appId: 42, privateKey: "private-key" });

    await expect(access.getInstallationId("not-a-repository")).rejects.toThrow("Invalid GitHub repository");
  });
});
