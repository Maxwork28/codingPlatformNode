FROM php:8.1-cli
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["php", "code.php"]