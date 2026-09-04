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
    const linkedPath = join(directory, "flow-ai");
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
    };

    expect(await runCli(["setup"], context)).toBe(0);
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("flow.example.com");
    expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
    writeFileSync(join(directory, ".env"), "KEEP=me\n");
    expect(await runCli(["setup"], context)).toBe(0);
    expect(await readFile(join(directory, ".env"), "utf8")).toBe("KEEP=me\n");
    expect(output.join("\n")).toContain("already exists");
  });

  it("writes the selected single-agent mode during setup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-cli-agent-"));
    cleanupPaths.push(directory);
    const template = join(directory, "template.env");
    writeFileSync(template, "FLOW_AGENT=\nFLOW_BUILDER=codex\nFLOW_REVIEWER=claude\n");

    expect(await runCli(["setup", "--agent", "cursor"], {
      cwd: directory,
      env: {},
      projectRoot: directory,
      envTemplatePath: template,
      stdout: () => undefined,
      stderr: () => undefined,
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
});
