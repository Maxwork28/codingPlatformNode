FROM python:3.9-slim
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["python", "code.py"]