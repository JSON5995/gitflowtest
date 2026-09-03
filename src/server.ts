import Fastify, { type FastifyInstance } from "fastify";

export type ServerDependencies = {
  isReady: () => boolean | Promise<boolean>;
};

export const buildServer = (dependencies: ServerDependencies): FastifyInstance => {
  const server = Fastify({ logger: false });

  server.get("/health/live", async () => ({ ok: true }));
  server.get("/health/ready", async (_request, reply) => {
    const ready = await dependencies.isReady();
    return reply.code(ready ? 200 : 503).send({ ok: ready });
  });

  return server;
};
