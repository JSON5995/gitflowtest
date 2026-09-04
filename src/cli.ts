import { constants } from "node:fs";
import { chmod, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { createGitHubAppAccess } from "./github-app.js";
import { createGitHubTokenApi, readGitHubCliToken } from "./github-token.js";
import { loadRepositoryKit, provisionRepository } from "./provision.js";
import { openStorage } from "./storage.js";

type CliContext = {
  cwd: string;
  env: Record<string, string | undefined>;
  projectRoot: string;
  envTemplatePath: string;
  stdout(message: string): void;
  stderr(message: string): void;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const defaultContext: CliContext = {
  cwd: process.cwd(),
  env: process.env,
  projectRoot,
  envTemplatePath: join(projectRoot, ".env.example"),
  stdout: console.log,
  stderr: console.error,
};

const help = `Flow AI

  ./flow setup [--agent NAME]  Create .env; NAME is claude, codex, or cursor
  ./flow doctor                Validate configuration and local storage
  ./flow repo add OWNER/REPO   Install workflows, secrets, labels, and merge rules`;

const setup = async (context: CliContext, agent?: string): Promise<number> => {
  if (agent && !["claude", "codex", "cursor"].includes(agent)) {
    throw new Error("--agent must be claude, codex, or cursor");
  }
  const destination = join(context.cwd, ".env");
  try {
    await copyFile(context.envTemplatePath, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    if (agent) {
      const template = await readFile(destination, "utf8");
      const configured = /^FLOW_AGENT=.*$/m.test(template)
        ? template.replace(/^FLOW_AGENT=.*$/m, `FLOW_AGENT=${agent}`)
        : `${template.trimEnd()}\nFLOW_AGENT=${agent}\n`;
      await writeFile(destination, configured);
    }
    context.stdout(`Created ${destination}. Add the credential values, then run ./flow doctor.`);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code !== "EEXIST") throw error;
    context.stdout(`${destination} already exists; it was not changed.`);
  }
  return 0;
};

const doctor = async (context: CliContext): Promise<number> => {
  const config = loadConfig(context.env);
  await stat(join(context.projectRoot, "repo-kit/.github/workflows/flow-build.yml"));
  const storage = openStorage(config.databasePath);
  try {
    if (!storage.isReady()) throw new Error("SQLite storage is unavailable");
  } finally {
    storage.close();
  }
  context.stdout("Configuration, repository kit, and durable storage are ready.");
  return 0;
};

const addRepository = async (repository: string | undefined, context: CliContext): Promise<number> => {
  if (!repository) throw new Error("Usage: ./flow repo add OWNER/REPO");
  const config = loadConfig(context.env);
  const access = createGitHubAppAccess({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
  });
  const [, appSlug, files, provisioningToken] = await Promise.all([
    access.getInstallationId(repository),
    access.getAppSlug(),
    loadRepositoryKit(join(context.projectRoot, "repo-kit")),
    readGitHubCliToken(),
  ]);
  const result = await provisionRepository({
    repository,
    api: createGitHubTokenApi({ token: provisioningToken }),
    files,
    secrets: {
      OPENAI_API_KEY: config.providers.openaiApiKey,
      ...(config.providers.anthropicApiKey ? { ANTHROPIC_API_KEY: config.providers.anthropicApiKey } : {}),
      ...(config.providers.cursorApiKey ? { CURSOR_API_KEY: config.providers.cursorApiKey } : {}),
    },
    variables: {
      FLOW_BUILDER: config.flow.builder,
      FLOW_REVIEWER: config.flow.reviewer,
      FLOW_QA_PROVIDER: config.flow.qa,
      FLOW_BOT_LOGIN: `${appSlug}[bot]`,
    },
    codeowners: config.flow.codeowners,
    checkIntegrationId: config.github.appId,
  });
  if (result.mergeGateInstalled) {
    context.stdout(`Installed Flow AI in ${repository}@${result.defaultBranch} (${result.commitSha.slice(0, 12)}).`);
    context.stdout(`In Telegram, run /connect ${repository}, send feedback, then /ship.`);
  } else {
    context.stdout(`Setup pull request is waiting for the repository's required approval: ${result.setupPullRequestUrl ?? repository}`);
    context.stdout("After it is merged, run the same repo add command once to install the human merge gate.");
  }
  return 0;
};

const safeError = (error: unknown): string => {
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map((issue) => String(issue.path[0] ?? "configuration")))];
    return `Configuration is incomplete or invalid: ${fields.join(", ")}`;
  }
  return error instanceof Error ? error.message : String(error);
};

export const runCli = async (
  argv: string[],
  overrides: Partial<CliContext> = {},
): Promise<number> => {
  const context: CliContext = { ...defaultContext, ...overrides };
  try {
    if (argv[0] === "setup") {
      if (argv[1] && argv[1] !== "--agent") throw new Error("Usage: ./flow setup [--agent claude|codex|cursor]");
      return await setup(context, argv[1] === "--agent" ? argv[2] : undefined);
    }
    if (argv[0] === "doctor") return await doctor(context);
    if (argv[0] === "repo" && argv[1] === "add") return await addRepository(argv[2], context);
    context.stdout(help);
    return argv.length === 0 || argv[0] === "help" || argv[0] === "--help" ? 0 : 1;
  } catch (error) {
    context.stderr(safeError(error));
    return 1;
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
