FROM node:20-slim

# Install Linux system dependencies: Python3, Python3-pip, FFmpeg, curl, certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Render & Cloud environments set PORT dynamically
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
