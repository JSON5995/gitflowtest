import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("hello route", () => {
  it("responds with 200 and standalone HTML containing the heading, button, and count", async () => {
    const server = buildServer({ isReady: () => true });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/hello" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<!DOCTYPE html>");
    expect(response.body).toContain("<h1>Hello World</h1>");
    expect(response.body).toContain('id="hello-increment"');
    expect(response.body).toContain(">Increase count<");
    expect(response.body).toContain('id="hello-count"');
    expect(response.body).toContain('data-testid="hello-count"');
  });

  it("initializes the count element to 0 and wires click handling to localStorage under flowHelloCount", async () => {
    const server = buildServer({ isReady: () => true });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/hello" });

    expect(response.body).toContain('<p id="hello-count" data-testid="hello-count">0</p>');
    expect(response.body).toContain("localStorage.getItem(STORAGE_KEY)");
    expect(response.body).toContain("localStorage.setItem(STORAGE_KEY, String(count))");
    expect(response.body).toContain('var STORAGE_KEY = "flowHelloCount";');
    expect(response.body).toContain("count += 1;");
  });

  it("never mutates saved state from a query string, so the server response is identical regardless of query", async () => {
    const server = buildServer({ isReady: () => true });
    servers.push(server);

    const plain = await server.inject({ method: "GET", url: "/hello" });
    const withQuery = await server.inject({ method: "GET", url: "/hello?reset=1" });

    expect(withQuery.statusCode).toBe(200);
    expect(withQuery.body).toBe(plain.body);
    expect(withQuery.body).not.toContain("reset");
  });

  it("client script reads the saved count on load and persists increments, with no query-string reset path", async () => {
    const server = buildServer({ isReady: () => true });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/hello" });
    const script = response.body.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
    if (!script) throw new Error("Hello page script was not found");

    const storedValues = new Map<string, string>();
    const loadPage = () => {
      const count = { textContent: "" };
      let clickHandler: (() => void) | undefined;
      const button = {
        addEventListener: (event: string, handler: () => void) => {
          if (event === "click") clickHandler = handler;
        },
      };

      runInNewContext(script, {
        Number,
        String,
        parseInt,
        document: { getElementById: (id: string) => id === "hello-count" ? count : button },
        window: {
          localStorage: {
            getItem: (key: string) => storedValues.get(key) ?? null,
            setItem: (key: string, value: string) => storedValues.set(key, value),
            removeItem: (key: string) => storedValues.delete(key),
          },
        },
      });

      return { count, click: () => clickHandler?.() };
    };

    const initialLoad = loadPage();
    expect(initialLoad.count.textContent).toBe("0");
    initialLoad.click();
    initialLoad.click();
    expect(initialLoad.count.textContent).toBe("2");
    expect(storedValues.get("flowHelloCount")).toBe("2");

    const reloadedPage = loadPage();
    expect(reloadedPage.count.textContent).toBe("2");
  });

  it("does not change any existing route", async () => {
    const server = buildServer({ isReady: () => true });
    servers.push(server);

    const root = await server.inject({ method: "GET", url: "/" });
    const live = await server.inject({ method: "GET", url: "/health/live" });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("<h1>Flow QA</h1>");
    expect(live.statusCode).toBe(200);
  });
});

describe("hello feature QA overlay", () => {
  it("is a valid feature QA overlay whose real-browser journey clears state, reloads, and checks the accessible button name", () => {
    const overlay = JSON.parse(readFileSync("flow.qa.json", "utf8")) as {
      version: number;
      apiProbes: unknown[];
      journeys: Array<{
        name: string;
        actions: Array<{ type: string; keys?: string[] }>;
        assertions: Array<{ type: string; selector?: string; contains?: string }>;
      }>;
    };

    expect(overlay.version).toBe(1);
    expect(overlay.apiProbes.length).toBeGreaterThan(0);
    expect(overlay.journeys.length).toBeGreaterThan(0);

    const persistenceJourney = overlay.journeys.find((journey) =>
      journey.name === "hello counter increments and persists across reload");
    expect(persistenceJourney?.actions).toContainEqual({ type: "clearLocalStorage", keys: ["flowHelloCount"] });
    expect(persistenceJourney?.actions.filter((action) => action.type === "reload").length).toBe(2);
    expect(persistenceJourney?.actions.some((action) => action.type === "goto")).toBe(false);
    expect(persistenceJourney?.assertions).toContainEqual({ type: "text", selector: "#hello-count", contains: "2" });

    const immediateUpdateJourney = overlay.journeys.find((journey) =>
      journey.name === "hello counter updates immediately on click without a reload");
    expect(immediateUpdateJourney?.actions).toContainEqual({ type: "clearLocalStorage", keys: ["flowHelloCount"] });
    expect(immediateUpdateJourney?.actions.filter((action) => action.type === "click").length).toBe(2);
    expect(immediateUpdateJourney?.actions.filter((action) => action.type === "reload").length).toBe(1);
    expect(immediateUpdateJourney?.assertions).toContainEqual({ type: "text", selector: "#hello-count", contains: "2" });

    const initialJourney = overlay.journeys.find((journey) =>
      journey.name === "hello counter starts at zero with an accessible button");
    expect(initialJourney?.assertions).toContainEqual({
      type: "text",
      selector: "#hello-increment",
      contains: "Increase count",
    });

    const result = spawnSync(process.execPath, [
      resolve("scripts/run-real-qa.mjs"),
      "--validate",
      "--config",
      resolve(".flow/qa.json"),
      "--feature-config",
      resolve("flow.qa.json"),
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("valid");
  });
});
