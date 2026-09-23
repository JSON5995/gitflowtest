import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes, type AdminRouteOptions } from "./admin.js";

export type ServerDependencies = {
  isReady: () => boolean | Promise<boolean>;
  admin?: AdminRouteOptions;
};

export const buildServer = (dependencies: ServerDependencies): FastifyInstance => {
  const server = Fastify({ logger: false });

  server.get("/", async (_request, reply) => dependencies.admin
    ? reply.redirect("/admin", 302)
    : reply.type("text/html; charset=utf-8").send("<!doctype html><html lang=\"en\"><title>Flow QA</title><body><main><h1>Flow QA</h1></main></body></html>"));
  server.get("/health/live", async () => ({ ok: true }));
  server.get("/health/ready", async (_request, reply) => {
    const ready = await dependencies.isReady();
    return reply.code(ready ? 200 : 503).send({ ok: ready });
  });

  if (dependencies.admin) registerAdminRoutes(server, dependencies.admin);

  return server;
};
