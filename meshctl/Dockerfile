FROM golang:1.25-alpine AS builder

WORKDIR /src
COPY meshctl/go.mod meshctl/go.sum ./meshctl/
RUN cd meshctl && go mod download

COPY meshctl ./meshctl
ARG VERSION=dev
RUN cd meshctl && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w -X github.com/meshlite/meshctl/cmd.version=${VERSION}" -o /out/meshctl .

FROM alpine:3.21
RUN apk --no-cache add ca-certificates
COPY --from=builder /out/meshctl /usr/local/bin/meshctl
ENTRYPOINT ["/usr/local/bin/meshctl"]
