import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import type { ControlPlaneSnapshot } from "../src/control-plane.js";
import type { AdminSummary } from "../src/storage.js";

const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const summary: AdminSummary = {
  generatedAt: "2026-09-04T10:30:00.000Z",
  storageReady: true,
  repositories: [
    { repository: "acme/store", context: "Telegram …4321 / topic …8999", boundAt: "2026-09-04T09:00:00.000Z" },
  ],
  jobStates: { pending: 2, running: 1, complete: 8, failed: 1 },
  workStates: { inbox: 0, ready: 1, working: 2, blocked: 0, human: 1, done: 5 },
  recentWork: [
    {
      repository: "acme/store",
      state: "human",
      issueNumber: 17,
      issueUrl: "https://github.com/acme/store/issues/17",
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/acme/store/pull/12",
      fixRounds: 1,
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
  ],
  recentFailures: [
    { source: "job", kind: "build", attempts: 3, failedAt: "2026-09-04T09:45:00.000Z" },
  ],
  awaitingApproval: [
    {
      repository: "acme/store",
      issueNumber: 17,
      issueUrl: "https://github.com/acme/store/issues/17",
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/acme/store/pull/12",
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
  ],
};

const createServer = (overrides: Record<string, unknown> = {}) => {
  const server = buildServer({
    isReady: () => true,
    admin: {
      username: "operator",
      password: "a-strong-test-password",
      getSummary: () => ({ ...summary, ...overrides }),
    },
  } as never);
  servers.push(server);
  return server;
};

const setupControlPlane = () => ({
  getSnapshot: (): ControlPlaneSnapshot => ({
    providers: (["codex", "claude", "cursor"] as const).map((provider) => ({
      provider,
      configured: false,
      verification: "missing" as const,
      verifiedAt: null,
    })),
    routing: null,
    routingSummary: {
      month: "2026-09",
      reservedTokens: 0,
      settledTokens: 0,
      reservedCostMicros: 0,
      settledCostMicros: 0,
      recentEvents: [],
    },
    modelCatalogs: [
      {
        provider: "codex" as const,
        supportsDiscovery: true,
        models: [
          { id: "gpt-5.3-codex", name: "GPT 5.3 Codex", roles: ["build", "review", "qa"] as const },
          { id: "gpt-5-mini", name: "GPT 5 Mini", roles: ["build", "review"] as const },
        ],
        refreshedAt: "2026-09-04T10:00:00.000Z",
        lastError: null,
        lastErrorAt: null,
      },
      {
        provider: "claude" as const,
        supportsDiscovery: true,
        models: [],
        refreshedAt: null,
        lastError: "Anthropic rejected this credential (401). Replace the key and refresh models.",
        lastErrorAt: "2026-09-04T10:01:00.000Z",
      },
      {
        provider: "cursor" as const,
        supportsDiscovery: false,
        models: [],
        refreshedAt: null,
        lastError: null,
        lastErrorAt: null,
      },
    ],
    repositories: [],
  }),
  saveProviderCredential: vi.fn(async () => undefined),
  saveRoutingSettings: vi.fn(() => undefined),
  refreshProviderModels: vi.fn(async () => undefined),
  provisionRepository: vi.fn(async () => ({
    repository: "acme/store",
    setupPullRequestUrl: "https://github.com/acme/store/pull/7",
    mergeGateInstalled: false,
    status: "pending" as const,
  })),
});

const csrfFrom = (html: string): string => {
  const token = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  if (!token) throw new Error("Missing CSRF token");
  return token;
};

const authorization = `Basic ${Buffer.from("operator:a-strong-test-password").toString("base64")}`;

describe("admin console", () => {
  it("challenges unauthenticated page, asset, and API requests", async () => {
    const server = createServer();

    for (const url of ["/admin", "/admin/styles.css", "/api/admin/summary"]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toMatch(/^Basic /);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("rejects an incorrect password and accepts configured credentials", async () => {
    const server = createServer();
    const rejected = await server.inject({
      method: "GET",
      url: "/api/admin/summary",
      headers: { authorization: `Basic ${Buffer.from("operator:wrong-password").toString("base64")}` },
    });
    const accepted = await server.inject({
      method: "GET",
      url: "/api/admin/summary",
      headers: { authorization },
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(summary);
  });

  it("serves a script-free operator view with restrictive browser headers", async () => {
    const server = createServer();

    const response = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).not.toContain("'unsafe-inline'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.body).toContain("Flow operations");
    expect(response.body).toContain("Awaiting approval");
    expect(response.body).toContain("https://github.com/acme/store/pull/12");
    expect(response.body).not.toContain("<script");
  });

  it("escapes database-backed labels before rendering HTML", async () => {
    const server = createServer({
      repositories: [
        { repository: 'acme/<img src=x onerror="alert(1)">', context: "Telegram …4321", boundAt: "2026-09-04T09:00:00.000Z" },
      ],
      recentWork: [
        { ...summary.recentWork[0], state: 'human" onclick="alert(2)' },
      ],
    });

    const response = await server.inject({ method: "GET", url: "/admin", headers: { authorization } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(response.body).not.toContain('<img src=x onerror="alert(1)">');
    expect(response.body).not.toContain('class="state state-human" onclick="alert(2)"');
  });

  it("renders a script-free setup page without exposing provider credentials", async () => {
    const controlPlane = setupControlPlane();
    const snapshot = controlPlane.getSnapshot();
    controlPlane.getSnapshot = () => ({
      ...snapshot,
      providers: snapshot.providers.map((provider) => provider.provider === "codex"
        ? { ...provider, configured: true, verification: "configured" as const }
        : provider),
    });
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Connect providers");
    expect(response.body).toContain("Models and budgets");
    expect(response.body).toContain("Not configured");
    expect(response.body).toContain("Work is paused until you choose models and save these routing settings.");
    expect(response.body).toContain('action="/admin/routing"');
    expect(response.body).toContain('list="codex-build-models"');
    expect(response.body).toContain('list="codex-review-models"');
    expect(response.body).toContain('list="codex-qa-models"');
    expect(response.body).toContain('value="gpt-5.3-codex"');
    expect(response.body).toContain('GPT 5.3 Codex — gpt-5.3-codex');
    const qaModels = response.body.match(/<datalist id="codex-qa-models">(.*?)<\/datalist>/s)?.[1];
    expect(qaModels).toContain('value="gpt-5.3-codex"');
    expect(qaModels).not.toContain('value="gpt-5-mini"');
    expect(response.body).toContain("Anthropic rejected this credential (401)");
    expect(response.body).toContain("Cursor does not publish a model-list API");
    expect(response.body).toContain('action="/admin/providers/codex/models"');
    expect(response.body).toContain('type="password"');
    expect(response.body).not.toContain("sk-");
    expect(response.body).not.toContain("<script");
    expect(response.headers["content-security-policy"]).toContain("form-action 'self'");
  });

  it("shows pending repositories with the exact activation action", async () => {
    const controlPlane = setupControlPlane();
    controlPlane.getSnapshot = () => ({
      ...setupControlPlane().getSnapshot(),
      repositories: [{
        repository: "acme/store",
        installationId: 42,
        codeowners: ["@acme/platform"],
        setupPullRequestUrl: "https://github.com/acme/store/pull/7",
        mergeGateInstalled: false,
        status: "pending" as const,
        updatedAt: "2026-09-04T12:00:00.000Z",
      }],
    });
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("0 active · 1 pending");
    expect(response.body).toContain("Pending — merge the setup PR, then add this repository again to activate it");
    expect(response.body).toContain("Open setup PR");
  });

  it("guides GitHub App installation with signed single-use state and a repository picker", async () => {
    const controlPlane = setupControlPlane();
    const writePermissions = Object.fromEntries([
      "actions", "administration", "checks", "contents", "issues", "pull_requests", "secrets", "variables", "workflows",
    ].map((permission) => [permission, "write"]));
    const access = {
      getInstallation: vi.fn(async (id: number) => ({
        id,
        account: { login: "acme", type: "Organization" },
        htmlUrl: "https://github.com/organizations/acme/settings/installations/42",
        permissions: writePermissions,
      })),
      listInstallations: vi.fn(async () => [{
        id: 42,
        account: { login: "acme", type: "Organization" },
        htmlUrl: "https://github.com/organizations/acme/settings/installations/42",
        permissions: writePermissions,
      }]),
      listInstallationRepositories: vi.fn(async () => [{
        fullName: "acme/store",
        private: true,
        archived: false,
        disabled: false,
      }]),
    };
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
        github: {
          appSlug: "acme-flow",
          stateSecret: Buffer.alloc(32, 9),
          access,
        },
      },
    });
    servers.push(server);

    const setup = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });
    expect(setup.body).toContain("Connect GitHub");
    expect(setup.body).toContain('value="acme/store"');
    expect(setup.body).toContain("Update repository access");
    expect(setup.body).toContain("I confirm Flow may open the reviewed setup PR");

    const connect = await server.inject({ method: "GET", url: "/admin/github/connect", headers: { authorization } });
    expect(connect.statusCode).toBe(302);
    const target = new URL(String(connect.headers.location));
    expect(`${target.origin}${target.pathname}`).toBe("https://github.com/apps/acme-flow/installations/new");
    const state = target.searchParams.get("state");
    expect(state).toBeTruthy();

    const invalid = await server.inject({
      method: "GET",
      url: "/admin/github/callback?installation_id=42&state=invalid",
      headers: { authorization },
    });
    expect(invalid.statusCode).toBe(403);

    const callbackUrl = `/admin/github/callback?installation_id=42&state=${encodeURIComponent(state!)}`;
    const callback = await server.inject({ method: "GET", url: callbackUrl, headers: { authorization } });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/admin/setup?github=connected");
    expect(access.getInstallation).toHaveBeenCalledWith(42);

    const replay = await server.inject({ method: "GET", url: callbackUrl, headers: { authorization } });
    expect(replay.statusCode).toBe(403);
  });

  it("stores provider models and hard token and cost admission limits", async () => {
    const controlPlane = setupControlPlane();
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);
    const setup = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });
    const body = new URLSearchParams({
      csrf: csrfFrom(setup.body),
      codex_enabled: "on",
      codex_build_model: "gpt-codex-build",
      codex_build_tier: "frontier",
      codex_build_input_price: "2.5",
      codex_build_output_price: "10",
      codex_review_model: "gpt-codex-review",
      codex_review_tier: "frontier",
      codex_review_input_price: "1.5",
      codex_review_output_price: "8",
      codex_qa_model: "gpt-codex-vision",
      codex_qa_tier: "frontier",
      codex_qa_input_price: "3",
      codex_qa_output_price: "12",
      max_retries: "1",
      per_job_tokens: "100000",
      monthly_tokens: "2000000",
      per_job_cost: "25",
      monthly_cost: "500",
    }).toString();

    const response = await server.inject({
      method: "POST",
      url: "/admin/routing",
      headers: { authorization, origin: "https://flow.example.com", "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/setup?routing=saved");
    expect(controlPlane.saveRoutingSettings).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [
        expect.objectContaining({
          id: "codex-build",
          provider: "codex",
          model: "gpt-codex-build",
          roles: ["intake", "plan", "build"],
          inputMicrosPerMillionTokens: 2_500_000,
          outputMicrosPerMillionTokens: 10_000_000,
        }),
        expect.objectContaining({
          id: "codex-review",
          model: "gpt-codex-review",
          roles: ["review", "security"],
        }),
        expect.objectContaining({
          id: "codex-qa",
          model: "gpt-codex-vision",
          roles: ["qa"],
        }),
      ],
      policy: expect.objectContaining({
        maxTransientRetriesPerCandidate: 1,
        limits: {
          perJobTokens: 100_000,
          monthlyTokens: 2_000_000,
          perJobCostMicros: 25_000_000,
          monthlyCostMicros: 500_000_000,
        },
      }),
    }));
  });

  it("refreshes a provider model list through an authenticated CSRF-protected action", async () => {
    const controlPlane = setupControlPlane();
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);
    const setup = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });
    const response = await server.inject({
      method: "POST",
      url: "/admin/providers/codex/models",
      headers: { authorization, origin: "https://flow.example.com", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrfFrom(setup.body) }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/setup?models=refreshed&provider=codex");
    expect(controlPlane.refreshProviderModels).toHaveBeenCalledWith("codex");
  });

  it("requires same-origin Basic auth and a single-use CSRF token for provider changes", async () => {
    const controlPlane = setupControlPlane();
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);
    const setup = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });
    const csrf = csrfFrom(setup.body);
    const body = new URLSearchParams({ csrf, credential: "sk-secret-never-echo" }).toString();

    const crossOrigin = await server.inject({
      method: "POST",
      url: "/admin/providers/codex",
      headers: { authorization, origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const accepted = await server.inject({
      method: "POST",
      url: "/admin/providers/codex",
      headers: { authorization, origin: "https://flow.example.com", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const replay = await server.inject({
      method: "POST",
      url: "/admin/providers/codex",
      headers: { authorization, origin: "https://flow.example.com", "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error).toContain("https://flow.example.com/admin");
    expect(accepted.statusCode).toBe(303);
    expect(accepted.headers.location).toBe("/admin/setup?saved=codex");
    expect(replay.statusCode).toBe(403);
    expect(controlPlane.saveProviderCredential).toHaveBeenCalledOnce();
    expect(accepted.body).not.toContain("sk-secret-never-echo");
  });

  it("accepts explicitly trusted localhost mutations during development", async () => {
    const controlPlane = setupControlPlane();
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow-tunnel.example.test",
        trustedOrigins: ["http://localhost:3000"],
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);
    const setup = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });

    const response = await server.inject({
      method: "POST",
      url: "/admin/providers/codex/models",
      headers: { authorization, origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrfFrom(setup.body) }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(controlPlane.refreshProviderModels).toHaveBeenCalledWith("codex");
  });

  it("provisions a repository from the setup page", async () => {
    const controlPlane = setupControlPlane();
    const server = buildServer({
      isReady: () => true,
      admin: {
        username: "operator",
        password: "a-strong-test-password",
        publicUrl: "https://flow.example.com",
        getSummary: () => summary,
        controlPlane,
      },
    });
    servers.push(server);
    const setup = await server.inject({ method: "GET", url: "/admin/setup", headers: { authorization } });
    const body = new URLSearchParams({
      csrf: csrfFrom(setup.body),
      repository: "acme/store",
      codeowners: "@acme/platform,@release-owner",
      confirm: "yes",
    }).toString();

    const response = await server.inject({
      method: "POST",
      url: "/admin/repositories",
      headers: { authorization, origin: "https://flow.example.com", "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/setup?repository=pending");
    expect(controlPlane.provisionRepository).toHaveBeenCalledWith({
      repository: "acme/store",
      codeowners: ["@acme/platform", "@release-owner"],
    });
  });
});
