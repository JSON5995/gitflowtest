import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes, type AdminRouteOptions } from "./admin.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export type ServerDependencies = {
  isReady: () => boolean | Promise<boolean>;
  admin?: AdminRouteOptions;
};

export const buildServer = (dependencies: ServerDependencies): FastifyInstance => {
  const server = Fastify({ logger: false });

  server.get("/", async (_request, reply) => reply.redirect("/admin", 302));
  server.get("/health/live", async () => ({ ok: true, service: "flow", version }));
  server.get("/health/ready", async (_request, reply) => {
    const ready = await dependencies.isReady();
    return reply.code(ready ? 200 : 503).send({ ok: ready });
  });

  if (dependencies.admin) registerAdminRoutes(server, dependencies.admin);

  return server;
};
