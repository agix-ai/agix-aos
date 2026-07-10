# api-python

Starter Python API service intended for FastAPI-based platform services.

## Quick Start (local)

1. Create virtual environment.
2. Install dependencies from `requirements.txt` (or use `pyproject.toml` with `uv`).
3. Run `uvicorn app.main:app --reload --port 8000`.

## Initial Endpoints

- `GET /health` and `GET /api/health` for local and Cloud Run readiness checks.

## Container build

A production-ready `Dockerfile` is provided. It targets Cloud Run and
respects the `$PORT` environment variable.

```bash
docker build -t agix-api:local services/api-python
docker run --rm -p 8080:8080 agix-api:local
curl http://localhost:8080/health
```

## Deployment

CI/CD is configured in `.github/workflows/deploy-backend.yml` and uses
Cloud Build + Cloud Run. See `docs/workflows/CI_CD_SETUP.md` for the
one-time GCP setup required before deploys can run.
