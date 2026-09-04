import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";

type CommandOptions = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
};

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<{ stdout: string }>;

type RailwayDeployOptions = {
  env: Record<string, string | undefined>;
  projectRoot: string;
  projectName?: string;
  workspace?: string;
  serviceName?: string;
  environmentName?: string;
  allowDirty?: boolean;
  execute?: CommandExecutor;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  stdout?: (message: string) => void;
};

export type RailwayDeployment = {
  publicUrl: string;
  adminUrl: string;
  healthUrl: string;
  githubWebhookUrl: string;
  telegramWebhookUrl: string;
};

const executeCommand: CommandExecutor = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 15 * 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stdout).length < 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
        return;
      }
      const safeCommand = `${command} ${args.slice(0, 3).join(" ")}`;
      const detail = options.input === undefined
        ? Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000)
        : "";
      reject(new Error(
        `${safeCommand} ${timedOut ? "timed out" : `failed with exit code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`,
      ));
    });
    child.stdin.end(options.input);
  });

const parseJson = (stdout: string, source: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${source} returned invalid JSON`, { cause: error });
  }
};

const recordsIn = (value: unknown, records: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    for (const item of value) recordsIn(item, records);
    return records;
  }
  if (typeof value !== "object" || value === null) return records;
  const record = value as Record<string, unknown>;
  records.push(record);
  for (const child of Object.values(record)) recordsIn(child, records);
  return records;
};

const stringsIn = (value: unknown, values: string[] = []): string[] => {
  if (typeof value === "string") {
    values.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, values);
  } else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) stringsIn(child, values);
  }
  return values;
};

const entityNamed = (value: unknown, name: string): Record<string, unknown> | null =>
  recordsIn(value).find((record) => record.name === name) ?? null;

const railwayDomain = (value: unknown): string | null => {
  const candidate = stringsIn(value).find((entry) => {
    const host = entry.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.up\.railway\.app$/i.test(host);
  });
  return candidate?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
};

const hasMountedDataVolume = (value: unknown): boolean =>
  recordsIn(value).some((record) =>
    Object.entries(record).some(([key, entry]) =>
      /mount.*path|mountPath/i.test(key) && entry === "/data"));

const hasAnyVolume = (value: unknown): boolean =>
  recordsIn(value).some((record) =>
    Object.keys(record).some((key) => /volumeId|mount.*path|mountPath/i.test(key)));

const hostedVariables = (
  env: Record<string, string | undefined>,
  publicUrl: string,
): Record<string, string> => {
  const config = loadConfig({
    ...env,
    NODE_ENV: "production",
    PUBLIC_URL: publicUrl,
    PORT: "3000",
    DATABASE_PATH: "/data/flow.db",
  });
  const values: Record<string, string> = {
    NODE_ENV: "production",
    PUBLIC_URL: publicUrl,
    PORT: "3000",
    DATABASE_PATH: "/data/flow.db",
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN!,
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET!,
    TELEGRAM_ADMIN_IDS: env.TELEGRAM_ADMIN_IDS!,
    GITHUB_APP_ID: env.GITHUB_APP_ID!,
    GITHUB_APP_PRIVATE_KEY_BASE64: env.GITHUB_APP_PRIVATE_KEY_BASE64!,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET!,
    OPENAI_API_KEY: env.OPENAI_API_KEY!,
    FLOW_BUILDER: config.flow.builder,
    FLOW_REVIEWER: config.flow.reviewer,
    FLOW_CODEOWNERS: config.flow.codeowners.join(","),
    FLOW_MAX_FIX_ROUNDS: String(config.flow.maxFixRounds),
    FLOW_ADMIN_USERNAME: config.admin.username,
    FLOW_ADMIN_PASSWORD: config.admin.password,
    RAILWAY_RUN_UID: "0",
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
    RAILWAY_HEALTHCHECK_TIMEOUT_SEC: "300",
  };
  for (const name of ["ANTHROPIC_API_KEY", "CURSOR_API_KEY", "FLOW_AGENT"] as const) {
    const value = env[name]?.trim();
    if (value) values[name] = value;
  }
  return values;
};

const waitForReady = async (
  publicUrl: string,
  request: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request(`${publicUrl}/health/ready`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json() as { ok?: unknown };
      if (response.ok && body.ok === true) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(3_000);
  }
  throw new Error(`Railway deployment did not become ready at ${publicUrl}`, { cause: lastError });
};

