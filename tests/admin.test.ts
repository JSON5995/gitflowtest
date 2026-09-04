import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const summary = {
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
});
