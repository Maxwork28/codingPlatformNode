FROM gcc:latest
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["gcc", "-o", "code", "code.c"]