FROM node:20-slim

# Install Linux system dependencies: Python3, FFmpeg, curl, certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Render & Cloud environments set PORT dynamically
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
