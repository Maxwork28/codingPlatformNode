FROM golang:1.19
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["go", "run", "code.go"]