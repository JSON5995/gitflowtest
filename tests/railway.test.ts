import { describe, expect, it } from "vitest";
import { deployToRailway, type CommandExecutor } from "../src/railway.js";
import { validEnv } from "./helpers.js";

type RecordedCall = { command: string; args: string[]; input?: string };

const firstDeployExecutor = (calls: RecordedCall[]): CommandExecutor => async (command, args, options = {}) => {
  calls.push({ command, args, ...(options.input === undefined ? {} : { input: options.input }) });
  const joined = `${command} ${args.join(" ")}`;
  if (joined === "git status --porcelain") return { stdout: "" };
  if (joined === "railway whoami --json") return { stdout: '{"email":"owner@example.com"}' };
  if (joined === "railway status --json") throw new Error("No linked project found");
  if (joined === "railway list --json") return { stdout: "[]" };
  if (joined.startsWith("railway init ")) return { stdout: '{"id":"project-1","name":"flow"}' };
  if (joined === "railway service list --json") return { stdout: "[]" };
  if (joined.startsWith("railway add ")) return { stdout: '{"id":"service-1","name":"flow"}' };
  if (joined === "railway volume list --service flow --environment production --json") return { stdout: "[]" };
  if (joined.startsWith("railway volume add ")) return { stdout: '{"id":"volume-1","mountPath":"/data"}' };
  if (joined === "railway domain list --service flow --environment production --json") return { stdout: "[]" };
  if (joined.startsWith("railway domain --service ")) return { stdout: '{"domain":"flow-production.up.railway.app"}' };
  return { stdout: "{}" };
};

describe("Railway hosting", () => {
  it("creates and configures one volume-backed service without exposing secrets in arguments", async () => {
    const calls: RecordedCall[] = [];
    const output: string[] = [];

    const result = await deployToRailway({
      env: validEnv(),
      projectRoot: process.cwd(),
      execute: firstDeployExecutor(calls),
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      sleep: async () => undefined,
      stdout: (message) => { output.push(message); },
    });

    expect(result.publicUrl).toBe("https://flow-production.up.railway.app");
    expect(calls.some((call) => call.args[0] === "init")).toBe(true);
    expect(calls.some((call) => call.args[0] === "add" && call.args.includes("--service"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "volume" && call.args[1] === "add")).toBe(true);
    expect(calls.some((call) => call.args[0] === "domain" && !call.args.includes("list"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "environment" && call.args[1] === "edit")).toBe(true);
    expect(calls.some((call) => call.args[0] === "up")).toBe(true);

    const secret = validEnv().OPENAI_API_KEY!;
    expect(JSON.stringify(calls.map(({ command, args }) => ({ command, args })))).not.toContain(secret);
    expect(calls).toContainEqual(expect.objectContaining({
      command: "railway",
      args: expect.arrayContaining(["variable", "set", "OPENAI_API_KEY", "--stdin"]),
      input: secret,
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(["variable", "set", "RAILWAY_RUN_UID", "--stdin"]),
      input: "0",
    }));
    expect(output.join("\n")).toContain("/admin");
  });

  it("reuses an existing project, service, volume, and domain on rerun", async () => {
    const calls: RecordedCall[] = [];
    const execute: CommandExecutor = async (command, args, options = {}) => {
      calls.push({ command, args, ...(options.input === undefined ? {} : { input: options.input }) });
      const joined = `${command} ${args.join(" ")}`;
      if (joined === "git status --porcelain") return { stdout: "" };
      if (joined === "railway whoami --json") return { stdout: "{}" };
      if (joined === "railway status --json") return { stdout: '{"project":{"id":"project-1","name":"flow"}}' };
      if (joined === "railway service list --json") return { stdout: '[{"id":"service-1","name":"flow"}]' };
      if (joined.startsWith("railway volume list ")) return { stdout: '[{"id":"volume-1","mountPath":"/data"}]' };
      if (joined.startsWith("railway domain list ")) return { stdout: '[{"domain":"existing.up.railway.app"}]' };
      return { stdout: "{}" };
    };

    await deployToRailway({
      env: validEnv(),
      projectRoot: process.cwd(),
      execute,
      fetch: async () => new Response('{"ok":true}', { status: 200 }),
      sleep: async () => undefined,
      stdout: () => undefined,
    });

    expect(calls.some((call) => ["init", "add"].includes(call.args[0] ?? ""))).toBe(false);
    expect(calls.some((call) => call.args[0] === "volume" && call.args[1] === "add")).toBe(false);
    expect(calls.some((call) => call.args[0] === "domain" && !call.args.includes("list"))).toBe(false);
  });

  it("validates configuration before making Railway changes", async () => {
    const calls: RecordedCall[] = [];

    await expect(deployToRailway({
      env: validEnv({ TELEGRAM_BOT_TOKEN: undefined }),
      projectRoot: process.cwd(),
      execute: firstDeployExecutor(calls),
      fetch: async () => new Response(),
      sleep: async () => undefined,
      stdout: () => undefined,
    })).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);

    expect(calls).toEqual([]);
  });

  it("refuses to deploy uncommitted code unless explicitly allowed", async () => {
    const calls: RecordedCall[] = [];
    const execute: CommandExecutor = async (command, args) => {
      calls.push({ command, args });
      if (command === "git") return { stdout: " M src/index.ts\n" };
      return { stdout: "{}" };
    };

    await expect(deployToRailway({
      env: validEnv(),
      projectRoot: process.cwd(),
      execute,
      fetch: async () => new Response(),
      sleep: async () => undefined,
      stdout: () => undefined,
    })).rejects.toThrow(/uncommitted/);

    expect(calls).toHaveLength(1);
  });
});
