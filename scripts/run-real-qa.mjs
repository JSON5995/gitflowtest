#!/usr/bin/env node
/* global AbortSignal, Buffer, URL, document, fetch, getComputedStyle, localStorage, process, window */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const fail = (message, status = 2) => {
  process.stderr.write(`${message}\n`);
  process.exit(status);
};

const flagValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const configPath = flagValue("--config", ".flow/qa.json");
if (!configPath) fail("--config requires a path");
const featureConfigPath = flagValue("--feature-config", undefined);

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  fail(`Cannot read real QA contract: ${error instanceof Error ? error.message : "invalid JSON"}`);
}

let featureConfig;
if (featureConfigPath) {
  try {
    const featureConfigText = await readFile(featureConfigPath, "utf8");
    if (Buffer.byteLength(featureConfigText) > 64 * 1024) fail("Feature QA overlay exceeds 65536 bytes");
    featureConfig = JSON.parse(featureConfigText);
  } catch (error) {
    fail(`Cannot read feature QA overlay: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

const isHttpUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const invalid = [];
const allowedCredentialNames = new Set(["FLOW_QA_EMAIL", "FLOW_QA_PASSWORD", "FLOW_QA_TOKEN"]);
const safeStorageKey = /^[A-Za-z0-9._:-]{1,200}$/;
const isSameOriginPath = (value) => isText(value)
  && value.startsWith("/")
  && !value.startsWith("//")
  && !value.includes("\\")
  && !/[\r\n]/.test(value);
const validateCredentialMapping = (mapping, label) => {
  if (mapping === undefined) return;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    invalid.push(`${label} must map header or variable names to approved QA credentials`);
    return;
  }
  for (const [name, envName] of Object.entries(mapping)) {
    if (!isText(name) || !isText(envName) || !allowedCredentialNames.has(envName)) {
      invalid.push(`${label} cannot read ${String(envName)}; only FLOW_QA_EMAIL, FLOW_QA_PASSWORD, and FLOW_QA_TOKEN are allowed`);
    }
  }
};
if (featureConfig !== undefined) {
  if (featureConfig?.version !== 1) invalid.push("feature QA overlay version must be 1");
  const probes = featureConfig?.apiProbes;
  const journeys = featureConfig?.journeys;
  if (!Array.isArray(probes)) invalid.push("feature QA overlay apiProbes must be an array");
  if (!Array.isArray(journeys)) invalid.push("feature QA overlay journeys must be an array");
  if (Array.isArray(probes) && Array.isArray(journeys) && probes.length + journeys.length === 0) {
    invalid.push("feature QA overlay must contain at least one API probe or browser journey");
  }
  if (Array.isArray(probes) && probes.length > 20) invalid.push("feature QA overlay supports at most 20 API probes");
  for (const [index, probe] of Array.isArray(probes) ? probes.entries() : []) {
    if (!isText(probe?.name) || !isSameOriginPath(probe?.path) || !Number.isInteger(probe?.status)) {
      invalid.push(`feature apiProbes[${index}] requires a name, same-origin path beginning with /, and integer status`);
    }
    if (probe?.method !== undefined && !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(probe.method)) {
      invalid.push(`feature apiProbes[${index}] uses an unsupported HTTP method`);
    }
    validateCredentialMapping(probe?.headersFromEnv, `feature apiProbes[${index}].headersFromEnv`);
  }
  if (Array.isArray(journeys) && journeys.length > 20) invalid.push("feature QA overlay supports at most 20 browser journeys");
  for (const [journeyIndex, journey] of Array.isArray(journeys) ? journeys.entries() : []) {
    if (!isText(journey?.name) || !isSameOriginPath(journey?.startPath)) {
      invalid.push(`feature journeys[${journeyIndex}] requires a name and same-origin startPath beginning with /`);
    }
    if (!Array.isArray(journey?.actions) || !Array.isArray(journey?.assertions) || journey.assertions.length === 0) {
      invalid.push(`feature journeys[${journeyIndex}] requires actions and at least one assertion`);
      continue;
    }
    if (journey.actions.length > 30 || journey.assertions.length > 30) {
      invalid.push(`feature journeys[${journeyIndex}] exceeds the 30-step safety limit`);
    }
    for (const [actionIndex, action] of journey.actions.entries()) {
      const label = `feature journeys[${journeyIndex}].actions[${actionIndex}]`;
      if (action?.type === "goto") {
        if (!isSameOriginPath(action.path)) invalid.push(`${label} requires a same-origin path beginning with /`);
      } else if (action?.type === "click") {
        if (!isText(action.selector)) invalid.push(`${label} requires a selector`);
      } else if (action?.type === "fill") {
        if (!isText(action.selector)) invalid.push(`${label} requires a selector`);
        if (!allowedCredentialNames.has(action.valueFromEnv)) invalid.push(`${label} cannot read ${String(action.valueFromEnv)}`);
      } else if (action?.type === "wait") {
        if (!isText(action.selector) || (action.state !== undefined && !["visible", "hidden", "attached", "detached"].includes(action.state))) {
          invalid.push(`${label} requires a selector and a supported state`);
        }
      } else if (action?.type === "clearLocalStorage") {
        if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 20 ||
          action.keys.some((key) => typeof key !== "string" || !safeStorageKey.test(key))) {
          invalid.push(`${label} requires 1 to 20 safe localStorage keys`);
        }
      } else if (action?.type === "reload") {
        // A reload is deliberately parameter-free so feature overlays cannot change origin or browser policy.
      } else {
        invalid.push(`${label} uses an unsupported deterministic action type`);
      }
    }
    for (const [assertionIndex, assertion] of journey.assertions.entries()) {
      const label = `feature journeys[${journeyIndex}].assertions[${assertionIndex}]`;
      const valid = assertion?.type === "visible"
        ? isText(assertion.selector)
        : assertion?.type === "text"
          ? isText(assertion.selector) && isText(assertion.contains)
          : assertion?.type === "urlContains" && isText(assertion.contains);
      if (!valid) invalid.push(`${label} is not a supported assertion`);
    }
  }
  if (invalid.length === 0) {
    config = {
      ...config,
      apiProbes: [...config.apiProbes, ...featureConfig.apiProbes],
      journeys: [...config.journeys, ...featureConfig.journeys],
    };
  }
}
if (config?.version !== 1) invalid.push("version must be 1");
if (!isHttpUrl(config?.baseUrl)) invalid.push("baseUrl must be an HTTP(S) URL");
if (!Array.isArray(config?.apiProbes) || config.apiProbes.length === 0) {
  invalid.push("apiProbes must contain at least one real endpoint probe");
} else if (config.apiProbes.some((probe) =>
  !isText(probe?.name) || !isText(probe?.path) || !Number.isInteger(probe?.status)
)) {
  invalid.push("every apiProbes entry requires name, path, and integer status");
}
if (!Array.isArray(config?.viewports) || !["mobile", "desktop"].every((name) =>
  config.viewports.some((viewport) =>
    viewport?.name === name && Number.isInteger(viewport.width) && Number.isInteger(viewport.height)
  )
)) invalid.push("viewports must include integer-sized mobile and desktop entries");
if (!Array.isArray(config?.journeys) || config.journeys.length === 0) {
  invalid.push("journeys must contain at least one real browser journey");
} else if (config.journeys.some((journey) =>
  !isText(journey?.name) || !isText(journey?.startPath) ||
  !Array.isArray(journey?.actions) || !Array.isArray(journey?.assertions) || journey.assertions.length === 0
)) {
  invalid.push("every journey requires name, startPath, actions, and assertions");
}
if (!Array.isArray(config?.design?.allowedFonts) || config.design.allowedFonts.length === 0) {
  invalid.push("design.allowedFonts must list the project font families");
}
if (!Number.isInteger(config?.design?.minInteractiveSize) || config.design.minInteractiveSize < 24) {
  invalid.push("design.minInteractiveSize must be an integer of at least 24");
}
if (!Array.isArray(config?.design?.requiredCssVariables)) {
  invalid.push("design.requiredCssVariables must be an array");
}
if (invalid.length > 0) fail(`Invalid real QA contract:\n- ${invalid.join("\n- ")}`);
if (process.argv.includes("--validate")) {
  process.stdout.write(featureConfigPath
    ? "Real QA contract and feature QA overlay are valid.\n"
    : "Real QA contract is valid.\n");
  process.exit(0);
}

const baseUrl = process.env.FLOW_QA_BASE_URL || config.baseUrl;
if (!isHttpUrl(baseUrl)) fail("FLOW_QA_BASE_URL must be an HTTP(S) URL");
const evidenceDirectory = resolve(flagValue("--evidence", ".flow/evidence"));
await mkdir(evidenceDirectory, { recursive: true });

const urlFor = (path) => new URL(path, baseUrl).toString();
const apiEvidence = [];
for (const probe of config.apiProbes) {
  const headers = Object.fromEntries(Object.entries(probe.headersFromEnv ?? {}).map(([name, envName]) => {
    const value = process.env[envName];
    if (!value) fail(`Missing QA credential ${envName} required by API probe ${probe.name}`);
    return [name, value];
  }));
  const response = await fetch(urlFor(probe.path), {
    method: probe.method ?? "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (response.status !== probe.status) {
    fail(`API probe ${probe.name} expected ${probe.status}, received ${response.status}`, 1);
  }
  if (probe.bodyContains && !body.includes(probe.bodyContains)) {
    fail(`API probe ${probe.name} did not contain its required response text`, 1);
  }
  apiEvidence.push({ name: probe.name, method: probe.method ?? "GET", url: urlFor(probe.path), status: response.status });
}

const provider = process.env.FLOW_QA_PROVIDER || "claude";
const needsSemanticActions = config.journeys.some((journey) =>
  journey.actions.some((action) => action?.type === "semantic"));
if (provider === "cursor" && needsSemanticActions) {
  fail("Cursor QA requires deterministic selector actions; semantic Stagehand actions support Claude or Codex", 1);
}

let stagehand;
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
if (needsSemanticActions) {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const configuredModel = process.env.FLOW_QA_MODEL;
  const stagehandModel = configuredModel
    ? configuredModel.includes("/") ? configuredModel : `${provider === "codex" ? "openai" : "anthropic"}/${configuredModel}`
    : provider === "codex" ? "openai/gpt-5" : "anthropic/claude-sonnet-4-6";
  stagehand = new Stagehand({
    env: "LOCAL",
    model: stagehandModel,
    verbose: 0,
    localBrowserLaunchOptions: { headless: true },
  });
  await stagehand.init();
}

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const resolveVariables = (mapping, actionName) => Object.fromEntries(
  Object.entries(mapping ?? {}).map(([name, envName]) => {
    const value = process.env[envName];
    if (!value) fail(`Missing QA credential ${envName} required by ${actionName}`);
    return [name, value];
  }),
);

const runAction = async (action, journeyName) => {
  if (action.type === "goto") {
    await page.goto(urlFor(action.path), { waitUntil: "domcontentloaded" });
    return;
  }
  if (action.type === "click") {
    await page.locator(action.selector).click();
    return;
  }
  if (action.type === "fill") {
    const value = process.env[action.valueFromEnv];
    if (!value) fail(`Missing QA credential ${action.valueFromEnv} required by ${journeyName}`);
    await page.locator(action.selector).fill(value);
    return;
  }
  if (action.type === "wait") {
    if (!await page.waitForSelector(action.selector, { state: action.state ?? "visible", timeout: 15_000 })) {
      throw new Error(`Timed out waiting for ${action.selector}`);
    }
    return;
  }
  if (action.type === "clearLocalStorage") {
    await page.evaluate((keys) => keys.forEach((key) => localStorage.removeItem(key)), action.keys);
    return;
  }
  if (action.type === "reload") {
    await page.reload({ waitUntil: "domcontentloaded" });
    return;
  }
  if (action.type === "semantic" && stagehand) {
    const variables = resolveVariables(action.variablesFromEnv, journeyName);
    const observedVariables = Object.fromEntries(Object.entries(variables).map(([name, value]) =>
      [name, { value, description: `Secret QA value for ${name}` }]));
    const candidates = await stagehand.observe(action.instruction, { page, variables: observedVariables });
    const candidate = candidates.find((item) => item.method === action.expectedMethod);
    if (!candidate) throw new Error(`Stagehand could not validate ${action.expectedMethod} for ${journeyName}`);
    await stagehand.act(candidate, { page, variables });
    return;
  }
  throw new Error(`Unsupported QA action type: ${String(action.type)}`);
};

const assertJourney = async (assertion, journeyName) => {
  if (assertion.type === "visible") {
    if (!await page.waitForSelector(assertion.selector, { state: "visible", timeout: 15_000 })) {
      throw new Error(`${journeyName}: ${assertion.selector} is not visible`);
    }
    return;
  }
  if (assertion.type === "text") {
    const actual = await page.evaluate(
      ({ selector }) => document.querySelector(selector)?.textContent ?? "",
      { selector: assertion.selector },
    );
    if (!actual.includes(assertion.contains)) throw new Error(`${journeyName}: expected text was not found`);
    return;
  }
  if (assertion.type === "urlContains") {
    if (!page.url().includes(assertion.contains)) throw new Error(`${journeyName}: URL assertion failed`);
    return;
  }
  throw new Error(`Unsupported QA assertion type: ${String(assertion.type)}`);
};

const browserEvidence = [];
try {
  for (const viewport of config.viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const journey of config.journeys) {
      await page.goto(urlFor(journey.startPath), { waitUntil: "domcontentloaded" });
      for (const action of journey.actions) await runAction(action, journey.name);
      for (const assertion of journey.assertions) await assertJourney(assertion, journey.name);

      const audit = await page.evaluate(({ allowedFonts, requiredCssVariables, minInteractiveSize }) => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const elements = [...document.querySelectorAll("body *")].filter(visible);
        const normalizedFonts = allowedFonts.map((font) => font.toLowerCase().replace(/["']/g, ""));
        const unexpectedFonts = [...new Set(elements.map((element) => getComputedStyle(element).fontFamily)
          .filter((family) => !normalizedFonts.some((allowed) => family.toLowerCase().replace(/["']/g, "").includes(allowed))))];
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 1
          ? { scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }
          : null;
        const undersizedControls = [...document.querySelectorAll("button,input,select,textarea,[role='button']")]
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { tag: element.tagName.toLowerCase(), text: (element.textContent ?? "").trim().slice(0, 80), width: rect.width, height: rect.height };
          })
          .filter(({ width, height }) => width < minInteractiveSize || height < minInteractiveSize);
        const root = getComputedStyle(document.documentElement);
        const missingCssVariables = requiredCssVariables.filter((name) => !root.getPropertyValue(name).trim());
        return { overflow, unexpectedFonts, undersizedControls, missingCssVariables };
      }, config.design);
      if (audit.overflow) throw new Error(`${journey.name} has horizontal overflow at ${viewport.name}`);
      if (audit.unexpectedFonts.length) throw new Error(`${journey.name} uses fonts outside the design contract: ${audit.unexpectedFonts.join(", ")}`);
      if (audit.undersizedControls.length) throw new Error(`${journey.name} has undersized interactive controls at ${viewport.name}`);
      if (audit.missingCssVariables.length) throw new Error(`${journey.name} is missing required design tokens: ${audit.missingCssVariables.join(", ")}`);

      const screenshot = `${slug(journey.name)}-${slug(viewport.name)}.png`;
      await page.screenshot({ path: resolve(evidenceDirectory, screenshot), fullPage: true, animations: "disabled" });
      browserEvidence.push({ journey: journey.name, viewport, screenshot, audit });
    }
  }
} finally {
  if (stagehand) await stagehand.close();
  await browser.close();
}

await writeFile(resolve(evidenceDirectory, "report.json"), `${JSON.stringify({ apiEvidence, browserEvidence }, null, 2)}\n`);
process.stdout.write(`Real QA passed ${apiEvidence.length} API probes and ${browserEvidence.length} browser views.\n`);
