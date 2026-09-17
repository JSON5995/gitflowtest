#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const fail = (message, status = 2) => {
  process.stderr.write(`${message}\n`);
  process.exit(status);
};

const target = process.argv[2];
const configFlag = process.argv.indexOf("--config");
const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : ".flow/config.json";

if (!["install", "checks", "qa", "start", "guard"].includes(target)) {
  fail("Target must be install, checks, qa, start, or guard");
}
if (!configPath) fail("--config requires a path");

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`Cannot read repository contract: ${error instanceof Error ? error.message : "invalid JSON"}`);
}

if (config.version !== 1) fail("Repository contract version must be 1");

if (target === "guard") {
  const baseFlag = process.argv.indexOf("--base");
  const base = baseFlag >= 0 ? process.argv[baseFlag + 1] : undefined;
  if (!base) fail("guard requires --base");
  if (!Array.isArray(config.protectedPaths) || config.protectedPaths.some((path) => typeof path !== "string" || path.length === 0)) {
    fail("protectedPaths must be a non-empty string array");
  }
  const result = spawnSync("git", ["diff", "--cached", "--name-only", base, "--"], {
    shell: false,
    encoding: "utf8",
  });
  if (result.error) fail(result.error.message, 1);
  if (result.status !== 0) fail(result.stderr || "Cannot inspect staged changes", 1);
  const changed = result.stdout.split("\n").filter(Boolean);
  const blocked = changed.filter((path) => config.protectedPaths.some((prefix) =>
    path === prefix.replace(/\/$/, "") || path.startsWith(prefix)
  ));
  if (blocked.length > 0) fail(`Agent changed a protected path:\n${blocked.join("\n")}`, 1);
  process.exit(0);
}

const isCommand = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((part) => typeof part === "string") &&
  /^(?:[A-Za-z0-9_.-]+|\.\/[A-Za-z0-9_./-]+)$/.test(value[0]);

const commandValue = config[target];
const commands = target === "checks" || target === "qa"
  ? commandValue ?? []
  : commandValue === undefined
    ? []
    : [commandValue];

if (!Array.isArray(commands) || commands.some((command) => typeof command === "string")) {
  fail(`${target} must contain command arrays, not shell strings`);
}
if (commands.some((command) => Array.isArray(command) && command.length === 0)) {
  fail(`${target} commands must be non-empty`);
}
if (!commands.every(isCommand)) {
  fail(`${target} must contain command arrays with safe executable names`);
}

if (target === "start" && commands[0]) {
  const [executable, ...args] = commands[0];
  const child = spawn(executable, args, {
    shell: false,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  const forward = (signal) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The application already exited.
    }
  };
  const onTerm = () => forward("SIGTERM");
  const onInterrupt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);
  const [code] = await once(child, "exit");
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInterrupt);
  process.exit(typeof code === "number" ? code : 1);
}

for (const [executable, ...args] of commands) {
  const result = spawnSync(executable, args, { shell: false, stdio: "inherit" });
  if (result.error) fail(result.error.message, 1);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
