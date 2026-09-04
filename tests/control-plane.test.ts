import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createControlPlane,
  createProviderModelDiscovery,
  createProviderCredentialVerifier,
  createRepositoryCredentialSync,
  createRepositoryProvisioner,
  type ProviderCredentialVerifier,
} from "../src/control-plane.js";
import { createCredentialVault } from "../src/credential-vault.js";
import { openStorage, type Storage } from "../src/storage.js";

const storages: Storage[] = [];

afterEach(() => storages.splice(0).forEach((storage) => storage.close()));

describe("control plane", () => {
  it("discovers compatible provider models with friendly names and caches the latest success", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openai.com")) {
        return new Response(JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-5.3-codex", object: "model", created: 1, owned_by: "openai" },
            { id: "text-embedding-3-large", object: "model", created: 1, owned_by: "openai" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: [{
          type: "model",
          id: "claude-sonnet-4-5-20250929",
          display_name: "Claude Sonnet 4.5",
          created_at: "2025-09-29T00:00:00Z",
        }],
        has_more: false,
        first_id: "claude-sonnet-4-5-20250929",
        last_id: "claude-sonnet-4-5-20250929",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const controlPlane = createControlPlane({
      storage,
      vault: createCredentialVault(randomBytes(32)),
      verifyCredential: async () => undefined,
      discoverModels: createProviderModelDiscovery(fetcher as typeof fetch),
    });
    controlPlane.seedProviderCredential("codex", "openai-key");
    controlPlane.seedProviderCredential("claude", "anthropic-key");

    await controlPlane.refreshProviderModels("codex", new Date("2026-09-04T12:00:00.000Z"));
    await controlPlane.refreshProviderModels("claude", new Date("2026-09-04T12:01:00.000Z"));

    expect(controlPlane.getSnapshot().modelCatalogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "codex",
        refreshedAt: "2026-09-04T12:00:00.000Z",
        lastError: null,
        models: [{
          id: "gpt-5.3-codex",
          name: "GPT 5.3 Codex",
          roles: ["build", "review", "qa"],
        }],
      }),
      expect.objectContaining({
        provider: "claude",
        models: [{
          id: "claude-sonnet-4-5-20250929",
          name: "Claude Sonnet 4.5",
          roles: ["build", "review", "qa"],
        }],
      }),
    ]));
    expect(JSON.stringify(controlPlane.getSnapshot())).not.toContain("openai-key");
    expect(JSON.stringify(controlPlane.getSnapshot())).not.toContain("anthropic-key");
  });

  it("retains cached models and records a sanitized discovery failure", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    let fails = false;
    const controlPlane = createControlPlane({
      storage,
      vault: createCredentialVault(randomBytes(32)),
      verifyCredential: async () => undefined,
      discoverModels: async () => {
        if (fails) throw new Error("OpenAI rejected this credential (401). Replace the key and refresh models.");
        return [{ id: "gpt-5", name: "GPT 5", roles: ["build", "review", "qa"] }];
      },
    });
    controlPlane.seedProviderCredential("codex", "sk-never-persist-in-errors");
    await controlPlane.refreshProviderModels("codex", new Date("2026-09-04T12:00:00.000Z"));
    fails = true;

    await expect(controlPlane.refreshProviderModels("codex", new Date("2026-09-04T12:02:00.000Z")))
      .rejects.toThrow("Replace the key");

    const catalog = controlPlane.getSnapshot().modelCatalogs.find((item) => item.provider === "codex");
    expect(catalog).toMatchObject({
      models: [{ id: "gpt-5", name: "GPT 5", roles: ["build", "review", "qa"] }],
      refreshedAt: "2026-09-04T12:00:00.000Z",
      lastError: "OpenAI rejected this credential (401). Replace the key and refresh models.",
      lastErrorAt: "2026-09-04T12:02:00.000Z",
    });
    expect(JSON.stringify(catalog)).not.toContain("sk-never-persist-in-errors");
  });

  it("verifies and stores provider credentials without returning their value", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const seen: string[] = [];
    const verifier: ProviderCredentialVerifier = async (_provider, credential) => { seen.push(credential); };
    const controlPlane = createControlPlane({
      storage,
      vault: createCredentialVault(randomBytes(32)),
      verifyCredential: verifier,
    });

    await controlPlane.saveProviderCredential("codex", "sk-openai-live-value", new Date("2026-09-04T12:00:00.000Z"));

    expect(seen).toEqual(["sk-openai-live-value"]);
    expect(controlPlane.getProviderCredentialValue("codex")).toBe("sk-openai-live-value");
    const snapshot = controlPlane.getSnapshot();
    expect(snapshot.providers).toContainEqual({
      provider: "codex",
      configured: true,
      verification: "verified",
      verifiedAt: "2026-09-04T12:00:00.000Z",
    });
    expect(JSON.stringify(snapshot)).not.toContain("sk-openai-live-value");
    expect(storage.getProviderCredential("codex")?.sealed).not.toContain("sk-openai-live-value");
  });

  it("does not replace a working credential when verification fails", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const vault = createCredentialVault(randomBytes(32));
    let reject = false;
    const controlPlane = createControlPlane({
      storage,
      vault,
      verifyCredential: async () => {
        if (reject) throw new Error("Provider rejected this credential");
      },
    });
    await controlPlane.saveProviderCredential("claude", "working-key");
    reject = true;

    await expect(controlPlane.saveProviderCredential("claude", "bad-key-x")).rejects.toThrow(/rejected/);

    expect(controlPlane.getProviderCredentialValue("claude")).toBe("working-key");
  });

  it("only enables routing candidates backed by a connected provider", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const controlPlane = createControlPlane({
      storage,
      vault: createCredentialVault(randomBytes(32)),
      verifyCredential: async () => undefined,
    });
    const settings = {
      candidates: [{
        id: "claude-frontier",
        provider: "claude" as const,
        model: "claude-example",
        tier: "frontier" as const,
        enabled: true,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      }],
      policy: {
        maxTransientRetriesPerCandidate: 1,
        baseBackoffMs: 1_000,
        maxBackoffMs: 30_000,
        jitterRatio: 0.15,
        reservationTtlMs: 3_600_000,
        limits: {
          perJobTokens: 100_000,
          perJobCostMicros: 25_000_000,
          monthlyTokens: 2_000_000,
          monthlyCostMicros: 500_000_000,
        },
      },
    };

    expect(() => controlPlane.saveRoutingSettings(settings)).toThrow(/connected provider/);
    await controlPlane.saveProviderCredential("claude", "anthropic-working-key");
    controlPlane.saveRoutingSettings(settings);

    expect(controlPlane.getSnapshot().routing).toEqual(settings);
  });

  it("verifies OpenAI and Anthropic keys against their model endpoints", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}", { status: 200 });
    });
    const verify = createProviderCredentialVerifier(fetcher as typeof fetch);

    await verify("codex", "openai-key");
    await verify("claude", "anthropic-key");

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer openai-key");
    expect(calls[1]?.url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(calls[1]?.headers.get("x-api-key")).toBe("anthropic-key");
    expect(calls[1]?.headers.get("anthropic-version")).toBeTruthy();
  });

  it("records Cursor as configured because browser login cannot authenticate an ephemeral runner", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const controlPlane = createControlPlane({
      storage,
      vault: createCredentialVault(randomBytes(32)),
      verifyCredential: createProviderCredentialVerifier(async () => {
        throw new Error("Cursor verification must not make a guessed API request");
      }),
    });

    await controlPlane.saveProviderCredential("cursor", "cursor-machine-key");

    expect(controlPlane.getSnapshot().providers).toContainEqual({
      provider: "cursor",
      configured: true,
      verification: "configured",
      verifiedAt: null,
    });
  });

  it("provisions an installed repository with stored provider secrets and persists it", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const vault = createCredentialVault(randomBytes(32));
    const calls: unknown[] = [];
    const holder: { current?: ReturnType<typeof createControlPlane> } = {};
    const provision = createRepositoryProvisioner({
      storage,
      appAccess: {
        getInstallationId: async (repository) => repository === "acme/store" ? 42 : 0,
        getApi: async () => ({ request: async () => ({ data: {} }) }),
        getAppSlug: async () => "company-flow",
      },
      getCredential: (provider) => holder.current?.getProviderCredentialValue(provider) ?? null,
      loadFiles: async () => ({ ".github/workflows/flow-build.yml": "name: Flow Build\n" }),
      runProvision: async (options) => {
        calls.push(options);
        return {
          defaultBranch: "main",
          commitSha: "abc",
          setupPullRequestUrl: "https://github.com/acme/store/pull/7",
          mergeGateInstalled: false,
        };
      },
      checkIntegrationId: 99,
    });
    const controlPlane = createControlPlane({
      storage,
      vault,
      verifyCredential: async () => undefined,
      provisionRepository: provision,
    });
    holder.current = controlPlane;
    await controlPlane.saveProviderCredential("codex", "openai-key");
    await controlPlane.saveProviderCredential("claude", "anthropic-key");

    const result = await controlPlane.provisionRepository({
      repository: "acme/store",
      codeowners: ["@acme/platform"],
    });

    expect(result).toMatchObject({ repository: "acme/store", mergeGateInstalled: false, status: "pending" });
    expect(calls).toEqual([expect.objectContaining({
      repository: "acme/store",
      secrets: {},
      variables: {},
      activationAuthorized: false,
      codeowners: ["@acme/platform"],
      checkIntegrationId: 99,
    })]);
    expect(storage.getManagedRepository("acme/store")).toMatchObject({
      installationId: 42,
      setupPullRequestUrl: "https://github.com/acme/store/pull/7",
      mergeGateInstalled: false,
      status: "pending",
    });
  });

  it("activates a pending repository only after its merged setup kit exactly matches the default branch", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const files = {
      ".cursor/rules/flow.mdc": "trusted cursor rules\n",
      ".flow/AI_RULES.md": "trusted rules\n",
      ".flow/config.json": "{}\n",
      ".flow/qa.json": "{}\n",
      ".flow/review-schema.json": "{}\n",
      ".github/CODEOWNERS": "# BEGIN Flow AI required human reviewers\n* @acme/platform\n# END Flow AI required human reviewers\n",
      ".github/workflows/flow-build.yml": "trusted build\n",
      ".github/workflows/flow-ci.yml": "trusted ci\n",
      ".github/workflows/flow-qa.yml": "trusted qa\n",
      ".github/workflows/flow-review.yml": "trusted review\n",
      "scripts/check-review.mjs": "trusted check\n",
      "scripts/clarification.mjs": "trusted clarification\n",
      "scripts/parse-cursor-result.mjs": "trusted cursor parser\n",
      "scripts/run-contract.mjs": "trusted contract\n",
      "scripts/run-real-qa.mjs": "trusted real qa\n",
    };
    storage.saveManagedRepository({
      repository: "acme/store",
      installationId: 42,
      codeowners: ["@acme/platform"],
      setupPullRequestUrl: "https://github.com/acme/store/pull/7",
      mergeGateInstalled: false,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    const calls: unknown[] = [];
    let mergedAt: string | null = null;
    const provision = createRepositoryProvisioner({
      storage,
      appAccess: {
        getInstallationId: async () => 42,
        getApi: async () => ({
          request: async (route, parameters) => {
            if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
              expect(parameters).toEqual({ owner: "acme", repo: "store", pull_number: 7 });
              return { data: { merged_at: mergedAt } };
            }
            if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
            if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
              const content = files[String(parameters.path) as keyof typeof files];
              if (!content) throw Object.assign(new Error("not found"), { status: 404 });
              return { data: { type: "file", content: Buffer.from(content).toString("base64") } };
            }
            throw new Error(`Unexpected route: ${route}`);
          },
        }),
        getAppSlug: async () => "company-flow",
      },
      getCredential: (provider) => provider === "codex" ? "openai-key" : null,
      loadFiles: async () => files,
      runProvision: async (options) => {
        calls.push(options);
        return {
          defaultBranch: "main",
          commitSha: "merged-commit",
          mergeGateInstalled: options.activationAuthorized === true,
        };
      },
      checkIntegrationId: 99,
    });

    const stillPending = await provision({ repository: "acme/store", codeowners: ["@acme/platform"] });

    expect(calls[0]).toEqual(expect.objectContaining({
      activationAuthorized: false,
      secrets: {},
      variables: {},
    }));
    expect(stillPending).toMatchObject({
      status: "pending",
      mergeGateInstalled: false,
      setupPullRequestUrl: "https://github.com/acme/store/pull/7",
    });
    expect(storage.getManagedRepository("acme/store")?.setupPullRequestUrl)
      .toBe("https://github.com/acme/store/pull/7");

    mergedAt = "2026-09-04T12:30:00.000Z";
    const result = await provision({ repository: "acme/store", codeowners: ["@acme/platform"] });

    expect(calls[1]).toEqual(expect.objectContaining({
      activationAuthorized: true,
      secrets: { OPENAI_API_KEY: "openai-key" },
      variables: { FLOW_BOT_LOGIN: "company-flow[bot]" },
    }));
    expect(result).toMatchObject({ status: "active", mergeGateInstalled: true, setupPullRequestUrl: null });
    expect(storage.getManagedRepository("acme/store")).toMatchObject({ status: "active", mergeGateInstalled: true });
  });

  it("keeps a merged setup pending and requests a fresh setup PR when the default-branch kit differs", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.saveManagedRepository({
      repository: "acme/store",
      installationId: 42,
      codeowners: ["@acme/platform"],
      setupPullRequestUrl: "https://github.com/acme/store/pull/7",
      mergeGateInstalled: false,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    const files = {
      ".cursor/rules/flow.mdc": "trusted cursor rules\n",
      ".flow/AI_RULES.md": "trusted rules\n",
      ".flow/config.json": "{}\n",
      ".flow/qa.json": "{}\n",
      ".flow/review-schema.json": "{}\n",
      ".github/CODEOWNERS": "# BEGIN Flow AI required human reviewers\n* @acme/platform\n# END Flow AI required human reviewers\n",
      ".github/workflows/flow-build.yml": "trusted build\n",
      ".github/workflows/flow-ci.yml": "trusted ci\n",
      ".github/workflows/flow-qa.yml": "trusted qa\n",
      ".github/workflows/flow-review.yml": "trusted review\n",
      "scripts/check-review.mjs": "trusted check\n",
      "scripts/clarification.mjs": "trusted clarification\n",
      "scripts/parse-cursor-result.mjs": "trusted cursor parser\n",
      "scripts/run-contract.mjs": "trusted contract\n",
      "scripts/run-real-qa.mjs": "trusted real qa\n",
    };
    const provisionCalls: unknown[] = [];
    const provision = createRepositoryProvisioner({
      storage,
      appAccess: {
        getInstallationId: async () => 42,
        getApi: async () => ({
          request: async (route, parameters) => {
            if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
              return { data: { merged_at: "2026-09-04T12:30:00.000Z" } };
            }
            if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
            if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
              const path = String(parameters.path);
              const content = files[path as keyof typeof files];
              if (!content) throw Object.assign(new Error("not found"), { status: 404 });
              const installed = path === ".cursor/rules/flow.mdc" ? "tampered cursor rules\n" : content;
              return { data: { type: "file", content: Buffer.from(installed).toString("base64") } };
            }
            throw new Error(`Unexpected route: ${route}`);
          },
        }),
        getAppSlug: async () => "company-flow",
      },
      getCredential: (provider) => provider === "codex" ? "openai-key" : null,
      loadFiles: async () => files,
      runProvision: async (options) => {
        provisionCalls.push(options);
        return {
          defaultBranch: "main",
          commitSha: "replacement-commit",
          setupPullRequestUrl: "https://github.com/acme/store/pull/8",
          mergeGateInstalled: false,
        };
      },
      checkIntegrationId: 99,
    });

    const result = await provision({ repository: "acme/store", codeowners: ["@acme/platform"] });

    expect(provisionCalls).toEqual([expect.objectContaining({
      activationAuthorized: false,
      secrets: {},
      variables: {},
    })]);
    expect(result).toMatchObject({
      status: "pending",
      mergeGateInstalled: false,
      setupPullRequestUrl: "https://github.com/acme/store/pull/8",
    });
  });

  it("safely adopts an exact legacy CLI installation that has no stored setup PR", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const files = {
      ".cursor/rules/flow.mdc": "trusted cursor rules\n",
      ".flow/AI_RULES.md": "trusted rules\n",
      ".flow/config.json": "{}\n",
      ".flow/qa.json": "{}\n",
      ".flow/review-schema.json": "{}\n",
      ".github/CODEOWNERS": "# BEGIN Flow AI required human reviewers\n* @acme/platform\n# END Flow AI required human reviewers\n",
      ".github/workflows/flow-build.yml": "trusted build\n",
      ".github/workflows/flow-ci.yml": "trusted ci\n",
      ".github/workflows/flow-qa.yml": "trusted qa\n",
      ".github/workflows/flow-review.yml": "trusted review\n",
      "scripts/check-review.mjs": "trusted check\n",
      "scripts/clarification.mjs": "trusted clarification\n",
      "scripts/parse-cursor-result.mjs": "trusted cursor parser\n",
      "scripts/run-contract.mjs": "trusted contract\n",
      "scripts/run-real-qa.mjs": "trusted real qa\n",
    };
    const provisionCalls: unknown[] = [];
    const provision = createRepositoryProvisioner({
      storage,
      appAccess: {
        getInstallationId: async () => 42,
        getApi: async () => ({
          request: async (route, parameters) => {
            if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
            if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
              const content = files[String(parameters.path) as keyof typeof files];
              if (!content) throw Object.assign(new Error("not found"), { status: 404 });
              return { data: { type: "file", content: Buffer.from(content).toString("base64") } };
            }
            throw new Error(`Unexpected route: ${route}`);
          },
        }),
        getAppSlug: async () => "company-flow",
      },
      getCredential: (provider) => provider === "codex" ? "openai-key" : null,
      loadFiles: async () => files,
      runProvision: async (options) => {
        provisionCalls.push(options);
        return { defaultBranch: "main", commitSha: "legacy-commit", mergeGateInstalled: true };
      },
      checkIntegrationId: 99,
    });

    const result = await provision({ repository: "acme/store", codeowners: ["@acme/platform"] });

    expect(provisionCalls[0]).toEqual(expect.objectContaining({
      activationAuthorized: true,
      secrets: { OPENAI_API_KEY: "openai-key" },
    }));
    expect(result).toMatchObject({ status: "active", mergeGateInstalled: true });
  });

  it("updates provider secrets only in active managed repositories", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    for (const [repository, installationId] of [["acme/web", 41], ["acme/api", 42]] as const) {
      storage.saveManagedRepository({
        repository,
        installationId,
        codeowners: ["@acme/platform"],
        setupPullRequestUrl: null,
        mergeGateInstalled: true,
        updatedAt: "2026-09-04T12:00:00.000Z",
      });
    }
    storage.saveManagedRepository({
      repository: "acme/pending",
      installationId: 43,
      codeowners: ["@acme/platform"],
      setupPullRequestUrl: "https://github.com/acme/pending/pull/7",
      mergeGateInstalled: false,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    const updates: Array<{ repository: string; name: string; value: string; installationId: number }> = [];
    const sync = createRepositoryCredentialSync({
      storage,
      appAccess: { getApi: async (installationId) => ({ request: async () => ({ data: installationId }) }) },
      setSecret: async ({ repository, api, name, value }) => {
        const installation = await api.request("TEST", {});
        updates.push({ repository, name, value, installationId: installation.data as number });
      },
    });
    const controlPlane = createControlPlane({
      storage,
      vault: createCredentialVault(randomBytes(32)),
      verifyCredential: async () => undefined,
      syncProviderCredential: sync,
    });

    await controlPlane.saveProviderCredential("claude", "new-anthropic-key");

    expect(updates).toEqual([
      { repository: "acme/api", name: "ANTHROPIC_API_KEY", value: "new-anthropic-key", installationId: 42 },
      { repository: "acme/web", name: "ANTHROPIC_API_KEY", value: "new-anthropic-key", installationId: 41 },
    ]);
  });
});
