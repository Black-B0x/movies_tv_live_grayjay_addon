#!/usr/bin/env python3
"""Build, sign and serve the Addon Bridge Grayjay plugin.

  python build.py                 build docs/ for publishing (e.g. on GitHub Pages)
  python build.py --bump          increment the version, then build
  python build.py --serve         build .dev/ for local testing and serve it on your LAN
  python build.py --no-probe      skip contacting the addons (allowUrls = addon hosts only)

Signing needs the `cryptography` package (pip install cryptography). The private key is
created on first build at keys/private.pem. Keep it safe: every future update must be
signed with the same key or Grayjay will refuse it.
"""
import argparse
import base64
import html
import http.server
import json
import re
import socket
import socketserver
import struct
import sys
import urllib.parse
import urllib.request
import uuid
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src" / "script.js"
PLUGIN_JSON = ROOT / "plugin.json"
DIST = ROOT / "docs"          # GitHub Pages can serve this folder directly
DEV_DIST = ROOT / ".dev"      # LAN test builds, never published
KEY = ROOT / "keys" / "private.pem"
ICON = ROOT / "icon.png"
INSTALL_PAGE = ROOT / "src" / "install.html"

# Option order must match MAX_HEIGHT_OPTIONS / SUB_LANGUAGES in src/script.js.
RESOLUTIONS = ["No limit", "2160p (4K)", "1080p", "720p", "480p"]
SUB_LANGUAGES = ["All languages", "English", "Spanish", "Portuguese", "French", "German", "Italian",
                 "Dutch", "Polish", "Russian", "Turkish", "Arabic", "Hindi", "Japanese", "Korean",
                 "Chinese"]


def addon_base(url):
    url = re.sub(r"^stremio://", "https://", url.strip(), flags=re.I)
    url = re.sub(r"/manifest\.json(\?.*)?$", "", url, flags=re.I)
    return url.rstrip("/")


def host_of(url):
    return urllib.parse.urlsplit(url).hostname


def fetch_hosts(url):
    """GET url, following redirects. Returns (json_or_None, set_of_hosts_touched)."""
    hosts = {host_of(url)}

    class Tracker(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            hosts.add(host_of(newurl))
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(Tracker)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Linux; Android 14) Grayjay"})
    try:
        with opener.open(req, timeout=20) as resp:
            hosts.add(host_of(resp.geturl()))
            return json.loads(resp.read().decode("utf-8")), hosts
    except Exception as e:  # noqa: BLE001
        print(f"  ! {url}: {e}")
        return None, hosts


def probe_addon(addon):
    """Find every host an addon's requests touch (addons often redirect to other hosts)."""
    base = addon_base(addon["url"])
    manifest, hosts = fetch_hosts(base + "/manifest.json")
    if not manifest:
        return hosts
    resources = [r if isinstance(r, str) else r.get("name") for r in manifest.get("resources", [])]
    print(f"  {addon['name']}: {manifest.get('name')} v{manifest.get('version')} "
          f"resources={resources} catalogs={len(manifest.get('catalogs', []))}")
    for cat in manifest.get("catalogs", [])[:2]:
        required = [e for e in cat.get("extra", []) if e.get("isRequired")]
        if required:
            continue
        cid = urllib.parse.quote(cat["id"], safe=":")
        _, h = fetch_hosts(f"{base}/catalog/{cat['type']}/{cid}.json")
        hosts |= h
    return hosts


def make_settings(addons):
    s = [{"variable": "homeHeader", "name": "Home", "description": "", "type": "Header"},
         {"variable": "homeContent", "name": "Home feed shows",
          "description": "What the Home tab pulls from your addons' catalogs.",
          "type": "Dropdown", "default": "0", "options": ["Movies and shows", "Movies only", "Shows only"]},
         {"variable": "addonsHeader", "name": "Addons", "description": "", "type": "Header"}]
    for i, a in enumerate(addons):
        s.append({"variable": f"addon{i}", "name": a["name"], "description": a["url"],
                  "type": "Boolean", "default": "true"})
    s += [{"variable": "streamsHeader", "name": "Streams", "description": "", "type": "Header"},
          {"variable": "maxResolution", "name": "Maximum resolution",
           "description": "Hide streams above this resolution (if that leaves nothing, all are shown).",
           "type": "Dropdown", "default": "0", "options": RESOLUTIONS},
          {"variable": "streamOrder", "name": "Stream order", "description": "How the quality list is sorted.",
           "type": "Dropdown", "default": "0", "options": ["Highest quality first", "Addon order"]},
          {"variable": "showsHeader", "name": "Shows", "description": "", "type": "Header"},
          {"variable": "hideUnreleased", "name": "Hide unaired episodes",
           "description": "Leave out episodes with a future air date.", "type": "Boolean", "default": "true"},
          {"variable": "includeSpecials", "name": "Specials in latest episodes",
           "description": "Include season 0 in a show's Videos tab and your Subscriptions feed.",
           "type": "Boolean", "default": "false"},
          {"variable": "subsHeader", "name": "Subtitles", "description": "", "type": "Header"},
          {"variable": "subtitlesEnabled", "name": "Load subtitles",
           "description": "Ask subtitle addons (e.g. OpenSubtitles) for subtitles.",
           "type": "Boolean", "default": "true"},
          {"variable": "subtitleLanguage", "name": "Subtitle language", "description": "",
           "type": "Dropdown", "default": "1", "options": SUB_LANGUAGES}]
    return s


