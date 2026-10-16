import os
from collections import deque
from PIL import Image, ImageDraw

SOURCE_IMAGE = r"C:\Users\narwa\.gemini\antigravity-ide\brain\a4286129-770d-4037-9a65-78ec1ff78c99\.user_uploaded\media_1792116987069.jpg"
WORKSPACE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

print(f"Loading source logo from: {SOURCE_IMAGE}")
im = Image.open(SOURCE_IMAGE).convert("RGBA")
w, h = im.size
pixels = im.load()

# 1. Flood fill corners to remove the outer white square background cleanly
visited = set()
q = deque([(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
for pt in list(q):
    visited.add(pt)

while q:
    x, y = q.popleft()
    r, g, b, a = pixels[x, y]
    # Check if outer white/near-white pixel
    if r > 215 and g > 215 and b > 215:
        pixels[x, y] = (0, 0, 0, 0)
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in visited:
                visited.add((nx, ny))
                q.append((nx, ny))

# 2. Crop to the squircle bounding box with a 4% margin for perfect balance
bbox = im.getbbox()
print(f"Isolated squircle bounding box: {bbox}")
cropped = im.crop(bbox)

cw, ch = cropped.size
max_dim = max(cw, ch)
pad = int(max_dim * 0.04)
final_size = max_dim + pad * 2

master_logo = Image.new("RGBA", (final_size, final_size), (0, 0, 0, 0))
offset_x = (final_size - cw) // 2
offset_y = (final_size - ch) // 2
master_logo.paste(cropped, (offset_x, offset_y), cropped)

# Generate master 1024x1024
master_1024 = master_logo.resize((1024, 1024), Image.LANCZOS)
master_512 = master_logo.resize((512, 512), Image.LANCZOS)

# Create circular mask for Android round icons
def make_round(image):
    sz = image.size
    mask = Image.new("L", sz, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, sz[0], sz[1]), fill=255)
    rounded = Image.new("RGBA", sz, (0, 0, 0, 0))
    rounded.paste(image, (0, 0), mask)
    return rounded

# Save Web / PWA Assets
public_dir = os.path.join(WORKSPACE_DIR, "public")
os.makedirs(public_dir, exist_ok=True)

master_512.save(os.path.join(public_dir, "logo.png"), "PNG")
master_512.save(os.path.join(public_dir, "icon-512.png"), "PNG")
master_logo.resize((192, 192), Image.LANCZOS).save(os.path.join(public_dir, "icon-192.png"), "PNG")
master_logo.resize((180, 180), Image.LANCZOS).save(os.path.join(public_dir, "apple-touch-icon.png"), "PNG")
master_logo.resize((32, 32), Image.LANCZOS).save(os.path.join(public_dir, "favicon.png"), "PNG")

# Multi-resolution ICO for web and windows
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
master_1024.save(os.path.join(public_dir, "favicon.ico"), format="ICO", sizes=ico_sizes)

# Save Desktop Assets
root_ico = os.path.join(WORKSPACE_DIR, "icon.ico")
root_png = os.path.join(WORKSPACE_DIR, "icon.png")
master_1024.save(root_ico, format="ICO", sizes=ico_sizes)
master_512.save(root_png, "PNG")

desktop_dir = os.path.join(WORKSPACE_DIR, "desktop")
os.makedirs(desktop_dir, exist_ok=True)
master_1024.save(os.path.join(desktop_dir, "icon.ico"), format="ICO", sizes=ico_sizes)
master_512.save(os.path.join(desktop_dir, "icon.png"), "PNG")

build_dir = os.path.join(WORKSPACE_DIR, "build")
os.makedirs(build_dir, exist_ok=True)
master_1024.save(os.path.join(build_dir, "icon.ico"), format="ICO", sizes=ico_sizes)
master_512.save(os.path.join(build_dir, "icon.png"), "PNG")

# Save Android Mipmaps
android_res = os.path.join(WORKSPACE_DIR, "android", "app", "src", "main", "res")
android_densities = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

for folder, dim in android_densities.items():
    density_dir = os.path.join(android_res, folder)
    os.makedirs(density_dir, exist_ok=True)
    std_icon = master_logo.resize((dim, dim), Image.LANCZOS)
    round_icon = make_round(std_icon)
    std_icon.save(os.path.join(density_dir, "ic_launcher.png"), "PNG")
    round_icon.save(os.path.join(density_dir, "ic_launcher_round.png"), "PNG")

print("[OK] Successfully generated all brand assets for Web, Android, and Desktop!")
