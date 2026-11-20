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
const allowHosts = new Set([...config.allowUrls, "mock-streams.test"]);

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

// ---------------- assertions
let failures = 0;
function check0(cond, msg) { if (!cond) { failures++; console.log("  FAIL " + msg); } }

// ---------------- http package
let requestCount = 0;
function doGet(url) {
    requestCount++;
    const host = new URL(url).hostname;
    if (!allowHosts.has(host)) throw new Error(`allowUrls violation: ${host} (${url})`);
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
    if (!allowHosts.has(effHost)) throw new Error(`allowUrls violation after redirect: ${effHost}`);
    return { url: effective, code: +code, isOk: +code >= 200 && +code < 300, body: out.slice(0, i), headers: {} };
}
const http = {
    GET: (url) => doGet(url),
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
const installedConfig = { ...config, sourceUrl: "https://example.github.io/bridge/config.json?addons=" + b64url(pasted) };

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
    check(home.results.length > 20, `home has results (${home.results.length})`);
    home.results.forEach((c, i) => checkContent(c, `home[${i}]`));
    const kinds = home.results.reduce((a, c) => (a[c.plugin_type] = (a[c.plugin_type] || 0) + 1, a), {});
    console.log("    home kinds:", JSON.stringify(kinds), "hasMore:", home.hasMore);
    const next = home.nextPage();
    check(next.results.length > 0, "home page 2 has results");
    const ids = new Set(home.results.map(c => c.id.value));
    check(next.results.every(c => !ids.has(c.id.value)), "home page 2 has no duplicates of page 1");
    movieUrl = home.results.find(c => c.plugin_type === "PlatformVideo").url;
});
section("home: movies only", () => {
    source.enable(installedConfig, settingsFor({ homeContent: "1" }), source.saveState());
    const h = source.getHome();
    check(h.results.every(c => c.plugin_type === "PlatformVideo"), "only videos");
    source.enable(installedConfig, settingsFor(), source.saveState());
});
section("search", () => {
    const r = source.search("breaking bad", "MIXED", null, {});
    const names = r.results.map(c => `${c.plugin_type === "PlatformPlaylist" ? "[show]" : "[movie]"} ${c.name}`);
    console.log("    ", names.slice(0, 6).join(" | "));
    check(r.results.some(c => c.name === "Breaking Bad" && c.plugin_type === "PlatformPlaylist"), "Breaking Bad found as show");
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
