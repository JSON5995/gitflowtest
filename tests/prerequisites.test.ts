import { describe, expect, it } from "vitest";
import { ensurePrerequisites, type PrerequisiteExecutor } from "../src/prerequisites.js";

describe("CLI prerequisites", () => {
  it("accepts a machine that already has every CLI", async () => {
    const calls: string[] = [];
    const execute: PrerequisiteExecutor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
    };

    await expect(ensurePrerequisites({
      execute,
      platform: "darwin",
      interactive: false,
      stdout: () => undefined,
    })).resolves.toBeUndefined();

    expect(calls).toEqual([
      "git --version",
      "gh --version",
      "docker --version",
      "railway --version",
    ]);
  });

  it("offers to install missing macOS tools with Homebrew", async () => {
    const calls: string[] = [];
    const installed = new Set<string>();
    const execute: PrerequisiteExecutor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "brew") {
        if (args[0] === "--version") return;
        installed.add(args.at(-1)!);
        return;
      }
      if (command === "gh" && !installed.has("gh")) throw new Error("missing");
      if (command === "railway" && !installed.has("railway")) throw new Error("missing");
    };

    await ensurePrerequisites({
      execute,
      platform: "darwin",
      interactive: true,
      confirm: async () => true,
      stdout: () => undefined,
    });

    expect(calls).toContain("brew install gh");
    expect(calls).toContain("brew install railway");
  });

  it("prints safe install guidance when automatic installation is unavailable", async () => {
    const output: string[] = [];
    const execute: PrerequisiteExecutor = async (command) => {
      if (command === "docker") throw new Error("missing");
    };

    await expect(ensurePrerequisites({
      execute,
      platform: "linux",
      interactive: false,
      stdout: (message) => { output.push(message); },
    })).rejects.toThrow(/Missing required CLI/);

    expect(output.join("\n")).toContain("Docker Engine");
    expect(output.join("\n")).toContain("https://docs.docker.com/engine/install/");
  });
});
