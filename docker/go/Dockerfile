FROM golang:1.23-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
# Pre-compile the standard library into a seed cache; the runner copies it to tmpfs so a cold
# `go build` of a student program takes ~0.3 s instead of several seconds.
ENV GOCACHE=/opt/gocache GOFLAGS=-buildvcs=false CGO_ENABLED=0
RUN mkdir -p /opt/gocache && go build std && chmod -R a+rX /opt/gocache
USER appuser
ENV HOME=/tmp
CMD ["go", "version"]
