import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDirectCliInvocation, runCli } from "../src/cli.js";
import type { GitHubApi } from "../src/github.js";
import { loadRepositoryKit } from "../src/provision.js";
import { validEnv } from "./helpers.js";

const cliMocks = vi.hoisted(() => ({
  createGitHubAppAccess: vi.fn(),
  createGitHubTokenApi: vi.fn(),
  readCurrentGitHubRepository: vi.fn(),
  readGitHubCliToken: vi.fn(),
}));

vi.mock("../src/github-app.js", () => ({
  createGitHubAppAccess: cliMocks.createGitHubAppAccess,
}));

vi.mock("../src/github-token.js", () => ({
  createGitHubTokenApi: cliMocks.createGitHubTokenApi,
  readCurrentGitHubRepository: cliMocks.readCurrentGitHubRepository,
  readGitHubCliToken: cliMocks.readGitHubCliToken,
}));

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Flow CLI", () => {
  it("recognizes execution through a global package symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-cli-link-"));
    cleanupPaths.push(directory);
    const cliPath = join(directory, "cli.js");
    const linkedPath = join(directory, "flow");
    writeFileSync(cliPath, "#!/usr/bin/env node\n");
    symlinkSync(cliPath, linkedPath);

    expect(isDirectCliInvocation(linkedPath, `file://${cliPath}`)).toBe(true);
  });

  it("creates an editable environment file without overwriting an existing one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-cli-"));
    cleanupPaths.push(directory);
    const template = join(directory, "template.env");
    writeFileSync(template, "PUBLIC_URL=https://flow.example.com\n");
    const output: string[] = [];
    const context = {
      cwd: directory,
      env: {},
      projectRoot: directory,
      envTemplatePath: template,
      stdout: (message: string) => { output.push(message); },
      stderr: () => undefined,
      ensurePrerequisites: async () => undefined,
    };

    expect(await runCli(["init"], context)).toBe(0);
    const configured = await readFile(join(directory, ".env"), "utf8");
    expect(configured).toContain("flow.example.com");
    expect(configured).toMatch(/^TELEGRAM_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,}$/m);
    expect(configured).toMatch(/^GITHUB_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,}$/m);
    expect(configured).toMatch(/^FLOW_ADMIN_PASSWORD=[A-Za-z0-9_-]{32,}$/m);
    expect(configured).toMatch(/^FLOW_CREDENTIAL_KEY=[A-Za-z0-9_-]{43}$/m);
    expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
    writeFileSync(join(directory, ".env"), "KEEP=me\n");
    expect(await runCli(["init"], context)).toBe(0);
    const upgraded = await readFile(join(directory, ".env"), "utf8");
    expect(upgraded).toContain("KEEP=me");
    expect(upgraded).toMatch(/^FLOW_CREDENTIAL_KEY=[A-Za-z0-9_-]{43}$/m);
    expect(output.join("\n")).toContain("missing generated security values were added");
  });

  it("writes the selected single-agent mode during setup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-cli-agent-"));
    cleanupPaths.push(directory);
    const template = join(directory, "template.env");
    writeFileSync(template, "FLOW_AGENT=\nFLOW_BUILDER=codex\nFLOW_REVIEWER=claude\n");

    expect(await runCli(["init", "--agent", "cursor"], {
      cwd: directory,
      env: {},
      projectRoot: directory,
      envTemplatePath: template,
      stdout: () => undefined,
      stderr: () => undefined,
      ensurePrerequisites: async () => undefined,
    })).toBe(0);
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("FLOW_AGENT=cursor");
  });

  it("preserves a malformed credential key and explains the only safe migration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-cli-invalid-key-"));
    cleanupPaths.push(directory);
    const template = join(directory, "template.env");
    writeFileSync(template, "FLOW_CREDENTIAL_KEY=\n");
    writeFileSync(join(directory, ".env"), "FLOW_CREDENTIAL_KEY=invalid-existing-key\n");
    const output: string[] = [];

    const code = await runCli(["init"], {
      cwd: directory,
      env: {},
      projectRoot: directory,
      envTemplatePath: template,
      stdout: (message: string) => { output.push(message); },
      stderr: (message: string) => { output.push(message); },
      ensurePrerequisites: async () => undefined,
    });

    expect(code).toBe(1);
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("FLOW_CREDENTIAL_KEY=invalid-existing-key");
    expect(output.join("\n")).toContain("Back up your database and current .env/key");
    expect(output.join("\n")).toContain("clear only the invalid FLOW_CREDENTIAL_KEY line");
    expect(output.join("\n")).toContain("existing encrypted provider credentials unreadable");
    expect(output.join("\n")).not.toContain("already exists and is ready");
  });

  it("reports invalid configuration without printing secret values", async () => {
    const output: string[] = [];
    const secret = "never-print-this-secret";
    const code = await runCli(["doctor"], {
      cwd: process.cwd(),
      env: { OPENAI_API_KEY: secret },
      projectRoot: process.cwd(),
      envTemplatePath: join(process.cwd(), ".env.example"),
      stdout: (message) => { output.push(message); },
      stderr: (message) => { output.push(message); },
    });

    expect(code).toBe(1);
    expect(output.join("\n")).not.toContain(secret);
    expect(output.join("\n")).toContain("Configuration is incomplete");
  });

  it("gives existing installations an actionable credential-key migration", async () => {
    const output: string[] = [];
    const code = await runCli(["doctor"], {
      cwd: process.cwd(),
      env: validEnv({ FLOW_CREDENTIAL_KEY: undefined }),
      projectRoot: process.cwd(),
      envTemplatePath: join(process.cwd(), ".env.example"),
      stdout: (message) => { output.push(message); },
      stderr: (message) => { output.push(message); },
    });

    expect(code).toBe(1);
    expect(output.join("\n")).toContain("Run `flow init`");
    expect(output.join("\n")).toContain("32 random bytes");
  });

  it("does not claim doctor can automatically repair a malformed credential key", async () => {
    const output: string[] = [];
    const code = await runCli(["doctor"], {
      cwd: process.cwd(),
      env: validEnv({ FLOW_CREDENTIAL_KEY: "malformed-existing-key" }),
      projectRoot: process.cwd(),
      envTemplatePath: join(process.cwd(), ".env.example"),
      stdout: (message) => { output.push(message); },
      stderr: (message) => { output.push(message); },
    });

    expect(code).toBe(1);
    expect(output.join("\n")).toContain("Back up your database and current .env/key");
    expect(output.join("\n")).toContain("clear only the invalid FLOW_CREDENTIAL_KEY line");
    expect(output.join("\n")).toContain("existing encrypted provider credentials unreadable");
    expect(output.join("\n")).not.toContain("repair it safely");
  });

  it("keeps a legacy repository pending when only the build workflow is installed", async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const api: GitHubApi = {
      request: async (route, parameters) => {
        calls.push({ route, parameters });
        if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          if (parameters.path === ".github/workflows/flow-build.yml") {
            return { data: { type: "file", content: Buffer.from("legacy build").toString("base64") } };
          }
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{ref}") {
          return { data: { object: { sha: "base-sha" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
          return { data: { tree: { sha: "base-tree" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
        if (route === "POST /repos/{owner}/{repo}/git/trees") return { data: { sha: "new-tree" } };
        if (route === "POST /repos/{owner}/{repo}/git/commits") return { data: { sha: "new-commit" } };
        if (route === "POST /repos/{owner}/{repo}/pulls") {
          return { data: { number: 9, html_url: "https://github.test/acme/store/pull/9" } };
        }
        return { data: {} };
      },
    };
    cliMocks.createGitHubAppAccess.mockReturnValue({
      getInstallationId: async () => 1,
      getAppSlug: async () => "flow-ai",
    });
    cliMocks.readGitHubCliToken.mockResolvedValue("github-token");
    cliMocks.createGitHubTokenApi.mockReturnValue(api);
    const output: string[] = [];

    const code = await runCli(["repo", "add", "acme/store"], {
      cwd: process.cwd(),
      env: validEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }),
      projectRoot: process.cwd(),
      envTemplatePath: join(process.cwd(), ".env.example"),
      stdout: (message) => { output.push(message); },
      stderr: (message) => { output.push(message); },
    });

    expect(code, output.join("\n")).toBe(0);
    expect(output.join("\n")).toContain("Setup pull request is waiting");
    expect(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/git/trees")).toBe(true);
    expect(calls.some((call) => call.route.includes("/rulesets"))).toBe(false);
    expect(calls.some((call) => call.route.includes("/actions/secrets"))).toBe(false);
    expect(calls.some((call) => call.route.includes("/actions/variables"))).toBe(false);
  });

  it("activates a legacy repository only when the complete rendered kit matches", async () => {
    const kit = await loadRepositoryKit(join(process.cwd(), "repo-kit"));
    const rendered = Object.fromEntries(Object.entries(kit).map(([path, content]) => [
      path,
      content.replaceAll("{{FLOW_CODEOWNERS}}", "@acme/platform @release-owner"),
    ]));
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const api: GitHubApi = {
      request: async (route, parameters) => {
        calls.push({ route, parameters });
        if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          const content = rendered[String(parameters.path)];
          if (content === undefined) throw Object.assign(new Error("not found"), { status: 404 });
          return { data: { type: "file", content: Buffer.from(content).toString("base64") } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{ref}") {
          return { data: { object: { sha: "base-sha" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
          return { data: { tree: { sha: "base-tree" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/rulesets") return { data: [] };
        return { data: {} };
      },
    };
    cliMocks.createGitHubAppAccess.mockReturnValue({
      getInstallationId: async () => 1,
      getAppSlug: async () => "flow-ai",
    });
    cliMocks.readGitHubCliToken.mockResolvedValue("github-token");
    cliMocks.createGitHubTokenApi.mockReturnValue(api);
    const output: string[] = [];

    const code = await runCli(["repo", "add", "acme/store"], {
      cwd: process.cwd(),
      env: validEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }),
      projectRoot: process.cwd(),
      envTemplatePath: join(process.cwd(), ".env.example"),
      stdout: (message) => { output.push(message); },
      stderr: (message) => { output.push(message); },
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Installed Flow in acme/store@main");
    expect(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/rulesets")).toBe(true);
  });

  it("passes Railway hosting options to the deployment flow", async () => {
    const calls: unknown[] = [];
    const code = await runCli([
      "host", "railway", "--project", "company-flow", "--workspace", "Platform", "--allow-dirty",
    ], {
      cwd: process.cwd(),
      env: { FLOW_ADMIN_PASSWORD: "secret" },
      projectRoot: "/opt/flow",
      envTemplatePath: "/opt/flow/.env.example",
      stdout: () => undefined,
      stderr: () => undefined,
      deployToRailway: async (options) => {
        calls.push(options);
        return {
          publicUrl: "https://flow.up.railway.app",
          adminUrl: "https://flow.up.railway.app/admin",
          healthUrl: "https://flow.up.railway.app/health/ready",
          githubWebhookUrl: "https://flow.up.railway.app/webhooks/github",
          telegramWebhookUrl: "https://flow.up.railway.app/webhooks/telegram",
        };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([expect.objectContaining({
      projectRoot: "/opt/flow",
      projectName: "company-flow",
      workspace: "Platform",
      allowDirty: true,
    })]);
  });
});
