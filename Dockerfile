# Abracadabra Server Dockerfile
# Multi-stage build for optimal image size and security

# Build stage
FROM denoland/deno:1.40.2 AS builder

# Set working directory
WORKDIR /app

# Copy dependency files first for better caching
COPY deno.json deno.lock* ./

# Cache dependencies
RUN deno cache --reload --lock=deno.lock deno.json

# Copy source code
COPY . .

# Cache and check the application
RUN deno cache --reload --lock=deno.lock src/main.ts
RUN deno check src/main.ts

# Production stage
FROM denoland/deno:1.40.2

# Create app user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Set working directory
WORKDIR /app

# Copy application from builder stage
COPY --from=builder --chown=appuser:appuser /app .

# Create necessary directories
RUN mkdir -p /app/data/kv /app/data/uploads /app/data/logs \
    && chown -R appuser:appuser /app/data

# Create uploads directory with proper permissions
RUN mkdir -p /app/uploads && chown -R appuser:appuser /app/uploads

# Set environment variables
ENV DENO_ENV=production
ENV DENO_KV_PATH=/app/data/kv/abracadabra.db
ENV ABRACADABRA_UPLOAD_PATH=/app/uploads
ENV ABRACADABRA_LOG_LEVEL=INFO
ENV ABRACADABRA_PORT=8787
ENV ABRACADABRA_HOST=0.0.0.0

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD deno run --allow-net --allow-read --allow-env \
    --eval "fetch('http://localhost:8787/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Set volumes for persistent data
VOLUME ["/app/data", "/app/uploads"]

# Start the application
CMD ["deno", "run", \
    "--allow-net", \
    "--allow-read", \
    "--allow-write", \
    "--allow-env", \
    "--allow-ffi", \
    "--unstable-kv", \
    "--unstable-worker-options", \
    "src/main.ts"]
