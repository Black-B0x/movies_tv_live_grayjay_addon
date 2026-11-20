// Offline-ish test harness: runs the plugin against Grayjay's real runtime (source.js) in a
// Node VM, with live HTTP for the configured addons plus a fake stream addon.
//
//   node test/harness.mjs <path-to-grayjay-source.js>
//
// Get source.js from:
//   https://gitlab.futo.org/videostreaming/grayjay/-/raw/master/app/src/main/assets/scripts/source.js
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = process.argv[2];
if (!runtimePath) { console.error("usage: node test/harness.mjs <source.js>"); process.exit(2); }

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "config.json"), "utf8"));
const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
const MOCK = "https://mock-streams.test";
const addons = plugin.addons;
const LIVE = "https://mock-live.test";
const allowAny = config.allowUrls.includes("everywhere");
const allowHosts = new Set([...config.allowUrls, "mock-streams.test", "mock-live.test", "iptv.mock-live.test"]);
const allowed = (host) => allowAny || allowHosts.has(host);

// ---------------- fake stream addon
function mockResponse(url) {
    const p = url.slice(MOCK.length);
    if (p === "/manifest.json") return { id: "test.mock", version: "1.0.0", name: "Mock Streams",
        resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt"], catalogs: [] };
    const m = p.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (!m) return null;
    const id = decodeURIComponent(m[2]);
    if (id === "tt0000001") return { streams: [{ name: "Torrent", infoHash: "abc", fileIdx: 0 }] };
    return { streams: [
        { name: "Mock\n720p", description: "Some.Movie.720p.mkv\n💾 1.1 GB", url: `https://cdn.test/${id}/720.mkv` },
        { name: "Mock 4K", title: "Some.Movie.2160p.HDR", url: `https://cdn.test/${id}/2160.mp4`,
          behaviorHints: { proxyHeaders: { request: { Referer: "https://cdn.test/" } } } },
        { name: "Mock HLS 1080p", url: `https://cdn.test/${id}/master.m3u8`,
          subtitles: [{ id: "s1", url: "https://cdn.test/sub.vtt", lang: "eng" }] },
        { name: "Mock duplicate", url: `https://cdn.test/${id}/720.mkv` },
        { name: "Torrent only", infoHash: "deadbeef" },
        { name: "YouTube trailer", ytId: "xyz" },
    ] };
}

// ---------------- fake live channel list (an embed-style manifest + epg.json)
const hour = 3600 * 1000, now = Date.now();
const iso = (t) => new Date(t).toISOString();
function liveResponse(url) {
    const p = url.slice(url.indexOf(".test") + 5);
    if (url.startsWith(LIVE) && p === "/embed/manifest.json") return { name: "Mock Live", variant: "embed",
        baseUrl: LIVE + "/embed/", channels: [
            { id: "news1", name: "Mock News", region: "UK", flag: "gb", quality: "FHD", sport: "", live: true, url: LIVE + "/embed/news1" },
            { id: "sport 2", name: "Mock Sports 2", region: "", flag: "us", quality: "HD", sport: "Sports", live: true, url: LIVE + "/embed/sport%202" },
            { id: "sport3", name: "Mock Sports 3", flag: "us", quality: "HD", sport: "Sports", live: true, url: LIVE + "/embed/sport3" },
            { id: "direct", name: "Direct HLS", flag: "", sport: "Other", url: "https://cdn.test/live/direct.m3u8" },
            { id: "broken", name: "z[broken]", flag: "gb", sport: "Sports", url: LIVE + "/embed/broken" },
            { id: "off", name: "Off Air", live: false, url: LIVE + "/embed/off" },
            { id: "dead", name: "Dead Channel", sport: "Sports", url: LIVE + "/embed/dead" },
        ] };
    if (url.startsWith(LIVE) && p === "/embed/epg.json") return { channels: [
        { id: "news1", now: { title: "Old Show", start: iso(now - 3 * hour), stop: iso(now - hour) },
                       next: { title: "Evening News", desc: "Headlines.", start: iso(now - hour), stop: iso(now + hour) } },
        { id: "sport 2", now: { title: "Cup Final", desc: "Live match.", start: iso(now - hour), stop: iso(now + hour) },
                         next: { title: "Highlights", start: iso(now + hour), stop: iso(now + 2 * hour) } },
    ] };
    if (url === "https://cdn.test/live/direct.m3u8") return "#EXTM3U\n";
    const m = url.match(/^https:\/\/iptv\.mock-live\.test\/api\?channel=(.+)$/);
    if (m) return decodeURIComponent(m[1]) === "dead" ? null : "#EXTM3U\n#EXTINF:8,\nseg.ts\n";
    return undefined;
}

// ---------------- assertions
let failures = 0;
function check0(cond, msg) { if (!cond) { failures++; console.log("  FAIL " + msg); } }

// ---------------- http package
let requestCount = 0;
function doGet(url) {
    requestCount++;
    const host = new URL(url).hostname;
    if (!allowed(host)) throw new Error(`allowUrls violation: ${host} (${url})`);
    if (/\.test$/.test(host) && host !== "mock-streams.test") {
        const body = liveResponse(url);
        if (body === undefined || body === null) return { url, code: body === null ? 403 : 404, isOk: false, body: "no", headers: {} };
        return { url, code: 200, isOk: true, body: typeof body === "string" ? body : JSON.stringify(body), headers: {} };
    }
    if (url.startsWith(MOCK)) {
        const body = mockResponse(url);
        return body ? { url, code: 200, isOk: true, body: JSON.stringify(body), headers: {} }
                    : { url, code: 404, isOk: false, body: "not found", headers: {} };
    }
    const out = execFileSync("curl", ["-sSL", "--max-time", "25", "-w", "\n@@%{http_code} %{url_effective}", url],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const i = out.lastIndexOf("\n@@");
    const [code, effective] = out.slice(i + 3).split(" ");
    const effHost = new URL(effective).hostname;
    if (!allowed(effHost)) throw new Error(`allowUrls violation after redirect: ${effHost}`);
    return { url: effective, code: +code, isOk: +code >= 200 && +code < 300, body: out.slice(0, i), headers: {} };
}
const lastHeaders = {};
const http = {
    GET: (url, headers) => { lastHeaders[url] = headers; return doGet(url); },
    batch() {
        const urls = [];
        const b = { GET(url) { urls.push(url); return b; }, execute: () => urls.map(doGet) };
        return b;
    },
};

// ---------------- load runtime + plugin
const logs = [];
const ctx = vm.createContext({ console, http, bridge: { log: (s) => logs.push(s) } });
vm.runInContext(fs.readFileSync(runtimePath, "utf8"), ctx, { filename: "source.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "docs", "script.js"), "utf8"), ctx, { filename: "script.js" });

// What the install page does: put pasted manifest URLs into the install link as base64url JSON.
// Grayjay stores that link as config.sourceUrl because config.json has none.
const b64url = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
check0(!("sourceUrl" in config), "config.json must not contain sourceUrl");
const pasted = [MOCK + "/manifest.json", plugin.addons[0].url /* duplicate of a built-in: ignored */];
const installedConfig = { ...config, sourceUrl: "https://example.github.io/bridge/config.json?addons=" + b64url(pasted) +
    "&live=" + b64url([LIVE + "/embed/manifest.json"]) };

const defaults = {};
for (const s of config.settings) if (s.default !== undefined) defaults[s.variable] = s.default;
const settingsFor = (over = {}) => vm.runInContext("parseSettings", ctx)({ ...defaults, ...over });
const source = vm.runInContext("source", ctx);
source.enable(installedConfig, settingsFor(), null);

const check = check0;
function section(name, fn) {
    const t = Date.now();
    try { fn(); console.log(`ok  ${name} (${Date.now() - t} ms)`); }
    catch (e) { failures++; console.log(`ERR ${name}: ${e && (e.msg || e.message) || e}`); if (e && e.stack) console.log(e.stack.split("\n").slice(0, 4).join("\n")); }
}
const checkContent = (c, where) => {
    check(c && c.id && c.id.value, `${where}: id`);
    check(c.name, `${where}: name`);
    check(c.url && (source.isContentDetailsUrl(c.url) || source.isPlaylistUrl(c.url)), `${where}: routable url ${c.url}`);
    check(c.author && source.isChannelUrl(c.author.url), `${where}: author channel url ${c.author && c.author.url}`);
};

let home, movieUrl, showUrl, seasonUrl, episodeUrl;
section("getHome", () => {
    home = source.getHome();
    const live = home.results.filter(c => c.isLive);
    check(live.length === 5 && home.results.slice(0, 5).every(c => c.isLive), `live channels lead home (${live.length})`);
    check(home.results.length > 20, `home has results (${home.results.length})`);
    home.results.forEach((c, i) => checkContent(c, `home[${i}]`));
    const kinds = home.results.reduce((a, c) => (a[c.plugin_type] = (a[c.plugin_type] || 0) + 1, a), {});
    console.log("    home kinds:", JSON.stringify(kinds), "hasMore:", home.hasMore);
    const next = home.nextPage();
    check(next.results.length > 0, "home page 2 has results");
    check(next.results.every(c => !c.isLive), "live channels only on the first page when there are few");
    const ids = new Set(home.results.map(c => c.id.value));
    check(next.results.every(c => !ids.has(c.id.value)), "home page 2 has no duplicates of page 1");
    movieUrl = home.results.find(c => c.plugin_type === "PlatformVideo" && !c.isLive).url;
});
section("home: movies only", () => {
    source.enable(installedConfig, settingsFor({ homeContent: "1" }), source.saveState());
    const h = source.getHome();
    check(h.results.every(c => c.plugin_type === "PlatformVideo"), "only videos");
    source.enable(installedConfig, settingsFor(), source.saveState());
});
section("live TV: home modes", () => {
    source.enable(installedConfig, settingsFor({ homeContent: "3" }), source.saveState());
    const h = source.getHome();
    check(h.results.length === 5 && h.results.every(c => c.isLive), "live-only home");
    console.log("    live:", h.results.map(v => `${v.name} [${v.author.name}]`).join(" | "));
    check(!h.results.some(v => /broken|Off Air/.test(v.author.name)), "broken and off-air channels hidden");
    check(h.results.find(v => v.author.name === "Mock News").name === "Evening News", "ended programme skipped for next");
    check(h.results.find(v => v.author.name === "Mock Sports 3").name === "Mock Sports 3 (live)", "no EPG falls back to channel name");
    source.enable(installedConfig, settingsFor({ homeContent: "1" }), source.saveState());
    check(source.getHome().results.every(c => !c.isLive), "movies-only home has no live TV");
    source.enable(installedConfig, settingsFor(), source.saveState());
});
let liveChannelUrl, liveWatchUrl;
section("live TV: channel, contents, details", () => {
    const r = source.searchChannels("sports");
    const ch = r.results.find(c => c.name === "Mock Sports 2");
    check(ch && source.isChannelUrl(ch.url) && !source.isContentDetailsUrl(ch.url), "live channel via searchChannels");
    liveChannelUrl = ch.url;
    const full = source.getChannel(liveChannelUrl);
    check(full.thumbnail === "https://flagcdn.com/w320/us.png", "flag thumbnail");
    check(/Now \(.*\): Cup Final/.test(full.description) && /Next/.test(full.description), "now/next in description");
    const items = source.getChannelContents(liveChannelUrl, "VIDEOS", null, {});
    check(items.results.length === 1 && items.results[0].isLive, "channel has its live video");
    liveWatchUrl = items.results[0].url;
    check(source.isContentDetailsUrl(liveWatchUrl) && !source.isChannelUrl(liveWatchUrl), "watch url routes to content");
    const d = source.getContentDetails(liveWatchUrl);
    check(d.isLive && d.live && d.live.plugin_type === "HLSSource", "live HLS source");
    check(d.live.url === "https://iptv.mock-live.test/api?channel=sport%202", "embed list resolves to the site's IPTV endpoint: " + d.live.url);
    const h = d.live.requestModifier.headers;
    check(h.Referer === LIVE + "/" && h.Origin === LIVE && /VLC/.test(h["User-Agent"]), "Referer/Origin/UA headers");
    check(lastHeaders[d.live.url] && lastHeaders[d.live.url].Referer === LIVE + "/", "stream check sent the Referer");
    check(d.video.videoSources.length === 1, "video descriptor has the stream too");
    const rec = d.getContentRecommendations();
    check(rec.results[0].author.name === "Mock Sports 3", "same-category channels recommended first");
    const direct = source.getContentDetails("https://addon-bridge.invalid/live/mock-live.test/direct/watch");
    check(direct.live.url === "https://cdn.test/live/direct.m3u8", "direct .m3u8 channel url used as is");
});
section("live TV: offline and missing channels", () => {
    try { source.getContentDetails("https://addon-bridge.invalid/live/mock-live.test/dead/watch"); check(false, "should throw"); }
    catch (e) { check(/offline/.test(e.msg || ""), "offline message: " + (e.msg || e)); }
    try { source.getChannel("https://addon-bridge.invalid/live/nowhere.test/x"); check(false, "should throw"); }
    catch (e) { check(/isn't loaded/.test(e.msg || ""), "missing list message: " + (e.msg || e)); }
});
section("search", () => {
    const r = source.search("breaking bad", "MIXED", null, {});
    const names = r.results.map(c => `${c.plugin_type === "PlatformPlaylist" ? "[show]" : "[movie]"} ${c.name}`);
    console.log("    ", names.slice(0, 6).join(" | "));
    check(r.results.some(c => c.name === "Breaking Bad" && c.plugin_type === "PlatformPlaylist"), "Breaking Bad found as show");
    const lr = source.search("cup final", "MIXED", null, {});
    check(lr.results[0] && lr.results[0].isLive && lr.results[0].name === "Cup Final", "search finds live programme by EPG title");
    r.results.forEach((c, i) => checkContent(c, `search[${i}]`));
});
section("searchChannels", () => {
    const r = source.searchChannels("breaking bad");
    const bb = r.results.find(c => c.name === "Breaking Bad");
    check(bb && source.isChannelUrl(bb.url), "Breaking Bad channel");
    showUrl = bb.url;
    console.log("    show url:", showUrl);
});
section("getChannel (show)", () => {
    const ch = source.getChannel(showUrl);
    check(ch.plugin_type === "PlatformChannel" && ch.name === "Breaking Bad", "channel name");
    check(ch.thumbnail && ch.banner, "thumbnail + banner");
    check(ch.links.IMDb, "IMDb link");
    console.log("    ", ch.description.split("\n")[0].slice(0, 90));
});
section("getChannelContents (latest episodes)", () => {
    const p = source.getChannelContents(showUrl, "VIDEOS", "CHRONOLOGICAL", {});
    check(p.results.length === 30 && p.hasMore, `first page 30 + hasMore (${p.results.length})`);
    console.log("    newest:", p.results.slice(0, 3).map(v => v.name).join(" | "));
    check(p.results[0].name.startsWith("S05"), "newest episode is season 5");
    check(p.results.every(v => !v.name.startsWith("S00")), "no specials by default");
    const p2 = p.nextPage();
    check(p2.results.length > 0 && p2.results[0].id.value !== p.results[0].id.value, "page 2 differs");
    p.results.forEach((c, i) => checkContent(c, `eps[${i}]`));
});
section("getChannelPlaylists (seasons)", () => {
    const p = source.getChannelPlaylists(showUrl);
    console.log("    ", p.results.map(s => `${s.name} (${s.videoCount})`).join(", "));
    check(p.results[0].name === "Season 1", "season 1 first");
    check(p.results[p.results.length - 1].name === "Specials", "specials last");
    p.results.forEach(s => check(source.isPlaylistUrl(s.url), "season url routable " + s.url));
    seasonUrl = p.results[0].url;
});
section("getPlaylist (season 1 + 'first')", () => {
    const pl = source.getPlaylist(seasonUrl);
    check(pl.plugin_type === "PlatformPlaylistDetails", "details type");
    check(pl.contents.results.length === 7, `season 1 has 7 episodes (${pl.contents.results.length})`);
    console.log("    ", pl.name, "→", pl.contents.results.slice(0, 2).map(v => v.name).join(" | "));
    episodeUrl = pl.contents.results[0].url;
    const first = source.getPlaylist(showUrl + "/season/first");
    check(first.contents.results[0].name === pl.contents.results[0].name, "'first' resolves to season 1");
});
section("getContentDetails (episode)", () => {
    const d = source.getContentDetails(episodeUrl);
    check(d.plugin_type === "PlatformVideoDetails", "details type");
    const srcs = d.video.videoSources;
    console.log("    sources:", srcs.map(s => `${s.plugin_type}:${s.height || "-"}:${s.name}`).join(" | "));
    check(srcs.length === 3, `3 unique playable sources (${srcs.length})`);
    check(srcs[0].height === 2160 && srcs[0].requestModifier && srcs[0].requestModifier.headers.Referer, "4K first with Referer");
    check(srcs.some(s => s.plugin_type === "HLSSource"), "has HLS");
    check(srcs.some(s => s.container === "video/x-matroska"), "mkv container");
    check(srcs.every(s => s.requestModifier && /VLC/.test(s.requestModifier.headers["User-Agent"])), "player user agent on every source");
    const areas = srcs.filter(s => s.plugin_type === "VideoUrlSource").map(s => s.width * s.height);
    check(new Set(areas).size === areas.length, "unique width x height so Grayjay lists every file");
    const kind = (url, fn, text) => vm.runInContext(`streamKind(${JSON.stringify(url)}, ${JSON.stringify(fn)}, ${JSON.stringify(text)})`, ctx);
    check(kind("https://x/direct/abc?sig=1", "720pHLS|^|tags", "720p • HLS • 1.9 Mbps") === "hls", "extensionless HLS detected");
    check(kind("https://x/direct/abc", "Movie.1080p.mkv", "HLS mirror") === "file", "file extension wins over text");
    check(d.subtitles.length > 0 && d.subtitles.every(s => s.url && s.format && s.name), `subtitles (${d.subtitles.length})`);
    console.log("    subs:", d.subtitles.map(s => `${s.name}[${s.format}]`).join(", "));
    check(d.description.includes("Season 1"), "episode description");
    const rec = d.getContentRecommendations();
    check(rec.results[0] && rec.results[0].name.startsWith("S01E02"), "next episode recommended " + (rec.results[0] && rec.results[0].name));
});
section("getContentDetails (movie) + settings", () => {
    const d = source.getContentDetails(movieUrl);
    console.log("    ", d.name, "|", d.video.videoSources.length, "sources | dur", d.duration, "| author", d.author.name);
    check(d.video.videoSources.length === 3, "movie sources");
    source.enable(installedConfig, settingsFor({ maxResolution: "2", streamOrder: "1", subtitleLanguage: "0" }), source.saveState());
    const d2 = source.getContentDetails(movieUrl);
    check(d2.video.videoSources.every(s => !s.height || s.height <= 1080), "max 1080p respected");
    check(d2.video.videoSources[0].name.startsWith("Mock 720p"), "addon order kept: " + d2.video.videoSources[0].name);
    source.enable(installedConfig, settingsFor(), source.saveState());
    const rec = d.getContentRecommendations();
    check(rec.results.length > 0 && rec.results.every(r => !r.url.endsWith(encodeURIComponent(d.id.value.split(":").pop()))), "genre recommendations exclude self");
});
section("genre channel", () => {
    const d = source.getContentDetails(movieUrl);
    const ch = source.getChannel(d.author.url);
    const items = source.getChannelContents(d.author.url, "VIDEOS", null, {});
    console.log("    ", ch.name, "→", items.results.slice(0, 3).map(x => x.name).join(" | "));
    check(items.results.length > 10, "genre channel has items");
});
section("torrent-only title gives a clear error", () => {
    try { source.getContentDetails("https://addon-bridge.invalid/item/movie/tt0000001"); check(false, "should throw"); }
    catch (e) { console.log("    ", e.plugin_type, "-", e.msg); check(/torrent-only/.test(e.msg || ""), "mentions torrent-only"); }
});
section("installed without pasted addons", () => {
    source.enable(config, settingsFor(), source.saveState());
    try { source.getContentDetails(movieUrl); check(false, "should throw"); }
    catch (e) { check(/None of your enabled addons provide streams/.test(e.msg || ""), "clear message: " + (e.msg || e)); }
    source.enable(installedConfig, settingsFor(), source.saveState());
});
section("url routing", () => {
    check(!source.isContentDetailsUrl(showUrl) && source.isChannelUrl(showUrl), "show url is a channel only");
    check(!source.isChannelUrl(seasonUrl) && !source.isContentDetailsUrl(seasonUrl), "season url is a playlist only");
    check(!source.isChannelUrl(episodeUrl) && !source.isPlaylistUrl(episodeUrl), "episode url is content only");
    check(!source.isContentDetailsUrl("https://www.youtube.com/watch?v=x"), "foreign urls rejected");
});
section("pasted addons: names, dedupe, bad link", () => {
    const names = vm.runInContext("activeAddons().map(a => a.name)", ctx);
    console.log("    active addons:", names.join(", "));
    check(names.length === 3 && names[2] === "Mock Streams", "built-ins + pasted mock, duplicate ignored");
    source.enable({ ...config, sourceUrl: "https://x/config.json?addons=%%%garbage" }, settingsFor(), null);
    check(vm.runInContext("enabledAddons().length", ctx) === 2, "garbage link falls back to built-ins");
    source.enable(installedConfig, settingsFor(), source.saveState());
});
section("saveState round-trip", () => {
    const s = source.saveState();
    const before = requestCount;
    source.enable(installedConfig, settingsFor(), s);
    source.getChannelPlaylists(showUrl);
    check(requestCount - before <= 1, `manifests served from saved state (requests: ${requestCount - before})`);
});

console.log(`\n${failures ? failures + " FAILURE(S)" : "ALL PASSED"} · ${requestCount} HTTP requests`);
if (logs.length) console.log("plugin log:", logs.slice(0, 5).join(" / "));
process.exit(failures ? 1 : 0);
