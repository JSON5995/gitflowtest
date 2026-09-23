# Docker specialist guidance

Skill version: 1
Evidence: Dockerfile

- Preserve multi-stage build boundaries, non-root runtime behavior, health checks, and the existing container entrypoint.
- Never bake credentials into an image layer or copy local environment files into the build context.
