#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fail = (message, status = 2) => {
  process.stderr.write(`${message}\n`);
  process.exit(status);
};

const target = process.argv[2];
const configFlag = process.argv.indexOf("--config");
const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : ".flow/config.json";

if (!["install", "checks", "qa", "start"].includes(target)) {
  fail("Target must be install, checks, qa, or start");
}
if (!configPath) fail("--config requires a path");

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`Cannot read repository contract: ${error instanceof Error ? error.message : "invalid JSON"}`);
}

if (config.version !== 1) fail("Repository contract version must be 1");

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

for (const [executable, ...args] of commands) {
  const result = spawnSync(executable, args, { shell: false, stdio: "inherit" });
  if (result.error) fail(result.error.message, 1);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
