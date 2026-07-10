# Multi-stage Dockerfile for the Agix FastAPI service.
# Designed for Cloud Run: respects the $PORT environment variable and runs
# uvicorn as a non-root user with a minimal Python base image.

ARG PYTHON_VERSION=3.11-slim

FROM python:${PYTHON_VERSION} AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install dependencies first to leverage Docker layer caching.
COPY requirements.txt ./
RUN pip install --upgrade pip \
 && pip install -r requirements.txt

# Copy application source.
COPY app ./app

# Run as non-root.
RUN useradd --create-home --shell /bin/bash appuser \
 && chown -R appuser:appuser /app
USER appuser

# Cloud Run injects PORT (default 8080). Bind 0.0.0.0 so it's reachable.
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
