# Addon Bridge for Grayjay

A Grayjay source that reads **Stremio-protocol addons** (catalog, meta, stream and subtitle
resources) and shows them in Grayjay:

| Stremio            | Grayjay                                                         |
|--------------------|-----------------------------------------------------------------|
| Movie              | Video (author = its genre channel, e.g. "Drama Movies")         |
| Show               | **Channel**: Videos tab = latest episodes, Playlists tab = seasons |
| Season             | **Playlist** (autoplays the next episode)                       |
| Episode            | Video (recommendations = the following episodes)                |
| Streams            | Quality list (HTTP files, HLS, DASH; request headers carried over) |
| Subtitle addons    | Subtitle tracks                                                 |

Subscribe to a show's channel and new episodes show up in your Subscriptions feed.

Only direct **HTTP/HLS/DASH** streams play. Torrent-only results (`infoHash`) are skipped,
because Grayjay has no torrent engine.

## How addons are added

Grayjay's plugin settings can only hold switches and dropdowns, not text. So you paste addon
URLs on the plugin's **install page** instead:

1. Open the install page (`index.html` in `docs/`) on your phone.
2. Paste one or more Stremio manifest URLs, for example your personal PenguPlay link from
   pengu.uk's configure page.
3. Tap **Install in Grayjay**.

The page puts the URLs into the install link (`config.json?addons=...`). `config.json`
deliberately has no `sourceUrl`, so Grayjay stores that exact link, passes it to the plugin,
and reuses it for update checks. Your URLs never appear in the code, the repo or the
published site, so a **free public** GitHub repo is fine.

To change addons, open the page again, paste the new list and reinstall. Grayjay keeps your
settings.

Built-in addons come from `plugin.json` → `addons` (Cinemeta for catalogs and metadata, and
OpenSubtitles). Each has an on/off switch in Grayjay's plugin settings. Pasted addons come
after the built-in ones. The first addon that provides metadata for a title is the one used.

**Allowed hosts.** The plugin may only contact hosts in `allowUrls`: the built-in addon hosts,
any redirect hosts the build discovers, and `extraAllowUrls` (which includes `pengu.uk`). The
install page flags pasted URLs on other hosts. Add those hosts to `extraAllowUrls`, or set
`"allowAnyHost": true` (Grayjay then shows a warning at install), and rebuild.

Only use addons and content you have the right to stream.

## Install from your PC (no hosting)

1. Run `python build.py --serve`. It prints `http://<pc-ip>:8000/`.
2. Open that address on your phone (same Wi-Fi), paste your URLs and tap **Install in Grayjay**.
3. Updates only work while the server is running at the same address. Run
   `python build.py --serve --bump` and reinstall from the page.

## Publish on GitHub Pages (automatic updates)

1. Push this folder to a GitHub repo. It can be public, since `keys/` is git-ignored.
2. Go to **Settings → Pages → Deploy from a branch → main → /docs**.
3. Open `https://<you>.github.io/<repo>/` on your phone, paste your URLs and install.
4. To ship an update, run `python build.py --bump`, commit and push. Grayjay sees the new
   version and keeps your pasted addons, because they live in the stored install link.

**Back up `keys/private.pem`.** Updates must be signed with the same key. Never commit it.

## Settings (in Grayjay)

- Home feed: movies and shows, movies only, or shows only.
- An on/off toggle for each addon.
- Maximum resolution, and stream order (highest quality first, or addon order).
- Hide unaired episodes. Include specials (season 0) in the latest-episodes feed.
- Load subtitles, and subtitle language.

## Files

- `src/script.js`: the plugin. `build.py` fills in the built-in addon list between the
  `/*@ADDONS@*/` markers.
- `src/install.html`: the install page template (paste box, install link, QR code).
- `build.py`: builds `docs/` (`config.json`, signed `script.js`, `icon.png`, `index.html`). `allowUrls` is
  found by probing the addons, including redirect hosts. Signing uses RSA with SHA-512.
  Requires `pip install cryptography`.
- `test/harness.mjs`: runs the plugin in Node against Grayjay's real `source.js` runtime,
  using live Cinemeta and OpenSubtitles plus a fake stream addon:
  `node test/harness.mjs path/to/source.js`. Get `source.js` from
  `https://gitlab.futo.org/videostreaming/grayjay/-/raw/master/app/src/main/assets/scripts/source.js`.

## Troubleshooting

- **"None of your enabled addons provide streams"**: you installed without pasting a stream
  addon. Paste one on the install page and reinstall.
- **"torrent-only"**: the addon only returned torrents. Use an addon that returns HTTP links.
- **Requests blocked**: an addon's host (or a host it redirects to) isn't in `allowUrls`.
  Add it to `extraAllowUrls` and rebuild.
- **Update refused**: the signature is stale or the version wasn't bumped. Run
  `python build.py --bump`.
