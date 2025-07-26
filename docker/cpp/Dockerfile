# docker/cpp/Dockerfile
FROM gcc:latest
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["g++", "-o", "code", "code.cpp"]