def sign(script_bytes):
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
    except ImportError:
        print("! cryptography not installed (pip install cryptography); building UNSIGNED")
        return "", ""
    if not KEY.exists():
        KEY.parent.mkdir(parents=True, exist_ok=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        KEY.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
        print(f"  created signing key {KEY}  (back this up, and never publish it)")
    key = serialization.load_pem_private_key(KEY.read_bytes(), password=None)
    signature = key.sign(script_bytes, padding.PKCS1v15(), hashes.SHA512())
    public = key.public_key().public_bytes(serialization.Encoding.DER,
                                           serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(signature).decode(), base64.b64encode(public).decode()


def write_icon(path):
    """A simple 256x256 play-button icon, so the project has no binary dependencies."""
    size = 256
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - 128, y - 128
            inside_circle = dx * dx + dy * dy <= 120 * 120
            # play triangle with vertices (100,76) (100,180) (186,128)
            in_tri = x >= 100 and abs(y - 128) <= (186 - x) * 52 / 86
            if not inside_circle:
                row += bytes([0, 0, 0, 0])
            elif in_tri:
                row += bytes([255, 255, 255, 255])
            else:
                t = y / size
                row += bytes([int(90 + 60 * t), int(50 + 20 * t), int(200 - 40 * t), 255])
        rows.append(bytes(row))

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def build(bump, probe, out=DIST):
    plugin = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    changed = False
    if not plugin.get("id"):
        plugin["id"] = str(uuid.uuid4())
        changed = True
    if bump:
        plugin["version"] = int(plugin.get("version", 1)) + 1
        changed = True
    if changed:
        PLUGIN_JSON.write_text(json.dumps(plugin, indent=2) + "\n", encoding="utf-8")

    addons = plugin.get("addons", [])
    hosts = {host_of(addon_base(a["url"])) for a in addons}
    if probe:
        print("Probing addons:")
        for a in addons:
            hosts |= probe_addon(a)
    hosts |= set(plugin.get("extraAllowUrls", []))
    hosts.discard(None)
    allow_any = bool(plugin.get("allowAnyHost"))

    script = SRC.read_text(encoding="utf-8")
    addon_js = json.dumps([{"name": a["name"], "url": a["url"]} for a in addons], indent=4)
    script, n = re.subn(r"/\*@ADDONS@\*/.*?/\*@END@\*/", lambda _: addon_js, script, flags=re.S)
    if n != 1:
        sys.exit("Could not find the /*@ADDONS@*/ marker in src/script.js")
    script_bytes = script.encode("utf-8")

    out.mkdir(exist_ok=True)
    (out / "script.js").write_bytes(script_bytes)
    if not ICON.exists():
        write_icon(ICON)
    (out / "icon.png").write_bytes(ICON.read_bytes())

    signature, public_key = sign(script_bytes)
    # No "sourceUrl" on purpose: Grayjay then stores the exact link the plugin was installed
    # from (including ?addons=...) as sourceUrl, hands it to the script, and reuses it for updates.
    config = {
        "name": plugin["name"],
        "description": plugin["description"],
        "author": plugin.get("author") or "Addon Bridge user",
        "authorUrl": plugin.get("authorUrl") or "",
        "repositoryUrl": plugin.get("repositoryUrl") or "",
        "scriptUrl": "./script.js",
        "iconUrl": "./icon.png",
        "id": plugin["id"],
        "version": int(plugin["version"]),
        "scriptSignature": signature,
        "scriptPublicKey": public_key,
        "packages": ["Http"],
        "allowEval": False,
        "allowUrls": ["everywhere"] if allow_any else sorted(hosts),
        "settings": make_settings(addons),
    }
    (out / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    page = INSTALL_PAGE.read_text(encoding="utf-8")
    replacements = {
        "__NAME__": html.escape(plugin["name"]),
        "__DESCRIPTION__": html.escape(plugin["description"]),
        "__BUILTIN_NAMES__": html.escape(", ".join(a["name"] for a in addons) or "none"),
        "__ALLOWED_HOSTS__": json.dumps(sorted(hosts)),
        "__ALLOW_ANY__": "true" if allow_any else "false",
        "__BUILTIN_BASES__": json.dumps([addon_base(a["url"]) for a in addons]),
    }
    for k, v in replacements.items():
        page = page.replace(k, v)
    (out / "index.html").write_text(page, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    print(f"\nBuilt {plugin['name']} v{config['version']} -> {out}")
    print(f"  allowUrls: {', '.join(config['allowUrls'])}")
    print(f"  signed:    {'yes' if signature else 'NO'}")


def serve(port):
    ip = lan_ip()
    build(bump=False, probe=True, out=DEV_DIST)
    print(f"\nDev server running. On your phone (same Wi-Fi) open:\n  http://{ip}:{port}/")
    print("paste your addon URLs, then tap Install. Ctrl+C to stop.")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DEV_DIST), **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            super().end_headers()

        def log_message(self, fmt, *args):
            # Don't print query strings: install links carry personal addon URLs.
            sys.stderr.write("  %s %s\n" % (self.command, self.path.split("?")[0]))

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
        httpd.serve_forever()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bump", action="store_true", help="increment version before building")
    p.add_argument("--serve", action="store_true", help="build .dev/ for LAN testing and serve it")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-probe", action="store_true", help="don't contact addons to discover redirect hosts")
    args = p.parse_args()
    if args.serve:
        serve(args.port)
    else:
        build(args.bump, not args.no_probe)


if __name__ == "__main__":
    main()
