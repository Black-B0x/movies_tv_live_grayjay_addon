// Movies TV Live: a Grayjay source for Stremio-protocol addons and live TV channel lists.
//
//   Movies           -> videos            /item/{type}/{id}
//   Shows            -> channels          /show/{type}/{id}
//   Seasons          -> playlists         /show/{type}/{id}/season/{n|first|all}
//   Episodes         -> videos            /show/{type}/{id}/video/{videoId}
//   Genres           -> channels          /genre/{type}/{genre}
//   Live TV channels -> channels          /live/{list}/{channelId}
//   Live broadcast   -> live videos       /live/{list}/{channelId}/watch
//
// The built-in addon list below is replaced by build.py from plugin.json. More addons, and live
// channel lists, can be pasted on the install page (see enabledAddons and liveLists).

const ADDONS = /*@ADDONS@*/[
    { "name": "Cinemeta", "url": "https://v3-cinemeta.strem.io/manifest.json" },
    { "name": "OpenSubtitles", "url": "https://opensubtitles-v3.strem.io/manifest.json" }
]/*@END@*/;

const BASE = "https://addon-bridge.invalid";
const SERIES_TYPES = ["series", "anime", "channel"];
const PAGE_SIZE = 30;
const SEASON_PAGE_SIZE = 200;
const MAX_HOME_CATALOGS = 8;
const MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;
const META_TTL_MS = 15 * 60 * 1000;
const MAX_SUBS_PER_LANGUAGE = 4;
const LIVE_TTL_MS = 5 * 60 * 1000;
const LIVE_PER_HOME_PAGE = 8;
const LIVE_SEARCH_LIMIT = 30;

// Must match the option order in build.py.
const MAX_HEIGHT_OPTIONS = [Infinity, 2160, 1080, 720, 480];
const SUB_LANGUAGES = [
    null, // all languages
    ["eng", "en", "English"], ["spa", "es", "Spanish"], ["por", "pt", "Portuguese"],
    ["fre", "fr", "French"], ["ger", "de", "German"], ["ita", "it", "Italian"],
    ["dut", "nl", "Dutch"], ["pol", "pl", "Polish"], ["rus", "ru", "Russian"],
    ["tur", "tr", "Turkish"], ["ara", "ar", "Arabic"], ["hin", "hi", "Hindi"],
    ["jpn", "ja", "Japanese"], ["kor", "ko", "Korean"], ["chi", "zh", "Chinese"]
];
const LANGUAGE_NAMES = {};
SUB_LANGUAGES.forEach(l => { if (l) { LANGUAGE_NAMES[l[0]] = l[2]; LANGUAGE_NAMES[l[1]] = l[2]; } });
Object.assign(LANGUAGE_NAMES, {
    fra: "French", deu: "German", nld: "Dutch", zho: "Chinese", pob: "Portuguese (BR)",
    swe: "Swedish", nor: "Norwegian", dan: "Danish", fin: "Finnish", gre: "Greek",
    heb: "Hebrew", hun: "Hungarian", cze: "Czech", rum: "Romanian", bul: "Bulgarian",
    hrv: "Croatian", srp: "Serbian", ukr: "Ukrainian", vie: "Vietnamese", tha: "Thai",
    ind: "Indonesian", may: "Malay", per: "Persian"
});

let config = {};
let settings = {};
let state = { manifests: {} };
let pastedAddons = [];
let pastedLive = [];
let liveCache = { at: 0, lists: [] };
const metaCache = {};

// ---------------------------------------------------------------- lifecycle

source.enable = function (conf, pluginSettings, savedState) {
    config = conf ?? {};
    settings = pluginSettings ?? {};
    pastedAddons = readPastedUrls(config.sourceUrl, "addons");
    pastedLive = readPastedUrls(config.sourceUrl, "live");
    liveCache = { at: 0, lists: [] };
    state = { manifests: {} };
    if (savedState) {
        try {
            const parsed = JSON.parse(savedState);
            if (parsed && parsed.manifests) state = parsed;
        } catch (e) {
            log("Movies TV Live: ignoring unreadable saved state");
        }
    }
};

source.disable = function () { };

source.saveState = function () {
    return JSON.stringify(state);
};

// ---------------------------------------------------------------- home & search

source.getHome = function () {
    const mode = settingIndex("homeContent", 0); // 0 everything, 1 movies, 2 shows, 3 live TV
    const live = mode === 0 || mode === 3 ? allLiveChannels().map(liveVideo) : [];
    if (mode === 3 && live.length) return new ArrayPager(live, 0, PAGE_SIZE);
    const entries = [];
    for (const addon of activeAddons()) {
        for (const cat of addon.manifest.catalogs || []) {
            const isShow = isSeriesType(cat.type);
            if ((mode === 1 && isShow) || (mode === 2 && !isShow)) continue;
            const extra = requiredExtras(cat, {});
            if (!extra) continue;
            entries.push(catalogEntry(addon, cat, extra));
        }
    }
    return new CatalogPager(entries.slice(0, MAX_HOME_CATALOGS), {}, null, live, LIVE_PER_HOME_PAGE);
};

source.searchSuggestions = function () { return []; };

source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [], filters: [] };
};

source.search = function (query) {
    const live = searchLive(query).map(liveVideo);
    return new CatalogPager(searchEntries(query, null), {}, null, live, LIVE_SEARCH_LIMIT);
};

source.searchChannels = function (query) {
    const live = searchLive(query).map(liveChannel);
    const page = fetchCatalogPage(searchEntries(query, true), {});
    const channels = page.items
        .filter(x => isSeriesType(x.type))
        .map(x => new PlatformChannel({
            id: pid("show:" + x.type + ":" + x.meta.id),
            name: x.meta.name,
            thumbnail: x.meta.poster,
            banner: landscapeImage(x.meta),
            subscribers: 0,
            description: x.meta.description || x.meta.releaseInfo || "",
            url: showUrl(x.type, x.meta.id)
        }));
    return new ChannelPager(live.concat(channels), false, {});
};

source.searchPlaylists = function (query) {
    const page = fetchCatalogPage(searchEntries(query, true), {});
    const playlists = page.items
        .filter(x => isSeriesType(x.type))
        .map(x => showAsPlaylist(x.meta, x.type));
    return new PlaylistPager(playlists, false, {});
};

// ---------------------------------------------------------------- channels (shows & genres)

source.isChannelUrl = function (url) {
    return RE_SHOW.test(url) || RE_GENRE.test(url) || RE_LIVE.test(url);
};

