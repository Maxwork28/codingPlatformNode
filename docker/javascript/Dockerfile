FROM node:18-slim
WORKDIR /app
RUN apt-get update && apt-get install -y \
    g++ \
    make \
    python3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["node"]