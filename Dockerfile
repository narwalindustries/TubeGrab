FROM node:20-slim

# Install Linux system dependencies: Python3, Python3-pip, FFmpeg, curl, unzip, certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    ca-certificates \
 && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip /tmp/deno.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/deno \
 && rm -f /tmp/deno.zip \
 && pip3 install --no-cache-dir --break-system-packages curl-cffi yt-dlp-ejs \
 && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
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
