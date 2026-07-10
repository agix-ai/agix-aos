from fastapi import FastAPI

app = FastAPI(
    title="Agix API",
    version="0.1.0",
    description="Specialized Python services for the Agix platform.",
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/health")
def api_health() -> dict[str, str]:
    return {"status": "ok"}
