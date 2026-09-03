import { describe, expect, it } from "vitest";
import { createCursorGateway } from "../src/cursor.js";

describe("Cursor Cloud Agent adapter", () => {
  it("creates an idempotent auto-PR agent through the v1 API", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        agent: { id: "bc-00000000-0000-0000-0000-000000000001", url: "https://cursor.com/agents/bc-1" },
        run: { id: "run-1", status: "CREATING" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const gateway = createCursorGateway({ apiKey: "cursor-key", fetch: fakeFetch });

    const result = await gateway.startBuild({
      repository: "acme/store",
      issueNumber: 17,
      prompt: "Implement issue #17",
      startingRef: "main",
      idempotencyKey: "acme/store#17",
    });

    expect(result).toEqual({
      agentId: "bc-00000000-0000-0000-0000-000000000001",
      runId: "run-1",
      url: "https://cursor.com/agents/bc-1",
    });
    expect(capturedUrl).toBe("https://api.cursor.com/v1/agents");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer cursor-key");
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ autoCreatePR: true, workOnCurrentBranch: false, mode: "agent" });
    expect(String(body.agentId)).toMatch(/^bc-[0-9a-f-]{36}$/);
    expect(body.repos).toEqual([{ url: "https://github.com/acme/store", startingRef: "main" }]);
  });
});
