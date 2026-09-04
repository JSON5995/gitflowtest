import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout as processStdout } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PrerequisiteExecutor = (command: string, args: string[]) => Promise<void>;

type PrerequisiteOptions = {
  execute?: PrerequisiteExecutor;
  platform?: NodeJS.Platform;
  interactive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  stdout?: (message: string) => void;
};

const tools = [
  { command: "git", label: "Git", args: ["--version"], brew: ["install", "git"] },
  { command: "gh", label: "GitHub CLI", args: ["--version"], brew: ["install", "gh"] },
  { command: "docker", label: "Docker", args: ["--version"], brew: ["install", "--cask", "docker"] },
  { command: "railway", label: "Railway CLI", args: ["--version"], brew: ["install", "railway"] },
] as const;

const defaultExecute: PrerequisiteExecutor = async (command, args) => {
  await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
};

const defaultConfirm = async (question: string): Promise<boolean> => {
  const prompt = createInterface({ input: stdin, output: processStdout });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
};

const findMissing = async (execute: PrerequisiteExecutor) => {
  const missing: Array<(typeof tools)[number]> = [];
  for (const tool of tools) {
    try {
      await execute(tool.command, [...tool.args]);
    } catch {
      missing.push(tool);
    }
  }
  return missing;
};

const guidance = (missing: Awaited<ReturnType<typeof findMissing>>, platform: NodeJS.Platform): string => {
  const labels = missing.map((tool) => tool.label).join(", ");
  if (platform === "darwin") {
    const commands = missing.map((tool) => `brew ${tool.brew.join(" ")}`).join("\n");
    return `Missing: ${labels}\n${commands}\nHomebrew: https://brew.sh/`;
  }
  return [
    `Missing: ${labels}`,
    "Git: https://git-scm.com/downloads",
    "GitHub CLI: https://cli.github.com/",
    "Docker Engine: https://docs.docker.com/engine/install/",
    "Railway CLI: https://docs.railway.com/cli",
  ].join("\n");
};

export const ensurePrerequisites = async (options: PrerequisiteOptions = {}): Promise<void> => {
  const execute = options.execute ?? defaultExecute;
  const platform = options.platform ?? process.platform;
  const interactive = options.interactive ?? Boolean(stdin.isTTY && processStdout.isTTY);
  const confirm = options.confirm ?? defaultConfirm;
  const write = options.stdout ?? console.log;
  const missing = await findMissing(execute);
  if (missing.length === 0) {
    write("Git, GitHub CLI, Docker, and Railway CLI are ready.");
    return;
  }

  write(guidance(missing, platform));
  if (platform !== "darwin" || !interactive) {
    throw new Error(`Missing required CLI tools: ${missing.map((tool) => tool.command).join(", ")}`);
  }

  try {
    await execute("brew", ["--version"]);
  } catch (error) {
    throw new Error("Homebrew is required for automatic installation on macOS. Install it from https://brew.sh/ and rerun `flow init`.", { cause: error });
  }
  if (!await confirm(`Install ${missing.map((tool) => tool.label).join(", ")} now?`)) {
    throw new Error("Installation was skipped. Install the missing tools, then rerun `flow init`.");
  }
  for (const tool of missing) {
    write(`Installing ${tool.label}…`);
    await execute("brew", [...tool.brew]);
  }

  const stillMissing = await findMissing(execute);
  if (stillMissing.length > 0) {
    throw new Error(`Installation finished, but these commands are still unavailable: ${stillMissing.map((tool) => tool.command).join(", ")}`);
  }
};
