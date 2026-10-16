# TubeGrab 🚀 - The Ultimate YouTube Video & Audio Downloader

**TubeGrab** is a powerful, fast, and completely free application that allows you to download any YouTube video or audio instantly. Designed with simplicity in mind, it features a native, YouTube-like interface where you can search, watch, play, and download content seamlessly.

---

## 📥 Launch & Download (All Platforms)

| Platform | Type | Link / Action |
|---|---|---|
| 🌐 **Live Web App** | Firebase Hosting | [![Open Web App](https://img.shields.io/badge/Firebase_Web-Launch_TubeGrab-FFA611?style=for-the-badge&logo=firebase&logoColor=black)](https://tubegrab-narwal.web.app) |
| 📱 **Android App** | Native APK | [![Download APK](https://img.shields.io/badge/Android-Download_APK-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/narwalindustries/TubeGrab/releases/latest/download/tubegrab.apk) |
| 💻 **Windows App** | Desktop Bundle | [![Download Windows](https://img.shields.io/badge/Windows-Download_Desktop-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/narwalindustries/TubeGrab/archive/refs/heads/main.zip) |

* 🌐 **Firebase Website**: Instant access in any browser. If the backend is sleeping, simply tap **"Connect & Wake Up Server"** to activate the eco-friendly cloud engine.
* 📱 **Android APK**: Native YouTube-style mobile UI with background downloading straight to your phone's `Download/` folder.
* 💻 **Windows Desktop**: Unzip and double-click **`TubeGrab.vbs`** for an instant, silent launch with zero server dependencies.

---

## 📁 Repository Structure

```
TubeGrab/
├── server/       # 🐧 Linux Cloud Backend (Render Dockerfile, render.yaml, yt-dlp & FFmpeg)
├── android/      # 📱 Android Native App (AndroidManifest.xml, MainActivity.java, Gradle)
├── desktop/      # 🪟 Windows Desktop App (TubeGrab.vbs, TubeGrab.bat, main.js)
├── public/       # 🌐 Frontend Web UI (Firebase Hosting ready with Server Wakeup Modal)
├── firebase.json # ⚡ Firebase Hosting configuration
└── server.js     # 🚀 Express API engine with CORS & universal OS support
```


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

## ⚙️ Configuration (.env)

TubeGrab supports zero-leakage security. Create a `.env` file by copying the template:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server listening port | `3000` (Local) / `10000` (Render) |
| `API_SECRET_KEY` | Secret auth token to prevent unauthorized access to backend | *Disabled if blank* |
| `BACKEND_URL` | Render / Cloud backend URL for Firebase Web & Android | `https://tubegrab.onrender.com` |
| `YTDLP_PATH` | Path to yt-dlp binary | `yt-dlp` |
| `FFMPEG_PATH` | Path to FFmpeg executable or directory | `ffmpeg` |
| `YT_COOKIES` | Optional path to cookies.txt (Bypasses YouTube bot checks) | `cookies.txt` (if present) |
| `MAX_JOBS` | Maximum concurrent background downloads | `3` |

### 🔒 Binary Bitwise Encryption for Published Web/App
To hide your private Render backend URL and secret API key in production, encrypt them into binary bitstreams:
```bash
npm run encrypt [BACKEND_URL] [API_SECRET_KEY]
```
This generates `public/config.js` containing only raw bitstreams (`0101...`), keeping your live server URL and credentials safe from being scrapped in plain text.

---

## 🛡️ License & Attribution

Developed and maintained by **Narwal Software Solutions**. All rights reserved.
