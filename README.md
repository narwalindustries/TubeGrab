# TubeGrab 🚀 - The Ultimate YouTube Video & Audio Downloader

**TubeGrab** is a powerful, fast, and completely free application that allows you to download any YouTube video or audio instantly. Designed with simplicity in mind, it features a native, YouTube-like interface where you can search, watch, play, and download content seamlessly.

---

## 📥 Downloads & Quick Launch

[![Windows Desktop App](https://img.shields.io/badge/Windows-Download%20Desktop%20App-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/narwalindustries/TubeGrab/archive/refs/heads/main.zip)
[![GitHub Releases](https://img.shields.io/badge/Releases-Latest%20Version-238636?style=for-the-badge&logo=github&logoColor=white)](https://github.com/narwalindustries/TubeGrab/releases)

* 🪟 **Windows Desktop**: Click the blue button above to download, unzip, and double-click **`TubeGrab.vbs`** for an instant, silent desktop launch.
* 📱 **Android Usage**: A standalone offline Android APK is not feasible without a backend cloud server (as phones lack native Node.js, Python, and FFmpeg environments). However, you can seamlessly open TubeGrab on your Android phone's browser by connecting to your PC's Wi-Fi IP (e.g., `http://192.168.x.x:3000`).


## ✨ Key Features

*   🎬 **All Qualities Supported:** Download videos in any available resolution (144p to 4K) with exact quality matching or extract crystal-clear high-quality audio (MP3 320/192/128 kbps, M4A, OPUS).
*   ⚡ **Built-in Video Player & RAM Streaming:** Watch and stream YouTube videos directly within the TubeGrab interface before downloading with zero-copy unthrottled streaming and in-memory caching.
*   🔒 **No Login Required:** 100% free to use with zero registration, no sign-ups, and no hidden steps.
*   ✨ **Clean & Intuitive PiP UI:** Picture-in-Picture quality selection popup over playing video, and Chrome-style floating flyout downloads manager with full history control.
*   🔄 **Always Up-to-Date:** Continuously updated format extraction and automatic fallback engine ensuring smooth downloading.

---

## 🚀 How It Works (SEO Optimized)

If you are looking for a hassle-free **YouTube downloader**, TubeGrab is the perfect solution. You don't need to copy-paste URLs from different apps. Simply search for your favorite video directly on TubeGrab, play it using the built-in player, select your preferred video or audio quality, and download it instantly to your device.

---

## 🔗 Repository
🌐 **[GitHub Repository](https://github.com/narwalindustries/TubeGrab)**

---

## 🛠️ Built With

*   **Runtime & Server:** [Node.js](https://nodejs.org/) & [Express](https://expressjs.com/)
*   **Frontend:** Vanilla JavaScript (ES6+), HTML5 Semantic markup & CSS3 Glassmorphism
*   **Media Processing:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) & [FFmpeg](https://ffmpeg.org/)
*   **YouTube Extraction:** [YouTubei.js](https://github.com/LuanRT/YouTube.js)

---

## 💻 Getting Started

### Prerequisites

Ensure you have the following installed:
- **Node.js** (v18 or higher)
- **yt-dlp** (`pip install -U yt-dlp` or binary from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases))
- **FFmpeg** (`winget install Gyan.FFmpeg` on Windows, or `sudo apt install ffmpeg` on Linux)

### Installation & Running

1. **Clone the repository:**
   ```bash
   git clone https://github.com/narwalindustries/TubeGrab.git
   cd TubeGrab
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Launch as Desktop App (Native Window):**
   - Simply double-click **`TubeGrab.vbs`** (silent launch) or **`TubeGrab.bat`**.
   - Or run via terminal:
     ```bash
     npm run desktop
     ```

4. **Or Run as Web Server:**
   ```bash
   npm start
   ```
   Navigate to `http://localhost:3000` in your browser.

   Or use the automated Python launcher with self-updating dependencies:
   ```bash
   python run.py
   ```

### Docker Support

```bash
docker build -t tubegrab .
docker run -p 3000:3000 tubegrab
```

---

## ⚙️ Configuration (Environment Variables)

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server listening port | `3000` |
| `YTDLP_PATH` | Path to yt-dlp binary | `yt-dlp` |
| `FFMPEG_PATH` | Path to FFmpeg executable or directory | `ffmpeg` |
| `YT_COOKIES` | Optional path to cookies.txt | `cookies.txt` (if present) |
| `MAX_JOBS` | Maximum concurrent background downloads | `3` |

---

## 🛡️ License & Attribution

Developed and maintained by **Narwal Software Solutions**. All rights reserved.
