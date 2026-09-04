#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { chmod, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { createGitHubAppAccess } from "./github-app.js";
import { createGitHubTokenApi, readCurrentGitHubRepository, readGitHubCliToken } from "./github-token.js";
import { ensurePrerequisites } from "./prerequisites.js";
import { loadRepositoryKit, provisionRepository, verifyInstalledRepositoryKit } from "./provision.js";
import { deployToRailway } from "./railway.js";
import { openStorage } from "./storage.js";

type CliContext = {
  cwd: string;
  env: Record<string, string | undefined>;
  projectRoot: string;
  envTemplatePath: string;
  stdout(message: string): void;
  stderr(message: string): void;
  ensurePrerequisites: typeof ensurePrerequisites;
  deployToRailway: typeof deployToRailway;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const defaultContext: CliContext = {
  cwd: process.cwd(),
  env: process.env,
  projectRoot,
  envTemplatePath: join(projectRoot, ".env.example"),
  stdout: console.log,
  stderr: console.error,
  ensurePrerequisites,
  deployToRailway,
};

export const isDirectCliInvocation = (invokedPath: string, moduleUrl: string): boolean => {
  if (!invokedPath) return false;
  try {
    return realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return resolve(invokedPath) === fileURLToPath(moduleUrl);
  }
};

const help = `Flow

  flow init [--agent NAME]       Check tools and create the service configuration
  flow doctor                    Validate configuration and local storage
  flow repo add [OWNER/REPO]     Configure the current GitHub project, or an explicit repository
  flow host railway [OPTIONS]    Deploy or update the central service on Railway`;

const setEnvironmentValue = (
  contents: string,
  key: string,
  value: string,
  overwrite = false,
): string => {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = contents.match(pattern);
  if (!match) return `${contents.trimEnd()}\n${key}=${value}\n`;
  if (!overwrite && match[1]?.trim()) return contents;
  return contents.replace(pattern, `${key}=${value}`);
};

const credentialKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const malformedCredentialKeyMessage = [
  "FLOW_CREDENTIAL_KEY is malformed.",
  "Back up your database and current .env/key before changing it.",
  "Then clear only the invalid FLOW_CREDENTIAL_KEY line (set it to FLOW_CREDENTIAL_KEY=) and rerun `flow init`.",
  "Flow will generate a 32-byte base64url key; replacing this key makes existing encrypted provider credentials unreadable.",
].join(" ");

const initialize = async (context: CliContext, agent?: string): Promise<number> => {
  if (agent && !["claude", "codex", "cursor"].includes(agent)) {
    throw new Error("--agent must be claude, codex, or cursor");
  }
  await context.ensurePrerequisites({ stdout: context.stdout });
  const destination = join(context.projectRoot, ".env");
  let created = false;
  try {
    await copyFile(context.envTemplatePath, destination, constants.COPYFILE_EXCL);
    created = true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code !== "EEXIST") throw error;
  }
  const original = await readFile(destination, "utf8");
  let configured = original;
  for (const key of ["TELEGRAM_WEBHOOK_SECRET", "GITHUB_WEBHOOK_SECRET", "FLOW_ADMIN_PASSWORD", "FLOW_CREDENTIAL_KEY"]) {
    configured = setEnvironmentValue(configured, key, randomBytes(32).toString("base64url"));
  }
  if (agent) configured = setEnvironmentValue(configured, "FLOW_AGENT", agent, true);
  if (configured !== original) await writeFile(destination, configured, { mode: 0o600 });
  await chmod(destination, 0o600);
  const credentialKey = configured.match(/^FLOW_CREDENTIAL_KEY=(.*)$/m)?.[1]?.trim();
  if (credentialKey && !credentialKeyPattern.test(credentialKey)) {
    throw new Error(malformedCredentialKeyMessage);
  }
  if (created) context.stdout(`Created ${destination}. Add the GitHub App and Telegram bootstrap values, then run flow doctor.`);
  else if (configured !== original) context.stdout(`${destination} already existed; missing generated security values were added without changing existing values.`);
  else context.stdout(`${destination} already exists and is ready.`);
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
  const targetRepository = repository ?? await readCurrentGitHubRepository(context.cwd);
  const config = loadConfig(context.env);
  const access = createGitHubAppAccess({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
  });
  const [, appSlug, loadedFiles, provisioningToken] = await Promise.all([
    access.getInstallationId(targetRepository),
    access.getAppSlug(),
    loadRepositoryKit(join(context.projectRoot, "repo-kit")),
    readGitHubCliToken(),
  ]);
  if (config.flow.codeowners.length === 0) {
    throw new Error("FLOW_CODEOWNERS is required for CLI repository setup. Or add the repository from Flow Admin and enter reviewers there.");
  }
  const files = Object.fromEntries(Object.entries(loadedFiles).map(([path, content]) => [
    path,
    content.replaceAll("{{FLOW_CODEOWNERS}}", config.flow.codeowners.join(" ")),
  ]));
  const api = createGitHubTokenApi({ token: provisioningToken });
  const activationAuthorized = await verifyInstalledRepositoryKit({
    repository: targetRepository,
    api,
    files,
    codeowners: config.flow.codeowners,
  });
  const result = await provisionRepository({
    repository: targetRepository,
    api,
    files,
    secrets: {
      ...(config.providers.openaiApiKey ? { OPENAI_API_KEY: config.providers.openaiApiKey } : {}),
      ...(config.providers.anthropicApiKey ? { ANTHROPIC_API_KEY: config.providers.anthropicApiKey } : {}),
      ...(config.providers.cursorApiKey ? { CURSOR_API_KEY: config.providers.cursorApiKey } : {}),
    },
    variables: {
      FLOW_BOT_LOGIN: `${appSlug}[bot]`,
    },
    codeowners: config.flow.codeowners,
    checkIntegrationId: config.github.appId,
    activationAuthorized,
  });
  if (result.mergeGateInstalled) {
    context.stdout(`Installed Flow in ${targetRepository}@${result.defaultBranch} (${result.commitSha.slice(0, 12)}).`);
    context.stdout(`In Telegram, run /connect ${targetRepository}, send feedback, then /ship.`);
  } else {
    context.stdout(`Setup pull request is waiting for the repository's required approval: ${result.setupPullRequestUrl ?? targetRepository}`);
    context.stdout("After it is merged, run the same repo add command once to install the human merge gate.");
  }
  return 0;
};

