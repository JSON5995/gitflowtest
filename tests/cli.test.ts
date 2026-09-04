import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectCliInvocation, runCli } from "../src/cli.js";

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
    expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
    writeFileSync(join(directory, ".env"), "KEEP=me\n");
    expect(await runCli(["init"], context)).toBe(0);
    expect(await readFile(join(directory, ".env"), "utf8")).toBe("KEEP=me\n");
    expect(output.join("\n")).toContain("already exists");
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
