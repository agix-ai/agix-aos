# syntax=docker/dockerfile:1
# agix-core — the Agix orchestration core + report-home sender as a static Go
# binary in a distroless image: the cloud-native "bee in a box". A drone that
# runs a turn (forage → work → return/feed) and then reports home across the
# apiary by POSTing a cross-hive Envelope to a hive's report-home gateway.
#
# CGO is DISABLED and the build is fully static. core's only non-stdlib
# dependency is modernc.org/sqlite, which is pure Go (SQLite compiled to Go), so
# it links CGO-free under CGO_ENABLED=0 — no build tag needed. distroless/static
# provides the CA certs the report-home HTTPS POST needs; nothing else at
# runtime. Final image is ~20MB → scale-to-zero friendly.
#
# Build context: core/ (the module root). core has NO relative replaces, so it
# resolves standalone; the nested orchestrator/adk module (heavy Google-Cloud
# deps) is NEVER pulled because the build targets only ./cmd/agix-core:
#
#   docker build -f core/Dockerfile \
#     --build-arg VERSION=$(git rev-parse --short HEAD) -t agix-core core/
#
# (cloudbuild.yaml can drive the same invocation for a hosted build.)
#
# Runtime is parameterized by environment:
#   HIVE / AGIX_HIVE    the reporting hive name              (default: agix)
#   AGIX_HOME_ENDPOINT  report-home gateway URL (POST /apiary/report) — the flag
#                       fallback; set it and the default CMD reports home
#   AGIX_HIVE_KEY       per-hive bearer key for the report-home POST
#   ANTHROPIC_API_KEY   live provider key (only when --provider anthropic)
#
# The default CMD is a keyless, zero-cost mock run that reports home whenever
# AGIX_HOME_ENDPOINT + AGIX_HIVE_KEY are present — the swarm-in-a-box smoke test.
# Override CMD for a real task, e.g.:
#   docker run -e HIVE=agix -e AGIX_HOME_ENDPOINT=https://gw/apiary/report \
#     -e AGIX_HIVE_KEY=$KEY -e ANTHROPIC_API_KEY=$AK agix-core \
#     run "summarize the hive" --provider anthropic

FROM golang:1.26 AS build
ARG VERSION=dev
WORKDIR /src
# module manifests first for layer-cached dependency downloads
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /agix-core ./cmd/agix-core

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /agix-core /agix-core
# /tmp is writable by the distroless nonroot user; the runtime audit ledger is
# written under ./.agix-core/ relative to CWD, so anchor CWD somewhere writable.
WORKDIR /tmp
ENTRYPOINT ["/agix-core"]
CMD ["run", "reporting home from a cloud drone", "--provider", "mock"]
