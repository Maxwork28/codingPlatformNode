FROM ruby:3.1-slim
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
CMD ["ruby", "code.rb"]