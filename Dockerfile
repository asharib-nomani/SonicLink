# Multi-stage build: serve static files efficiently
FROM node:20-alpine AS base
WORKDIR /app

# Stage 1: Build (if needed for any assets/compression)
FROM base AS builder
COPY . .
# Minify HTML/CSS/JS (optional - add build tooling if needed)
# For now, we just verify files exist
RUN ls -la *.js *.html *.css 2>/dev/null || echo "Files ready"

# Stage 2: Production runtime
FROM node:20-alpine AS runtime
WORKDIR /app

# Install a lightweight HTTP server to serve static files
RUN npm install --global http-server

# Copy only necessary files from builder
COPY --from=builder /app/*.html /app/
COPY --from=builder /app/*.js /app/
COPY --from=builder /app/*.css /app/
COPY --from=builder /app/README.md /app/

# Expose port for the web server
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Serve static files on port 8080
CMD ["http-server", "-p", "8080", "-c-1"]
