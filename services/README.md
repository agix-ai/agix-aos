# services

Backend and automation service runtimes.

Current service:

- `api-python/` - FastAPI baseline for specialized Python services (ML/CV, heavy compute, domain workloads)

Guidance:

- Keep the public website and primary platform shell in Next.js (`apps/website`).
- Use `services/api-python` where Python-specific capabilities provide clear value.