source.getChannel = function (url) {
    let m = url.match(RE_LIVE);
    if (m) return liveChannel(requireLiveChannel(dec(m[1]), dec(m[2])));
    m = url.match(RE_SHOW);
    if (m) {
        const type = dec(m[1]), id = dec(m[2]);
        const meta = requireMeta(type, id);
        const links = {};
        const imdb = imdbUrl(id);
        if (imdb) links["IMDb"] = imdb;
        return new PlatformChannel({
            id: pid("show:" + type + ":" + id),
            name: meta.name || id,
            thumbnail: meta.poster,
            banner: landscapeImage(meta),
            subscribers: 0,
            description: describeTitle(meta),
            url: showUrl(type, id),
            links: links
        });
    }
    m = url.match(RE_GENRE);
    if (m) {
        const type = dec(m[1]), genre = dec(m[2]);
        return new PlatformChannel({
            id: pid("genre:" + type + ":" + genre),
            name: genreLabel(type, genre),
            subscribers: 0,
            description: "Popular " + genreLabel(type, genre).toLowerCase() + " from your addons.",
            url: genreUrl(type, genre)
        });
    }
    throw new ScriptException("Not a Movies TV Live channel: " + url);
};

source.getChannelCapabilities = function () {
    return { types: [Type.Feed.Videos], sorts: [Type.Order.Chronological], filters: [] };
};

source.getChannelContents = function (url) {
    let m = url.match(RE_LIVE);
    if (m) return new ListPager([liveVideo(requireLiveChannel(dec(m[1]), dec(m[2])))], 0, PAGE_SIZE);
    m = url.match(RE_SHOW);
    if (m) {
        const type = dec(m[1]), id = dec(m[2]);
        const meta = requireMeta(type, id);
        const includeSpecials = settingBool("includeSpecials", false);
        const episodes = playableEpisodes(meta)
            .filter(v => includeSpecials || num(v.season) !== 0)
            .sort(newestFirst)
            .map(v => episodeVideo(meta, type, v));
        return new ListPager(episodes, 0, PAGE_SIZE);
    }
    m = url.match(RE_GENRE);
    if (m) {
        return new CatalogPager(genreEntries(dec(m[1]), dec(m[2])), {});
    }
    return new ContentPager([], false, {});
};

source.getChannelPlaylists = function (url) {
    const m = url.match(RE_SHOW);
    if (!m) return new PlaylistPager([], false, {});
    const type = dec(m[1]), id = dec(m[2]);
    const meta = requireMeta(type, id);
    const playlists = seasonsOf(meta).map(season => {
        const eps = season.episodes;
        return new PlatformPlaylist({
            id: pid("season:" + type + ":" + id + ":" + season.key),
            name: season.name,
            thumbnail: (eps[0] && eps[0].thumbnail) || landscapeImage(meta),
            author: showAuthor(meta, type),
            datetime: toSeconds(eps[0] && (eps[0].released || eps[0].firstAired)),
            url: seasonUrl(type, id, season.key),
            videoCount: eps.length
        });
    });
    return new PlaylistPager(playlists, false, {});
};

// ---------------------------------------------------------------- playlists (seasons)

source.isPlaylistUrl = function (url) {
    return RE_SEASON.test(url);
};

source.getPlaylist = function (url) {
    const m = url.match(RE_SEASON);
    if (!m) throw new ScriptException("Not a Movies TV Live season: " + url);
    const type = dec(m[1]), id = dec(m[2]), wanted = dec(m[3]);
    const meta = requireMeta(type, id);
    const seasons = seasonsOf(meta);
    if (!seasons.length) throw new UnavailableException("No episodes are listed for " + (meta.name || id));

    let season;
    if (wanted === "first") season = seasons.find(s => s.key !== "0") || seasons[0];
    else season = seasons.find(s => s.key === wanted);
    if (!season) throw new UnavailableException((meta.name || id) + " has no season " + wanted);

    const videos = season.episodes.map(v => episodeVideo(meta, type, v));
    return new PlatformPlaylistDetails({
        id: pid("season:" + type + ":" + id + ":" + season.key),
        name: (meta.name || id) + " · " + season.name,
        thumbnail: (season.episodes[0] && season.episodes[0].thumbnail) || landscapeImage(meta),
        author: showAuthor(meta, type),
        url: seasonUrl(type, id, season.key),
        videoCount: videos.length,
        contents: new ListPager(videos, 0, SEASON_PAGE_SIZE)
    });
};

// ---------------------------------------------------------------- content details

source.isContentDetailsUrl = function (url) {
    return RE_ITEM.test(url) || RE_EPISODE.test(url) || RE_LIVE_WATCH.test(url);
};

source.getContentDetails = function (url) {
    let m = url.match(RE_LIVE_WATCH);
    if (m) return liveDetails(requireLiveChannel(dec(m[1]), dec(m[2])));
    m = url.match(RE_EPISODE);
    if (m) {
        const type = dec(m[1]), showId = dec(m[2]), videoId = dec(m[3]);
        const bundle = fetchDetailsBundle(type, showId, type, videoId);
        const meta = bundle.meta || { id: showId, name: showId, videos: [] };
        const video = (meta.videos || []).find(v => v.id === videoId) || { id: videoId };
        const base = episodeVideo(meta, type, video);
        const details = new PlatformVideoDetails(Object.assign({}, base, {
            description: describeEpisode(meta, video),
            video: new VideoSourceDescriptor(bundle.sources),
            subtitles: bundle.subtitles
        }));
        details.getContentRecommendations = function () {
            const eps = playableEpisodes(meta).sort(airOrder);
            const idx = eps.findIndex(v => v.id === videoId);
            const next = (idx >= 0 ? eps.slice(idx + 1) : eps).slice(0, 20);
            return new VideoPager(next.map(v => episodeVideo(meta, type, v)), false, {});
        };
        return details;
    }

    m = url.match(RE_ITEM);
    if (m) {
        const type = dec(m[1]), id = dec(m[2]);
        const bundle = fetchDetailsBundle(type, id, type, id);
        const meta = bundle.meta || { id: id, name: id, type: type };
        const base = titleVideo(meta, type);
        const details = new PlatformVideoDetails(Object.assign({}, base, {
            description: describeTitle(meta),
            video: new VideoSourceDescriptor(bundle.sources),
            subtitles: bundle.subtitles
        }));
        const genre = firstGenre(meta);
        details.getContentRecommendations = function () {
            return new CatalogPager(genreEntries(type, genre || "All"), {}, id);
        };
        return details;
    }

    throw new ScriptException("Not a Movies TV Live item: " + url);
};

