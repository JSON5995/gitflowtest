import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];
const runner = resolve("repo-kit/scripts/run-contract.mjs");

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const runContract = (config: unknown, target: "install" | "checks" | "qa" | "start" | "guard") => {
  const directory = mkdtempSync(join(tmpdir(), "gitflow-contract-"));
  cleanupPaths.push(directory);
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return spawnSync(process.execPath, [runner, target, "--config", path], {
    cwd: directory,
    encoding: "utf8",
  });
};

const validConfig = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  install: ["node", "-e", "process.stdout.write('installed')"],
  checks: [["node", "-e", "process.stdout.write(process.argv[1])", "$HOME;echo hacked"]],
  qa: [["node", "-e", "process.exit(0)"]],
  start: ["node", "-e", "setInterval(() => {}, 1000)"],
  healthUrl: "http://127.0.0.1:3000/health",
  maxParallelBuilds: 2,
  protectedPaths: [".github/workflows/", ".flow/"],
  ...overrides,
});

describe("repository contract runner", () => {
  it("passes metacharacters and environment references literally", () => {
    const result = runContract(validConfig(), "checks");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("$HOME;echo hacked");
  });

  it("rejects shell-string commands", () => {
    const result = runContract(validConfig({ checks: ["npm test"] }), "checks");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("command arrays");
  });

  it("rejects empty commands", () => {
    const result = runContract(validConfig({ checks: [[]] }), "checks");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("non-empty");
  });

  it("returns the first failing command exit code", () => {
    const result = runContract(validConfig({
      checks: [
        ["node", "-e", "process.exit(7)"],
        ["node", "-e", "process.exit(0)"],
      ],
    }), "checks");

    expect(result.status).toBe(7);
  });

  it("blocks staged changes to trusted automation paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-contract-git-"));
    cleanupPaths.push(directory);
    writeFileSync(join(directory, "config.json"), JSON.stringify(validConfig()));
    spawnSync("git", ["init", "-q"], { cwd: directory });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: directory });
    spawnSync("git", ["add", "config.json"], { cwd: directory });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: directory });
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    mkdirSync(join(directory, ".flow"));
    writeFileSync(join(directory, ".flow", "evil.yml"), "protected");
    spawnSync("git", ["add", ".flow"], { cwd: directory });

    const result = spawnSync(process.execPath, [runner, "guard", "--config", join(directory, "config.json"), "--base", base], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("protected path");
  });

  it("forwards shutdown to the configured application process group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-contract-start-"));
    cleanupPaths.push(directory);
    const marker = join(directory, "stopped.txt");
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify(validConfig({
      start: [
        "node",
        "-e",
        "process.on('SIGTERM',()=>{require('fs').writeFileSync(process.argv[1],'stopped');process.exit(0)});setInterval(()=>{},1000)",
        marker,
      ],
    })));
    const processUnderTest = spawn(process.execPath, [runner, "start", "--config", configPath], {
      cwd: directory,
      stdio: "ignore",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    processUnderTest.kill("SIGTERM");
    await new Promise((resolveExit) => processUnderTest.once("exit", resolveExit));

    expect(readFileSync(marker, "utf8")).toBe("stopped");
  });
});