const hostOnRailway = async (argv: string[], context: CliContext): Promise<number> => {
  let projectName: string | undefined;
  let workspace: string | undefined;
  let serviceName: string | undefined;
  let allowDirty = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    if (["--project", "--workspace", "--service"].includes(option ?? "")) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
      if (option === "--project") projectName = value;
      if (option === "--workspace") workspace = value;
      if (option === "--service") serviceName = value;
      index += 1;
      continue;
    }
    throw new Error("Usage: flow host railway [--project NAME] [--workspace NAME] [--service NAME] [--allow-dirty]");
  }
  await context.deployToRailway({
    env: context.env,
    projectRoot: context.projectRoot,
    ...(projectName ? { projectName } : {}),
    ...(workspace ? { workspace } : {}),
    ...(serviceName ? { serviceName } : {}),
    allowDirty,
    stdout: context.stdout,
  });
  return 0;
};

const safeError = (error: unknown, env: Record<string, string | undefined> = process.env): string => {
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map((issue) => String(issue.path[0] ?? "configuration")))];
    if (fields.includes("FLOW_CREDENTIAL_KEY")) {
      if (env.FLOW_CREDENTIAL_KEY?.trim()) return malformedCredentialKeyMessage;
      return "Configuration is incomplete: FLOW_CREDENTIAL_KEY must be 32 random bytes encoded as 43-character base64url. Run `flow init` to add the missing key.";
    }
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
    if (argv[0] === "init" || argv[0] === "setup") {
      if (argv[1] && argv[1] !== "--agent") throw new Error("Usage: flow init [--agent claude|codex|cursor]");
      if (argv[0] === "setup") context.stdout("`flow setup` is now `flow init`; continuing.");
      return await initialize(context, argv[1] === "--agent" ? argv[2] : undefined);
    }
    if (argv[0] === "doctor") return await doctor(context);
    if (argv[0] === "repo" && argv[1] === "add") return await addRepository(argv[2], context);
    if (argv[0] === "host" && argv[1] === "railway") return await hostOnRailway(argv.slice(2), context);
    context.stdout(help);
    return argv.length === 0 || argv[0] === "help" || argv[0] === "--help" ? 0 : 1;
  } catch (error) {
    context.stderr(safeError(error, context.env));
    return 1;
  }
};

const invokedPath = process.argv[1] ?? "";
if (isDirectCliInvocation(invokedPath, import.meta.url)) {
  try {
    process.loadEnvFile(join(projectRoot, ".env"));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code !== "ENOENT") throw error;
  }
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
