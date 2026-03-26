# Voice-to-Notion Worker
# Node.js + yt-dlp + ffmpeg for media ingestion and Notion sync

FROM node:20-alpine

# Install ffmpeg, python3 (required by yt-dlp), and curl (healthcheck)
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    curl

# Copy and install Python dependencies (yt-dlp + curl_cffi for anti-bot)
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Set working directory
WORKDIR /app

# Create data directories
RUN mkdir -p /app/data /app/data/inbox_media /app/data/processed /tmp/media-pipeline

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy source code
COPY src ./src
COPY scripts ./scripts

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 && \
    chown -R worker:nodejs /app /tmp/media-pipeline

USER worker

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Start the worker
CMD ["npm", "start"]
