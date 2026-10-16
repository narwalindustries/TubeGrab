# TubeGrab for Android 📱

Native Android application for **TubeGrab**, built specifically to look, feel, and function like the native YouTube app on Android.

## ✨ Features
* 🎬 **YouTube-like Dark UI**: Immersive dark design matching native YouTube Android standards.
* ⚡ **Integrated Download Manager**: Video & Audio downloads hook directly into Android's native system `DownloadManager` with notification bar progress and direct storage in your device's `Download/` folder.
* 📺 **Full-Screen Video**: Automatic orientation switching and full-screen HTML5 video playback.
* 🚀 **Cloud Backend Sync**: Automatically connects to the Render Cloud Engine with Eco Power-Saving wakeup support.

## 🛠️ How to Build APK

### Option 1: Using Android Studio (Recommended)
1. Open **Android Studio**.
2. Select **Open an existing project** and choose the `android/` folder in this repository.
3. Click **Build ➔ Build Bundle(s) / APK(s) ➔ Build APK(s)**.
4. Your `.apk` file will be generated in `android/app/build/outputs/apk/release/`.

### Option 2: Using Gradle Command Line
```bash
cd android
./gradlew assembleRelease
```
The APK will be generated at `app/build/outputs/apk/release/app-release-unsigned.apk`.