export const deployToRailway = async (options: RailwayDeployOptions): Promise<RailwayDeployment> => {
  const execute = options.execute ?? executeCommand;
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const write = options.stdout ?? console.log;
  const projectName = options.projectName ?? "flow";
  const serviceName = options.serviceName ?? "flow";
  const environmentName = options.environmentName ?? "production";
  const cwd = options.projectRoot;

  // Validate every required application value before creating hosted resources.
  hostedVariables(options.env, "https://flow.invalid");
  const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
  if (!gitignore.split(/\r?\n/).includes(".env")) {
    throw new Error("Refusing to deploy because .env is not ignored by Git");
  }
  const gitStatus = await execute("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
  if (gitStatus.stdout.trim() && !options.allowDirty) {
    throw new Error("Refusing to deploy uncommitted code. Commit it or rerun with --allow-dirty.");
  }

  write("Checking Railway access…");
  try {
    await execute("railway", ["whoami", "--json"], { cwd, timeoutMs: 30_000 });
  } catch (error) {
    throw new Error("Railway login is required. Run `railway login` once, then rerun this command.", { cause: error });
  }

  let linked = true;
  try {
    await execute("railway", ["status", "--json"], { cwd, timeoutMs: 30_000 });
  } catch {
    linked = false;
  }
  if (!linked) {
    const projectsOutput = await execute("railway", ["list", "--json"], { cwd, timeoutMs: 30_000 });
    const projects = parseJson(projectsOutput.stdout, "railway list");
    const existingProject = entityNamed(projects, projectName);
    if (existingProject) {
      const selector = typeof existingProject.id === "string" ? existingProject.id : projectName;
      write(`Linking existing Railway project ${projectName}…`);
      await execute("railway", ["link", "--project", selector, "--environment", environmentName, "--json"], {
        cwd,
        timeoutMs: 30_000,
      });
    } else {
      write(`Creating Railway project ${projectName}…`);
      await execute("railway", [
        "init",
        "--name",
        projectName,
        ...(options.workspace ? ["--workspace", options.workspace] : []),
        "--json",
      ], { cwd, timeoutMs: 60_000 });
    }
  }

  const servicesOutput = await execute("railway", ["service", "list", "--json"], { cwd, timeoutMs: 30_000 });
  const services = parseJson(servicesOutput.stdout, "railway service list");
  if (!entityNamed(services, serviceName)) {
    write(`Creating Railway service ${serviceName}…`);
    await execute("railway", ["add", "--service", serviceName, "--json"], { cwd, timeoutMs: 60_000 });
  }
  await execute("railway", ["service", "link", serviceName], { cwd, timeoutMs: 30_000 });

  write("Configuring health and restart policy…");
  await execute("railway", [
    "environment",
    "edit",
    "--environment",
    environmentName,
    "--service-config",
    serviceName,
    "deploy.healthcheckPath",
    "/health/ready",
    "--service-config",
    serviceName,
    "deploy.healthcheckTimeout",
    "300",
    "--service-config",
    serviceName,
    "deploy.restartPolicyType",
    "ON_FAILURE",
    "--service-config",
    serviceName,
    "deploy.restartPolicyMaxRetries",
    "10",
    "--message",
    "Configure Flow service",
    "--json",
  ], { cwd, timeoutMs: 60_000 });

  const volumeOutput = await execute("railway", [
    "volume", "list", "--service", serviceName, "--environment", environmentName, "--json",
  ], { cwd, timeoutMs: 30_000 });
  const volumes = parseJson(volumeOutput.stdout, "railway volume list");
  if (!hasMountedDataVolume(volumes)) {
    if (hasAnyVolume(volumes)) {
      throw new Error("The Railway service already has a volume that is not mounted at /data; no changes were made.");
    }
    write("Creating persistent /data volume…");
    await execute("railway", [
      "volume", "add", "--service", serviceName, "--environment", environmentName, "--mount-path", "/data", "--json",
    ], { cwd, timeoutMs: 60_000 });
  }

  const domainsOutput = await execute("railway", [
    "domain", "list", "--service", serviceName, "--environment", environmentName, "--json",
  ], { cwd, timeoutMs: 30_000 });
  let domain = railwayDomain(parseJson(domainsOutput.stdout, "railway domain list"));
  if (!domain) {
    write("Creating public Railway domain…");
    const createdDomain = await execute("railway", [
      "domain", "--service", serviceName, "--environment", environmentName, "--port", "3000", "--json",
    ], { cwd, timeoutMs: 60_000 });
    domain = railwayDomain(parseJson(createdDomain.stdout, "railway domain"));
  }
  if (!domain) throw new Error("Railway did not return a public service domain");
  const publicUrl = `https://${domain}`;

  write("Uploading Flow configuration securely…");
  for (const [key, value] of Object.entries(hostedVariables(options.env, publicUrl))) {
    await execute("railway", [
      "variable", "set", key, "--stdin", "--skip-deploys", "--service", serviceName,
      "--environment", environmentName, "--json",
    ], { cwd, input: value, timeoutMs: 30_000 });
  }

  write("Deploying Flow to Railway…");
  await execute("railway", [
    "up", "--service", serviceName, "--environment", environmentName, "--json",
  ], { cwd, timeoutMs: 15 * 60_000 });
  write("Verifying the live service…");
  await waitForReady(publicUrl, request, sleep);

  const result = {
    publicUrl,
    adminUrl: `${publicUrl}/admin`,
    healthUrl: `${publicUrl}/health/ready`,
    githubWebhookUrl: `${publicUrl}/webhooks/github`,
    telegramWebhookUrl: `${publicUrl}/webhooks/telegram`,
  };
  write([
    "Flow is live.",
    `Admin: ${result.adminUrl}`,
    `Health: ${result.healthUrl}`,
    `GitHub webhook: ${result.githubWebhookUrl}`,
    `Telegram webhook: ${result.telegramWebhookUrl}`,
  ].join("\n"));
  return result;
};