// Fetches meta, streams and subtitles in one parallel batch.
function fetchDetailsBundle(metaType, metaId, streamType, streamId) {
    const addons = activeAddons();
    const cachedMeta = cacheGet(metaType, metaId);
    const metaAddon = cachedMeta ? null : addons.find(a => supports(a.manifest, "meta", metaType, metaId));
    const streamAddons = addons.filter(a => supports(a.manifest, "stream", streamType, streamId));
    const subAddons = settingBool("subtitlesEnabled", true)
        ? addons.filter(a => supports(a.manifest, "subtitles", streamType, streamId))
        : [];

    if (!streamAddons.length) {
        throw new UnavailableException("None of your enabled addons provide streams for this title. " +
            "Paste a stream addon's manifest URL on the plugin's install page and install again.");
    }

    const urls = [];
    if (metaAddon) urls.push(resourceUrl(metaAddon.base, "meta", metaType, metaId));
    streamAddons.forEach(a => urls.push(resourceUrl(a.base, "stream", streamType, streamId)));
    subAddons.forEach(a => urls.push(resourceUrl(a.base, "subtitles", streamType, streamId)));
    const results = getJsonMany(urls);

    let i = 0;
    let meta = cachedMeta;
    if (metaAddon) {
        const r = results[i++];
        if (r && r.meta) { meta = r.meta; cachePut(metaType, metaId, meta); }
    }
    const streams = [];
    streamAddons.forEach(a => {
        const r = results[i++];
        ((r && r.streams) || []).forEach(s => streams.push({ stream: s, addon: a }));
    });
    const extraSubs = [];
    subAddons.forEach(() => {
        const r = results[i++];
        ((r && r.subtitles) || []).forEach(s => extraSubs.push(s));
    });

    const duration = runtimeSeconds(meta && meta.runtime);
    const sources = buildSources(streams, duration, meta && meta.name);
    if (!sources.length) {
        const torrentOnly = streams.filter(x => x.stream && x.stream.infoHash && !x.stream.url).length;
        if (torrentOnly) {
            throw new UnavailableException("Found " + torrentOnly + " stream(s), but they are torrent-only. " +
                "Grayjay can only play direct HTTP/HLS/DASH links.");
        }
        throw new UnavailableException("No playable streams were found for this title.");
    }

    const streamSubs = [];
    streams.forEach(x => (x.stream.subtitles || []).forEach(s => streamSubs.push(s)));
    return { meta: meta, sources: sources, subtitles: buildSubtitles(streamSubs.concat(extraSubs)) };
}

// ---------------------------------------------------------------- streams -> Grayjay sources

function buildSources(streams, duration, titleName) {
    const seen = {};
    let candidates = [];
    streams.forEach((x, order) => {
        const s = x.stream;
        if (!s || typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) return;
        if (seen[s.url]) return;
        seen[s.url] = true;
        const hints = s.behaviorHints || {};
        const text = [s.name, s.title, s.description, hints.filename].filter(Boolean).join(" ");
        const kind = streamKind(s.url, hints.filename, text);
        candidates.push({
            stream: s, addon: x.addon, hints: hints, kind: kind, order: order,
            height: detectHeight(text), compat: compatibility(text, kind)
        });
    });

    const maxHeight = MAX_HEIGHT_OPTIONS[settingIndex("maxResolution", 0)] ?? Infinity;
    const capped = candidates.filter(c => c.height === 0 || c.height <= maxHeight);
    if (capped.length) candidates = capped;

    if (settingIndex("streamOrder", 0) === 0) {
        candidates.sort((a, b) => (b.height - a.height) || (b.compat.score - a.compat.score) || (a.order - b.order));
    }

    // Grayjay starts playback with a "priority" source when there is one (closest to the user's
    // preferred quality). Flag the streams a phone is most likely to decode, so the default pick
    // isn't a 4K HEVC/TrueHD remux. Plain files are preferred over HLS when any qualify.
    const okFiles = candidates.some(c => c.kind === "file" && c.compat.ok);
    const isPriority = c => c.compat.ok && (!okFiles || c.kind === "file");
    const usedAreas = {};

    return candidates.map(c => {
        const s = c.stream;
        const common = {
            name: streamLabel(s, c.addon, titleName),
            url: s.url,
            duration: duration,
            priority: isPriority(c),
            requestModifier: { headers: playbackHeaders(c.hints) }
        };
        if (c.kind === "hls") return new HLSSource(common);
        if (c.kind === "dash") return new DashSource(common);

        // With "Simplify sources" on (the default), Grayjay's quality menu keeps one source per
        // width x height. Nudge the width so every stream stays selectable.
        let height = c.height || 1;
        let width = c.height ? Math.round(c.height * 16 / 9) : 1;
        while (usedAreas[width * height]) { if (c.height) width--; else width++; }
        usedAreas[width * height] = true;

        const source = new VideoUrlSource(Object.assign(common, {
            width: width,
            height: height,
            container: containerOf(s.url, c.hints.filename),
            codec: streamDetails(c),
            bitrate: 0 // non-zero bitrates make Grayjay default to the smallest file
        }));
        source.priority = common.priority; // the runtime's constructor drops it; the app reads it
        return source;
    });
}

// Grayjay's player sends a desktop Firefox user agent, which some file hosts reject
// (e.g. HTTP 428). Send a media player one instead, unless the addon asks for its own.
const PLAYER_USER_AGENT = "VLC/3.0.20 LibVLC/3.0.20";

function playbackHeaders(hints) {
    const headers = { "User-Agent": PLAYER_USER_AGENT };
    const req = (hints.proxyHeaders && hints.proxyHeaders.request) || {};
    Object.keys(req).forEach(k => {
        if (typeof req[k] === "string" && req[k]) headers[canonicalHeader(k)] = req[k];
    });
    return headers;
}

function canonicalHeader(name) {
    return String(name).trim().split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("-");
}

// Rough guess, from the release name, at whether a phone can play a stream.
//   ok:      plain H.264-style video and audio; eligible to be Grayjay's default pick.
//   problem: something most phones can't decode (shown with a warning sign in the menu).
function compatibility(text, kind) {
    const t = (text || "").toLowerCase();
    const tags = [];
    let score = 0, problem = false, risky = false;
    if (/\b(x265|h\.?265|hevc|hvc1)\b/.test(t)) { tags.push("HEVC"); score -= 1; risky = true; }
    else if (/\bav1\b/.test(t)) { tags.push("AV1"); score -= 3; problem = true; }
    else if (/\b(x264|h\.?264|avc1?)\b/.test(t)) { tags.push("H.264"); score += 1; }
    if (/10.?bit/.test(t)) { tags.push("10-bit"); score -= 1; risky = true; }
    if (/\b(dv|dovi)\b|dolby.?vision/.test(t)) { tags.push("DV"); score -= 3; problem = true; }
    else if (/\bhdr(10)?\+?\b/.test(t)) { tags.push("HDR"); score -= 1; risky = true; }
    if (/\bremux\b/.test(t)) { tags.push("Remux"); score -= 1; risky = true; }
    if (/truehd/.test(t)) { tags.push("TrueHD"); score -= 3; problem = true; }
    else if (/\bdts\b|dts.?hd/.test(t)) { tags.push("DTS"); score -= 3; problem = true; }
    if (kind === "file" && /\bmp4\b|\.mp4\b/.test(t)) score += 1;
    return { score: score, tags: tags, problem: problem, ok: !problem && !risky };
}

// Second line of Grayjay's quality menu: codec info, file size, and a warning for risky files.
function streamDetails(c) {
    const parts = c.compat.tags.slice();
    const size = Number(c.hints.videoSize);
    if (size > 0) parts.push(humanBytes(size));
    const text = parts.join(" · ");
    return c.compat.problem ? "⚠ " + text : text;
}

function humanBytes(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
    return Math.round(n / 1e6) + " MB";
}

