import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
STATUS = {"state": "checking", "message": "Checking for updates…"}
STATUS_LOCK = threading.Lock()
UPDATE_FOUND = False
UPDATE_FAILED = False

SPLASH_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TubeGrab updater</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#0f0f0f;color:#f1f1f1;font:16px Arial,sans-serif}.panel{text-align:center;
padding:36px;max-width:460px}.spinner{width:52px;height:52px;margin:0 auto 24px;
border:5px solid #393939;border-top-color:#f00;border-radius:50%;
animation:spin .8s linear infinite}h1{font-size:23px;margin:0 0 12px}
p{color:#aaa;line-height:1.5;margin:0}@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body><main class="panel" role="status" aria-live="polite"><div class="spinner"></div>
<h1 id="title">TubeGrab is starting</h1><p id="message">Checking for updates…</p></main>
<script>
async function poll(){
  try{
    const r=await fetch('/status',{cache:'no-store'}),s=await r.json();
    document.querySelector('#title').textContent=s.state==='updating'?'Update found':'TubeGrab is starting';
    document.querySelector('#message').textContent=s.message;
    if(s.state==='ready'){location.href=s.target;return}
    if(s.state==='error'){document.querySelector('.spinner').style.display='none';return}
  }catch{}
  setTimeout(poll,800);
}
poll();
</script></body></html>"""


def set_status(state: str, message: str, **extra: str) -> None:
    with STATUS_LOCK:
        STATUS.clear()
        STATUS.update(state=state, message=message, **extra)


class SplashHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/status":
            with STATUS_LOCK:
                body = json.dumps(STATUS).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
        elif self.path == "/":
            body = SPLASH_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        else:
            self.send_error(404)
            return
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def start_splash() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), SplashHandler)
    url = f"http://127.0.0.1:{server.server_port}/"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Startup screen: {url}")
    webbrowser.open(url)
    return server, url


def run_npm_install() -> bool:
    if os.name == "nt":
        command = ["cmd.exe", "/d", "/s", "/c", "npm install --no-audit --no-fund"]
    else:
        command = ["npm", "install", "--no-audit", "--no-fund"]
    return subprocess.run(command, cwd=ROOT, check=False).returncode == 0


def run_update(command: list[str], package_name: str) -> int:
    global UPDATE_FOUND
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        lowered = line.lower()
        if (
            (package_name == "yt-dlp" and "collecting yt-dlp" in lowered)
            or (package_name == "ffmpeg" and "found ffmpeg" in lowered)
            or "updating to" in lowered
        ):
            UPDATE_FOUND = True
            set_status("updating", "Update found. Please wait, system is updating…")
    return process.wait()


def update_ytdlp(ytdlp: str) -> None:
    global UPDATE_FAILED
    print("Checking for yt-dlp updates…")
    if importlib.util.find_spec("yt_dlp"):
        command = [
            sys.executable, "-m", "pip", "install", "--upgrade",
            "--disable-pip-version-check", "--no-input", "yt-dlp",
        ]
    else:
        command = [ytdlp, "-U"]
    if run_update(command, "yt-dlp"):
        UPDATE_FAILED = True
        print(
            "Warning: yt-dlp could not be updated. Check the output above; "
            "continuing with the installed version.",
            file=sys.stderr,
        )


def update_ffmpeg(ffmpeg: str) -> None:
    global UPDATE_FAILED
    if os.name != "nt":
        print("Automatic FFmpeg updates are only configured for Windows with winget.")
        return

    winget = shutil.which("winget")
    if not winget:
        print(
            "Warning: winget was not found; update FFmpeg with its original package manager.",
            file=sys.stderr,
        )
        return

    print("Checking for FFmpeg updates via winget (Gyan.FFmpeg)…")
    if run_update(
        [
            winget,
            "upgrade",
            "--id",
            "Gyan.FFmpeg",
            "--exact",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
        "ffmpeg",
    ):
        UPDATE_FAILED = True
        print(
            "Warning: FFmpeg could not be updated via winget. Check the output above; "
            "continuing with the installed version.",
            file=sys.stderr,
        )


def is_tubegrab_running(target: str) -> bool:
    try:
        with urllib.request.urlopen(target, timeout=1) as response:
            return b"<title>TubeGrab</title>" in response.read(4096)
    except urllib.error.HTTPError:
        return False
    except (OSError, urllib.error.URLError):
        return False


def main() -> int:
    node = shutil.which("node")
    if not node:
        print("Node.js is required. Install Node.js 18 or newer and try again.", file=sys.stderr)
        return 1

    version = subprocess.run(
        [node, "--version"], capture_output=True, text=True, check=False
    )
    try:
        major_version = int(version.stdout.strip().lstrip("v").split(".", 1)[0])
    except (ValueError, IndexError):
        print("Could not determine the installed Node.js version.", file=sys.stderr)
        return 1
    if major_version < 18:
        print("Node.js 18 or newer is required.", file=sys.stderr)
        return 1

    port = os.environ.get("PORT", "3000")
    target = f"http://localhost:{port}/"
    if is_tubegrab_running(target):
        print(f"TubeGrab is already running at {target}")
        webbrowser.open(target)
        return 0

    splash, _ = start_splash()
    ytdlp = shutil.which("yt-dlp")
    ffmpeg = shutil.which("ffmpeg")
    try:
        if ytdlp:
            update_ytdlp(ytdlp)
        if ffmpeg:
            update_ffmpeg(ffmpeg)

        express_package = ROOT / "node_modules" / "express" / "package.json"
        if not express_package.is_file():
            set_status("checking", "Preparing TubeGrab dependencies…")
            print("Installing project dependencies…")
            if not run_npm_install():
                set_status("error", "Dependency installation failed. Check the launcher output.")
                return 1

        missing_tools = [
            name for name, executable in (("yt-dlp", ytdlp), ("ffmpeg", ffmpeg))
            if not executable
        ]
        if missing_tools:
            print(
                "Warning: missing " + ", ".join(missing_tools)
                + ". The web UI will start, but downloads may not work until these are installed."
            )

        if UPDATE_FAILED:
            set_status(
                "starting",
                "An update could not be installed. Starting TubeGrab with available versions…",
            )
        elif UPDATE_FOUND:
            set_status("starting", "Update complete. Starting TubeGrab…")
        else:
            set_status("starting", "Update check complete. Starting TubeGrab…")

        print(f"Starting TubeGrab at {target}")
        process = subprocess.Popen([node, "server.js"], cwd=ROOT)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                set_status("error", "TubeGrab could not start. Check the launcher output.")
                return process.returncode or 1
            try:
                with urllib.request.urlopen(target, timeout=0.5) as response:
                    if response.status == 200:
                        set_status("ready", "TubeGrab is ready.", target=target)
                        break
            except (OSError, urllib.error.URLError):
                time.sleep(0.25)
        else:
            process.terminate()
            set_status("error", "TubeGrab did not respond in time. Check the launcher output.")
            return 1

        try:
            return process.wait()
        except KeyboardInterrupt:
            process.terminate()
            process.wait()
            return 0
    finally:
        splash.shutdown()
        splash.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
