# syntax=docker/dockerfile:1
# agix-hive-gateway — static Go binary in a distroless image.
# CGO disabled; the only runtime needs are CA certs + tzdata, which
# distroless/static provides. Final image is ~15MB → scale-to-zero friendly.
#
# Build context: services/ (NOT services/hive-gateway) — the module consumes the
# shared substrate services/go-common via a relative replace:
#
#   docker build -f services/hive-gateway/Dockerfile \
#     --build-arg VERSION=$(git rev-parse --short HEAD) -t agix-hive-gateway services/
#
FROM golang:1.26 AS build
ARG VERSION=dev
WORKDIR /src
# module manifests first for layer-cached dependency downloads
COPY go-common/go.mod go-common/
COPY hive-gateway/go.mod hive-gateway/go.sum hive-gateway/
WORKDIR /src/hive-gateway
RUN go mod download
COPY go-common/ /src/go-common/
COPY hive-gateway/ /src/hive-gateway/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /hive-gateway ./cmd/hive-gateway

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /hive-gateway /hive-gateway
EXPOSE 8080
ENTRYPOINT ["/hive-gateway"]
