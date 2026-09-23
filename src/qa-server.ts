import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildServer } from "./server.js";

export const buildQaServer = () => buildServer({ isReady: () => true });

export const main = async (): Promise<void> => {
  const server = buildQaServer();
  const rawPort = process.env.PORT ?? "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const address = await server.listen({ host: "0.0.0.0", port });
  console.info(`Flow QA server listening at ${address}`);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