function streamLabel(s, addon, titleName) {
    const name = oneLine(s.name) || addon.name || "Stream";
    const title = (titleName || "").toLowerCase();
    // Skip description lines that only repeat the title or the stream name.
    const detail = String(s.description || s.title || "").split("\n")
        .map(oneLine)
        .find(l => l && !(title && l.toLowerCase().indexOf(title) >= 0) && name.indexOf(l) < 0);
    let label = name;
    if (detail) label += " · " + detail;
    return label.length > 100 ? label.substring(0, 97) + "..." : label;
}

function detectHeight(text) {
    const t = (text || "").toLowerCase();
    if (/2160p|\b4k\b|\buhd\b/.test(t)) return 2160;
    if (/1440p|\b2k\b|\bqhd\b/.test(t)) return 1440;
    if (/1080p|\bfhd\b|full ?hd/.test(t)) return 1080;
    if (/720p|\bhd\b/.test(t)) return 720;
    if (/576p/.test(t)) return 576;
    if (/480p|\bsd\b/.test(t)) return 480;
    if (/360p/.test(t)) return 360;
    if (/240p/.test(t)) return 240;
    return 0;
}

function streamKind(url, filename, text) {
    const path = url.split(/[?#]/)[0].toLowerCase();
    const file = String(filename || "").split("|")[0].toLowerCase();
    const both = path + " " + file;
    if (/\.m3u8\b/.test(both) || /[?&](format|type|ext)=m3u8/i.test(url)) return "hls";
    if (/\.mpd\b/.test(both) || /[?&](format|type|ext)=mpd/i.test(url)) return "dash";
    if (/\.(mkv|mp4|m4v|webm|avi|mov|ts)\b/.test(both)) return "file";
    // Playlists served without an extension: trust the addon's own description ("720p • HLS").
    if (/\/hls\//.test(path) || /(^|[^a-z0-9])hls([^a-z0-9]|$)/i.test(text || "")) return "hls";
    if (/\/dash\//.test(path) || /(^|[^a-z0-9])(mpeg-)?dash([^a-z0-9]|$)/i.test(text || "")) return "dash";
    return "file";
}

function containerOf(url, filename) {
    const path = ((filename || "") + " " + url.split(/[?#]/)[0]).toLowerCase();
    if (/\.mkv\b/.test(path)) return "video/x-matroska";
    if (/\.webm\b/.test(path)) return "video/webm";
    if (/\.avi\b/.test(path)) return "video/x-msvideo";
    if (/\.mov\b/.test(path)) return "video/quicktime";
    if (/\.ts\b/.test(path)) return "video/mp2t";
    return "video/mp4";
}

// ---------------------------------------------------------------- subtitles

function buildSubtitles(subs) {
    const wanted = SUB_LANGUAGES[settingIndex("subtitleLanguage", 1)] || null;
    const seen = {};
    const perLanguage = {};
    const out = [];
    subs.forEach(s => {
        if (!s || typeof s.url !== "string" || !/^https?:\/\//i.test(s.url) || seen[s.url]) return;
        const lang = (s.lang || s.language || "").toLowerCase();
        if (wanted && lang !== wanted[0] && lang !== wanted[1] && !lang.startsWith(wanted[1] + "-")) return;
        const count = perLanguage[lang] = (perLanguage[lang] || 0) + 1;
        if (count > MAX_SUBS_PER_LANGUAGE) return;
        seen[s.url] = true;
        const label = LANGUAGE_NAMES[lang] || s.label || lang || "Subtitles";
        out.push({
            name: count > 1 ? label + " " + count : label,
            url: s.url,
            format: subtitleFormat(s.url + " " + (s.subtitleFileName || "")),
            language: lang || undefined
        });
    });
    return out;
}

function subtitleFormat(text) {
    const t = text.toLowerCase();
    if (/\.vtt\b/.test(t)) return "text/vtt";
    if (/\.(ass|ssa)\b/.test(t)) return "text/x-ssa";
    if (/\.ttml\b|\.dfxp\b/.test(t)) return "application/ttml+xml";
    return "application/x-subrip";
}

// ---------------------------------------------------------------- catalogs

function catalogEntry(addon, cat, extra) {
    return {
        base: addon.base,
        type: cat.type,
        id: cat.id,
        extra: extra,
        skip: 0,
        canSkip: extrasOf(cat).some(e => e.name === "skip"),
        done: false
    };
}

function extrasOf(cat) {
    const extras = (cat.extra || []).map(e => Object.assign({}, e));
    (cat.extraSupported || []).forEach(n => {
        if (!extras.some(e => e.name === n)) extras.push({ name: n });
    });
    (cat.extraRequired || []).forEach(n => {
        const e = extras.find(x => x.name === n);
        if (e) e.isRequired = true;
        else extras.push({ name: n, isRequired: true });
    });
    return extras;
}

// Returns the extras to send, or null if a required extra can't be satisfied.
function requiredExtras(cat, provided) {
    const extra = Object.assign({}, provided);
    for (const e of extrasOf(cat)) {
        if (!e.isRequired || extra[e.name] !== undefined) continue;
        if (e.name === "genre" && e.options && e.options.length) extra.genre = e.options[0];
        else return null;
    }
    return extra;
}

// onlySeries: true = show catalogs only, null = everything.
function searchEntries(query, onlySeries) {
    const entries = [];
    for (const addon of activeAddons()) {
        for (const cat of addon.manifest.catalogs || []) {
            if (onlySeries && !isSeriesType(cat.type)) continue;
            if (!extrasOf(cat).some(e => e.name === "search")) continue;
            const extra = requiredExtras(cat, { search: query });
            if (extra) entries.push(catalogEntry(addon, cat, extra));
        }
    }
    return entries;
}

function genreEntries(type, genre) {
    const entries = [];
    for (const addon of activeAddons()) {
        for (const cat of addon.manifest.catalogs || []) {
            if (cat.type !== type) continue;
            if (genre === "All") {
                const extra = requiredExtras(cat, {});
                if (extra && !extra.genre) entries.push(catalogEntry(addon, cat, extra));
                continue;
            }
            const g = extrasOf(cat).find(e => e.name === "genre");
            if (!g || (g.options && g.options.length && g.options.indexOf(genre) < 0)) continue;
            const extra = requiredExtras(cat, { genre: genre });
            if (extra) entries.push(catalogEntry(addon, cat, extra));
        }
    }
    return entries.slice(0, 3);
}

// Fetches the next page of every unfinished catalog in parallel and interleaves the results.
function fetchCatalogPage(entries, seen) {
    const active = entries.filter(e => !e.done);
    const urls = active.map(e => {
        const extra = Object.assign({}, e.extra);
        if (e.skip) extra.skip = e.skip;
        return catalogUrl(e.base, e.type, e.id, extra);
    });
    const results = getJsonMany(urls);
    const lists = active.map((e, i) => {
        const metas = ((results[i] && results[i].metas) || []).filter(m => m && m.id && m.name);
        e.skip += metas.length;
        if (!metas.length || !e.canSkip) e.done = true;
        return metas.map(m => ({ meta: m, type: m.type || e.type }));
    });
    const items = [];
    for (let k = 0; ; k++) {
        let any = false;
        for (const list of lists) {
            if (k >= list.length) continue;
            any = true;
            const key = list[k].type + ":" + list[k].meta.id;
            if (seen[key]) continue;
            seen[key] = true;
            items.push(list[k]);
        }
        if (!any) break;
    }
    return { items: items, hasMore: entries.some(e => !e.done) };
}

// Catalog results, optionally led on each page by the next `chunk` of `extras` (live videos).
class CatalogPager extends ContentPager {
    constructor(entries, seen, excludeId, extras, chunk, offset) {
        extras = extras || [];
        offset = offset || 0;
        const lead = extras.slice(offset, offset + (chunk || 0));
        const page = fetchCatalogPage(entries, seen);
        const results = page.items
            .filter(x => !(excludeId && x.meta.id === excludeId))
            .map(x => isSeriesType(x.type) ? showAsPlaylist(x.meta, x.type) : titleVideo(x.meta, x.type));
        const next = offset + lead.length;
        super(lead.concat(results), page.hasMore || next < extras.length, {});
        this.entries = entries;
        this.seen = seen;
        this.excludeId = excludeId;
        this.extras = extras;
        this.chunk = chunk;
        this.offset = next;
    }
    nextPage() {
        return new CatalogPager(this.entries, this.seen, this.excludeId, this.extras, this.chunk, this.offset);
    }
}

class ArrayPager extends ContentPager {
    constructor(all, offset, size) {
        super(all.slice(offset, offset + size), offset + size < all.length, { offset: offset });
        this.all = all;
        this.size = size;
    }
    nextPage() {
        return new ArrayPager(this.all, this.context.offset + this.size, this.size);
    }
}

class ListPager extends VideoPager {
    constructor(all, offset, size) {
        super(all.slice(offset, offset + size), offset + size < all.length, { offset: offset });
        this.all = all;
        this.size = size;
    }
    nextPage() {
        return new ListPager(this.all, this.context.offset + this.size, this.size);
    }
}

// ---------------------------------------------------------------- Grayjay objects

function titleVideo(meta, type) {
    const imdb = imdbUrl(meta.id);
    return new PlatformVideo({
        id: pid("item:" + type + ":" + meta.id),
        name: meta.name || meta.id,
        thumbnails: thumbnailsFor(landscapeImage(meta) || meta.poster),
        author: genreAuthor(type, firstGenre(meta) || "All"),
        datetime: toSeconds(meta.released) || yearSeconds(meta.releaseInfo || meta.year),
        duration: runtimeSeconds(meta.runtime),
        url: itemUrl(type, meta.id),
        shareUrl: imdb || undefined,
        isLive: false
    });
}

function showAsPlaylist(meta, type) {
    return new PlatformPlaylist({
        id: pid("season:" + type + ":" + meta.id + ":first"),
        name: meta.name || meta.id,
        thumbnail: landscapeImage(meta) || meta.poster,
        thumbnails: thumbnailsFor(landscapeImage(meta) || meta.poster),
        author: showAuthor(meta, type),
        datetime: toSeconds(meta.released) || yearSeconds(meta.releaseInfo || meta.year),
        url: seasonUrl(type, meta.id, "first"),
        videoCount: -1
    });
}

function episodeVideo(meta, type, v) {
    const s = num(v.season);
    const e = num(v.episode ?? v.number);
    const code = s !== null && e !== null ? "S" + pad(s) + "E" + pad(e) : "";
    const title = v.name || v.title || (e !== null ? "Episode " + e : v.id);
    return new PlatformVideo({
        id: pid("episode:" + type + ":" + v.id),
        name: code ? code + " · " + title : title,
        thumbnails: thumbnailsFor(v.thumbnail || landscapeImage(meta) || meta.poster),
        author: showAuthor(meta, type),
        datetime: toSeconds(v.released || v.firstAired),
        duration: runtimeSeconds(meta.runtime),
        url: episodeUrl(type, meta.id, v.id),
        isLive: false
    });
}

function showAuthor(meta, type) {
    return new PlatformAuthorLink(pid("show:" + type + ":" + meta.id), meta.name || meta.id,
        showUrl(type, meta.id), meta.poster);
}

function genreAuthor(type, genre) {
    return new PlatformAuthorLink(pid("genre:" + type + ":" + genre), genreLabel(type, genre),
        genreUrl(type, genre), undefined);
}

function genreLabel(type, genre) {
    const plural = type === "movie" ? "Movies" : type === "tv" ? "TV" : capitalize(type);
    return genre === "All" ? "Popular " + plural : genre + " " + plural;
}

function thumbnailsFor(url) {
    return new Thumbnails(url ? [new Thumbnail(url, 720)] : []);
}

function landscapeImage(meta) {
    if (meta.background) return meta.background;
    if (/^tt\d+$/.test(meta.id || "")) return "https://images.metahub.space/background/medium/" + meta.id + "/img";
    return null;
}

function describeTitle(meta) {
    const parts = [];
    if (meta.description) parts.push(meta.description);
    const facts = [meta.releaseInfo || meta.year, meta.runtime, (meta.genres || meta.genre || []).join(", "),
        meta.imdbRating ? "IMDb " + meta.imdbRating : null].filter(Boolean);
    if (facts.length) parts.push(facts.join(" · "));
    if (meta.director && meta.director.length) parts.push("Director: " + [].concat(meta.director).join(", "));
    if (meta.cast && meta.cast.length) parts.push("Cast: " + [].concat(meta.cast).slice(0, 8).join(", "));
    return parts.join("\n\n");
}

function describeEpisode(meta, v) {
    const parts = [];
    const overview = v.overview || v.description;
    if (overview) parts.push(overview);
    const s = num(v.season), e = num(v.episode ?? v.number);
    const facts = [meta.name, s !== null ? (s === 0 ? "Specials" : "Season " + s) : null,
        e !== null ? "Episode " + e : null];
    const aired = v.released || v.firstAired;
    if (aired && !isNaN(Date.parse(aired))) facts.push("Aired " + new Date(aired).toISOString().substring(0, 10));
    parts.push(facts.filter(Boolean).join(" · "));
    return parts.join("\n\n");
}

// ---------------------------------------------------------------- episodes & seasons

function playableEpisodes(meta) {
    const hideUnreleased = settingBool("hideUnreleased", true);
    const now = Date.now();
    return (meta.videos || []).filter(v => {
        if (!v || !v.id) return false;
        if (!hideUnreleased) return true;
        const t = Date.parse(v.released || v.firstAired || "");
        return isNaN(t) || t <= now;
    });
}

function seasonsOf(meta) {
    const groups = {};
    playableEpisodes(meta).forEach(v => {
        const s = num(v.season);
        const key = s === null ? "all" : String(s);
        (groups[key] = groups[key] || []).push(v);
    });
    return Object.keys(groups)
        .sort((a, b) => seasonRank(a) - seasonRank(b))
        .map(key => ({
            key: key,
            name: key === "all" ? "All episodes" : key === "0" ? "Specials" : "Season " + key,
            episodes: groups[key].sort(airOrder)
        }));
}

function seasonRank(key) {
    if (key === "all") return -1;
    if (key === "0") return 1e9; // specials last
    return parseInt(key);
}

function airOrder(a, b) {
    return ((num(a.season) ?? 0) - (num(b.season) ?? 0)) ||
        ((num(a.episode ?? a.number) ?? 0) - (num(b.episode ?? b.number) ?? 0)) ||
        ((Date.parse(a.released || "") || 0) - (Date.parse(b.released || "") || 0));
}

function newestFirst(a, b) {
    const ta = Date.parse(a.released || a.firstAired || "") || 0;
    const tb = Date.parse(b.released || b.firstAired || "") || 0;
    return (tb - ta) || -airOrder(a, b);
}

// ---------------------------------------------------------------- live TV
//
// A live channel list is a JSON file the user pastes on the install page, shaped like
//   { "name": "...", "baseUrl": "https://site/embed/", "variant": "embed",
//     "channels": [{ "id", "name", "region", "flag", "quality", "sport", "live", "url" }] }
// Each channel becomes a Grayjay channel whose only video is its live broadcast.
//
// Where a channel's stream comes from, first match wins:
//   1. a stream field on the channel: "stream", "streamUrl", "m3u8" or "hls"
//   2. the channel's "url" when it is an .m3u8 playlist
//   3. a "streamUrl" template on the list, with {id} replaced by the channel id
//   4. for "variant": "embed" lists, the site's IPTV endpoint: https://iptv.<host>/api?channel={id}
// Now/next listings come from the list's "epg" URL, or epg.json next to the list.
// Requests carry the list site's Referer and Origin unless the list gives "headers".

function liveLists() {
    if (!pastedLive.length) return [];
    if (liveCache.at && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.lists;

    const guessEpg = url => url.replace(/[?#].*$/, "").replace(/[^/]*$/, "epg.json");
    const results = getJsonMany(pastedLive.flatMap(url => [url, guessEpg(url)]));
    const keys = {};
    const lists = [];
    const declaredEpg = [];
    pastedLive.forEach((url, i) => {
        const json = results[i * 2];
        if (!json || !Array.isArray(json.channels)) {
            log("Movies TV Live: could not load live channel list " + hostOf(url));
            return;
        }
        let key = hostOf(url).replace(/^www\./, "");
        for (let n = 2; keys[key]; n++) key = hostOf(url) + "~" + n;
        keys[key] = true;
        const list = buildLiveList(key, url, json);
        const epgUrl = typeof json.epg === "string" ? json.epg : json.epgUrl;
        if (typeof epgUrl === "string" && /^https?:\/\//i.test(epgUrl) && epgUrl !== guessEpg(url)) {
            declaredEpg.push({ list: list, url: epgUrl });
        } else {
            list.epg = epgMap(results[i * 2 + 1]);
        }
        lists.push(list);
    });
    if (declaredEpg.length) {
        const epgs = getJsonMany(declaredEpg.map(d => d.url));
        declaredEpg.forEach((d, i) => { d.list.epg = epgMap(epgs[i]); });
    }

    // Keep the previous copy if every list failed to load (e.g. a brief outage).
    if (!lists.length && liveCache.lists.length) {
        liveCache.at = Date.now();
        return liveCache.lists;
    }
    liveCache = { at: Date.now(), lists: lists };
    return lists;
}

function buildLiveList(key, url, json) {
    const origin = originOf(json.baseUrl) || originOf(url);
    const headers = { "User-Agent": PLAYER_USER_AGENT };
    if (json.headers && typeof json.headers === "object") {
        Object.keys(json.headers).forEach(k => {
            if (typeof json.headers[k] === "string") headers[canonicalHeader(k)] = json.headers[k];
        });
    } else if (origin) {
        headers["Referer"] = origin + "/";
        headers["Origin"] = origin;
    }
    // "example.com embed manifest" -> "example.com"
    const name = oneLine(json.name).replace(/\s+(embed\s+)?(manifest|channel list|channels)$/i, "");
    const list = { key: key, url: url, name: name || hostOf(url), headers: headers, epg: {}, channels: [] };
    const seen = {};
    json.channels.forEach(c => {
        if (!c || c.id === undefined || c.id === null || c.live === false) return;
        const id = String(c.id);
        const name = oneLine(c.name) || id;
        if (seen[id] || /\[broken\]/i.test(name)) return;
        const stream = liveStreamUrl(c, json, url);
        if (!stream) return;
        seen[id] = true;
        list.channels.push({
            list: list, id: id, name: name, stream: stream,
            page: typeof c.url === "string" && /^https?:\/\//i.test(c.url) ? c.url : null,
            region: oneLine(c.region), flag: String(c.flag || "").toLowerCase(),
            quality: oneLine(c.quality), category: oneLine(c.sport || c.category || c.group),
            tagline: oneLine(c.tagline || c.description),
            logo: [c.logo, c.icon, c.thumbnail, c.image].find(x => typeof x === "string" && /^https?:\/\//i.test(x)) || null
        });
    });
    return list;
}

function liveStreamUrl(c, json, listUrl) {
    const isHttp = u => typeof u === "string" && /^https?:\/\//i.test(u);
    const own = [c.stream, c.streamUrl, c.m3u8, c.hls].find(isHttp);
    if (own) return own;
    if (isHttp(c.url) && /\.m3u8(\?|#|$)/i.test(c.url)) return c.url;
    const id = encodeURIComponent(String(c.id));
    if (isHttp(json.streamUrl) && json.streamUrl.indexOf("{id}") >= 0) return json.streamUrl.split("{id}").join(id);
    if (json.variant === "embed") {
        const host = hostOf(json.baseUrl || listUrl).replace(/^www\./, "");
        return "https://iptv." + host + "/api?channel=" + id;
    }
    return null;
}

function epgMap(json) {
    const map = {};
    ((json && json.channels) || []).forEach(e => { if (e && e.id !== undefined) map[String(e.id)] = e; });
    return map;
}

function allLiveChannels() {
    return liveLists().flatMap(l => l.channels);
}

function requireLiveChannel(key, id) {
    const list = liveLists().find(l => l.key === key);
    if (!list) {
        throw new UnavailableException("The live channel list from " + key + " isn't loaded. " +
            "Check that it is still pasted on the plugin's install page.");
    }
    const channel = list.channels.find(c => c.id === id);
    if (!channel) throw new UnavailableException(list.name + " no longer lists this channel.");
    return channel;
}

function searchLive(query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return allLiveChannels().filter(c => {
        const prog = nowNext(c).now;
        const text = [c.name, c.category, c.region, c.list.name, prog && prog.title].join(" ").toLowerCase();
        return words.every(w => text.indexOf(w) >= 0);
    });
}

// The current and next programme, skipping entries that have already ended.
function nowNext(c) {
    const e = c.list.epg[c.id];
    if (!e) return { now: null, next: null };
    const t = Date.now();
    const ended = p => p && Date.parse(p.stop || "") < t;
    let now = e.now || null, next = e.next || null;
    if (ended(now)) { now = ended(next) ? null : next; next = null; }
    return { now: now, next: next };
}

function liveImage(c) {
    if (c.logo) return c.logo;
    return /^[a-z]{2}$/.test(c.flag) ? "https://flagcdn.com/w320/" + c.flag + ".png" : null;
}

function liveAuthor(c) {
    return new PlatformAuthorLink(pid("live:" + c.list.key + ":" + c.id), c.name, liveChannelUrl(c), liveImage(c));
}

function liveChannel(c) {
    const prog = nowNext(c);
    const facts = [c.category, c.region || (c.flag ? c.flag.toUpperCase() : ""), c.quality, c.list.name].filter(Boolean);
    const parts = [c.tagline, facts.join(" · "), describeProgramme("Now", prog.now), describeProgramme("Next", prog.next)];
    const links = {};
    if (c.page) links[c.list.name] = c.page;
    return new PlatformChannel({
        id: pid("live:" + c.list.key + ":" + c.id),
        name: c.name,
        thumbnail: liveImage(c),
        subscribers: 0,
        description: parts.filter(Boolean).join("\n\n"),
        url: liveChannelUrl(c),
        links: links
    });
}

function liveVideo(c) {
    const prog = nowNext(c).now;
    return new PlatformVideo({
        id: pid("live:" + c.list.key + ":" + c.id + ":watch"),
        name: prog && prog.title ? oneLine(prog.title) : c.name + " (live)",
        thumbnails: thumbnailsFor(liveImage(c)),
        author: liveAuthor(c),
        datetime: toSeconds(prog && prog.start) || Math.floor(Date.now() / 1000),
        duration: 0,
        url: liveWatchUrl(c),
        isLive: true
    });
}

function liveDetails(c) {
    const prog = nowNext(c);
    checkLiveStream(c);
    const source = new HLSSource({
        name: [c.quality || "Live", c.list.name].join(" · "),
        url: c.stream,
        duration: 0,
        priority: true,
        requestModifier: { headers: Object.assign({}, c.list.headers) }
    });
    const details = new PlatformVideoDetails(Object.assign({}, liveVideo(c), {
        description: [c.name, describeProgramme("Now", prog.now), describeProgramme("Next", prog.next),
            c.tagline].filter(Boolean).join("\n\n"),
        video: new VideoSourceDescriptor([source]),
        live: source
    }));
    details.getContentRecommendations = function () {
        const others = allLiveChannels().filter(o => o !== c);
        const same = others.filter(o => c.category && o.category === c.category);
        const rest = others.filter(o => same.indexOf(o) < 0);
        return new VideoPager(same.concat(rest).slice(0, 20).map(liveVideo), false, {});
    };
    return details;
}

// A quick look before handing the stream to the player, so an offline channel gets a clear
// message instead of a spinning player. Network errors are ignored; the player gets its turn.
function checkLiveStream(c) {
    let res;
    try { res = http.GET(c.stream, c.list.headers, false); }
    catch (e) { log("Movies TV Live: could not check " + c.name + ": " + e); return; }
    if (!res.isOk || String(res.body || "").indexOf("#EXTM3U") < 0) {
        throw new UnavailableException(c.name + " is offline right now (HTTP " + res.code + "). Try another channel.");
    }
}

function describeProgramme(label, p) {
    if (!p || !p.title) return "";
    const times = [p.start, p.stop].map(clockTime).filter(Boolean).join("–");
    const head = label + (times ? " (" + times + ")" : "") + ": " + oneLine(p.title);
    return p.desc ? head + "\n" + oneLine(p.desc) : head;
}

function clockTime(iso) {
    const t = Date.parse(iso || "");
    if (isNaN(t)) return "";
    const d = new Date(t);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function originOf(url) {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(url || "");
    return m ? m[1] : null;
}

// ---------------------------------------------------------------- addons & manifests

// Built-in addons (from plugin.json, each with an on/off setting) followed by the addons the
// user pasted on the install page. Those arrive in the install link that Grayjay stores as
// config.sourceUrl, e.g. .../config.json?addons=<base64url JSON array of manifest URLs>.
function enabledAddons() {
    const seen = {};
    const builtIn = ADDONS.map((a, i) => {
        const base = addonBase(a.url);
        seen[base] = true;
        return { name: a.name, url: a.url, base: base, setting: "addon" + i };
    });
    const pasted = [];
    pastedAddons.forEach(url => {
        const base = addonBase(url);
        if (seen[base]) return;
        seen[base] = true;
        pasted.push({ name: hostOf(url), url: url, base: base, setting: null });
    });
    return builtIn.concat(pasted).filter(a => !a.setting || settingBool(a.setting, true));
}

// Reads a base64url JSON array of URLs from the install link, e.g. ?addons=... or &live=...
function readPastedUrls(sourceUrl, param) {
    const m = new RegExp("[?&]" + param + "=([A-Za-z0-9_-]+)").exec(sourceUrl || "");
    if (!m) return [];
    try {
        const list = JSON.parse(base64UrlDecode(m[1]));
        if (!Array.isArray(list)) return [];
        return list.filter(u => typeof u === "string" && /^(https?|stremio):\/\//i.test(u));
    } catch (e) {
        log("Movies TV Live: could not read the " + param + " list in the install link");
        return [];
    }
}

function base64UrlDecode(s) {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    let pct = "";
    for (let i = 0; i < bin.length; i++) pct += "%" + ("0" + bin.charCodeAt(i).toString(16)).slice(-2);
    return decodeURIComponent(pct);
}

function hostOf(url) {
    const m = /^[a-z]+:\/\/([^/?#:]+)/i.exec(url);
    return m ? m[1] : url;
}

function activeAddons() {
    const addons = enabledAddons();
    const now = Date.now();
    const stale = addons.filter(a => {
        const cached = state.manifests[a.base];
        return !cached || now - cached.fetchedAt > MANIFEST_TTL_MS;
    });
    if (stale.length) {
        const results = getJsonMany(stale.map(a => a.base + "/manifest.json"));
        stale.forEach((a, i) => {
            if (results[i] && results[i].id) state.manifests[a.base] = { fetchedAt: now, manifest: results[i] };
            else if (state.manifests[a.base]) state.manifests[a.base].fetchedAt = now; // keep stale copy, retry later
            else log("Movies TV Live: could not load manifest for " + a.name);
        });
    }
    return addons
        .filter(a => state.manifests[a.base])
        .map(a => {
            const manifest = state.manifests[a.base].manifest;
            return Object.assign({}, a, { manifest: manifest, name: a.setting ? a.name : (manifest.name || a.name) });
        });
}

function addonBase(url) {
    return String(url).trim()
        .replace(/^stremio:\/\//i, "https://")
        .replace(/\/manifest\.json(\?.*)?$/i, "")
        .replace(/\/+$/, "");
}

function supports(manifest, resource, type, id) {
    for (const r of manifest.resources || []) {
        const name = typeof r === "string" ? r : r && r.name;
        if (name !== resource) continue;
        const types = (typeof r === "object" && r.types) || manifest.types || [];
        const prefixes = (typeof r === "object" && r.idPrefixes) || manifest.idPrefixes;
        if (types.length && types.indexOf(type) < 0) continue;
        if (id && prefixes && prefixes.length && !prefixes.some(p => id.indexOf(p) === 0)) continue;
        return true;
    }
    return false;
}

function requireMeta(type, id) {
    const cached = cacheGet(type, id);
    if (cached) return cached;
    const addon = activeAddons().find(a => supports(a.manifest, "meta", type, id));
    if (!addon) throw new UnavailableException("None of your enabled addons provide details for " + id);
    const json = getJson(resourceUrl(addon.base, "meta", type, id));
    if (!json || !json.meta) throw new UnavailableException("No details found for " + id);
    cachePut(type, id, json.meta);
    return json.meta;
}

function cacheGet(type, id) {
    const hit = metaCache[type + ":" + id];
    return hit && Date.now() - hit.at < META_TTL_MS ? hit.meta : null;
}

function cachePut(type, id, meta) {
    const keys = Object.keys(metaCache);
    if (keys.length > 40) delete metaCache[keys[0]];
    metaCache[type + ":" + id] = { at: Date.now(), meta: meta };
}

// ---------------------------------------------------------------- HTTP

function resourceUrl(base, resource, type, id) {
    return base + "/" + resource + "/" + encodeURIComponent(type) + "/" + encodeId(id) + ".json";
}

function catalogUrl(base, type, id, extra) {
    const parts = Object.keys(extra || {})
        .filter(k => extra[k] !== undefined && extra[k] !== null && extra[k] !== "")
        .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(extra[k]));
    return base + "/catalog/" + encodeURIComponent(type) + "/" + encodeId(id) +
        (parts.length ? "/" + parts.join("&") : "") + ".json";
}

// Stremio ids like "tt0903747:1:2" keep their colons in addon URLs.
function encodeId(id) {
    return encodeURIComponent(id).replace(/%3A/gi, ":");
}

function getJson(url) {
    const res = http.GET(url, {}, false);
    if (!res.isOk) throw new ScriptException("Addon returned HTTP " + res.code + " for " + url);
    try {
        return JSON.parse(res.body);
    } catch (e) {
        throw new ScriptException("Addon returned invalid JSON for " + url);
    }
}

// Parallel GETs. Returns parsed JSON (or null on failure) in request order.
function getJsonMany(urls) {
    if (!urls.length) return [];
    let responses = null;
    if (urls.length > 1) {
        try {
            let batch = http.batch();
            urls.forEach(u => { batch = batch.GET(u, {}, false); });
            responses = batch.execute();
        } catch (e) {
            log("Movies TV Live: batch request failed, retrying one by one: " + e);
        }
    }
    return urls.map((u, i) => {
        let res = responses ? responses[i] : null;
        if (!responses) {
            try { res = http.GET(u, {}, false); }
            catch (e) { log("Movies TV Live: request failed " + u + ": " + e); return null; }
        }
        if (!res || !res.isOk || !res.body) return null;
        try { return JSON.parse(res.body); } catch (e) { return null; }
    });
}

// ---------------------------------------------------------------- URLs

const BASE_RE = BASE.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const SEG = "([^/?#]+)";
const RE_ITEM = new RegExp("^" + BASE_RE + "/item/" + SEG + "/" + SEG + "/?$");
const RE_SHOW = new RegExp("^" + BASE_RE + "/show/" + SEG + "/" + SEG + "/?$");
const RE_SEASON = new RegExp("^" + BASE_RE + "/show/" + SEG + "/" + SEG + "/season/" + SEG + "/?$");
const RE_EPISODE = new RegExp("^" + BASE_RE + "/show/" + SEG + "/" + SEG + "/video/" + SEG + "/?$");
const RE_GENRE = new RegExp("^" + BASE_RE + "/genre/" + SEG + "/" + SEG + "/?$");
const RE_LIVE = new RegExp("^" + BASE_RE + "/live/" + SEG + "/" + SEG + "/?$");
const RE_LIVE_WATCH = new RegExp("^" + BASE_RE + "/live/" + SEG + "/" + SEG + "/watch/?$");

function itemUrl(type, id) { return BASE + "/item/" + enc(type) + "/" + enc(id); }
function showUrl(type, id) { return BASE + "/show/" + enc(type) + "/" + enc(id); }
function seasonUrl(type, id, key) { return showUrl(type, id) + "/season/" + enc(key); }
function episodeUrl(type, id, videoId) { return showUrl(type, id) + "/video/" + enc(videoId); }
function genreUrl(type, genre) { return BASE + "/genre/" + enc(type) + "/" + enc(genre); }
function liveChannelUrl(c) { return BASE + "/live/" + enc(c.list.key) + "/" + enc(c.id); }
function liveWatchUrl(c) { return liveChannelUrl(c) + "/watch"; }
function imdbUrl(id) {
    const m = /^(tt\d+)/.exec(id || "");
    return m ? "https://www.imdb.com/title/" + m[1] + "/" : null;
}

// ---------------------------------------------------------------- small helpers

function pid(value) {
    return new PlatformID(config.name || "Movies TV Live", value, config.id);
}

function isSeriesType(type) { return SERIES_TYPES.indexOf(type) >= 0; }

function firstGenre(meta) { return [].concat(meta.genres || meta.genre || [])[0] || null; }

function settingBool(key, fallback) {
    const v = settings[key];
    if (v === undefined || v === null || v === "") return fallback;
    if (typeof v === "boolean") return v;
    return v === "true" || v === 1 || v === "1";
}

function settingIndex(key, fallback) {
    const v = parseInt(settings[key]);
    return isNaN(v) ? fallback : v;
}

function enc(s) { return encodeURIComponent(String(s)); }
function dec(s) { return decodeURIComponent(s); }

function num(v) {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
}

function pad(n) { return n < 10 ? "0" + n : String(n); }

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

function oneLine(s) { return (s || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim(); }

function firstLine(s) { return (s || "").split("\n")[0]; }

function toSeconds(date) {
    const t = Date.parse(date || "");
    return isNaN(t) ? 0 : Math.floor(t / 1000);
}

function yearSeconds(text) {
    const m = /(\d{4})/.exec(String(text || ""));
    return m ? Math.floor(Date.UTC(parseInt(m[1]), 0, 1) / 1000) : 0;
}

function runtimeSeconds(text) {
    if (!text) return 0;
    const t = String(text).toLowerCase();
    const h = /(\d+)\s*h/.exec(t);
    const m = /(\d+)\s*m/.exec(t);
    if (h || m) return (h ? parseInt(h[1]) * 3600 : 0) + (m ? parseInt(m[1]) * 60 : 0);
    const plain = parseInt(t);
    return isNaN(plain) ? 0 : plain * 60;
}

log("Movies TV Live loaded with " + ADDONS.length + " built-in addon(s)");
