# syntax=docker/dockerfile:1
# agix-coord-mcp — static Go binary in a distroless image.
# CGO disabled; the only runtime needs are CA certs + tzdata, which
# distroless/static provides. Final image is ~15MB → scale-to-zero friendly.
#
# Build context: services/ (NOT services/coord-mcp) — the module consumes the
# shared substrate services/go-common via a relative replace:
#
#   cd services && docker build -f coord-mcp/Dockerfile \
#     --build-arg VERSION=$(git rev-parse --short HEAD) -t agix-coord-mcp .
#
# (cloudbuild.yaml drives the same invocation for a hosted build.)

FROM golang:1.26 AS build
ARG VERSION=dev
WORKDIR /src
# module manifests first for layer-cached dependency downloads
COPY go-common/go.mod go-common/
COPY coord-mcp/go.mod coord-mcp/go.sum coord-mcp/
WORKDIR /src/coord-mcp
RUN go mod download
COPY go-common/ /src/go-common/
COPY coord-mcp/ /src/coord-mcp/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /coord-mcp ./cmd/coord-mcp

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /coord-mcp /coord-mcp
EXPOSE 8080
ENTRYPOINT ["/coord-mcp"]
