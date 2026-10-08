FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser
ENV HOME=/tmp
CMD ["node", "--version"]
