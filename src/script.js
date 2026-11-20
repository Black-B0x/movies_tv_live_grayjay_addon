// Addon Bridge: a Grayjay source that reads Stremio-protocol addons.
//
//   Movies           -> videos            /item/{type}/{id}
//   Shows            -> channels          /show/{type}/{id}
//   Seasons          -> playlists         /show/{type}/{id}/season/{n|first|all}
//   Episodes         -> videos            /show/{type}/{id}/video/{videoId}
//   Genres           -> channels          /genre/{type}/{genre}
//
// The built-in addon list below is replaced by build.py from plugin.json. More addons can be
// pasted on the install page (see enabledAddons).

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
const metaCache = {};

// ---------------------------------------------------------------- lifecycle

source.enable = function (conf, pluginSettings, savedState) {
    config = conf ?? {};
    settings = pluginSettings ?? {};
    pastedAddons = readPastedAddons(config.sourceUrl);
    state = { manifests: {} };
    if (savedState) {
        try {
            const parsed = JSON.parse(savedState);
            if (parsed && parsed.manifests) state = parsed;
        } catch (e) {
            log("Addon Bridge: ignoring unreadable saved state");
        }
    }
};

source.disable = function () { };

source.saveState = function () {
    return JSON.stringify(state);
};

// ---------------------------------------------------------------- home & search

source.getHome = function () {
    const mode = settingIndex("homeContent", 0); // 0 both, 1 movies, 2 shows
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
    return new CatalogPager(entries.slice(0, MAX_HOME_CATALOGS), {});
};

source.searchSuggestions = function () { return []; };

source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [], filters: [] };
};

source.search = function (query) {
    return new CatalogPager(searchEntries(query, null), {});
};

source.searchChannels = function (query) {
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
    return new ChannelPager(channels, false, {});
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
    return RE_SHOW.test(url) || RE_GENRE.test(url);
};

source.getChannel = function (url) {
    let m = url.match(RE_SHOW);
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
    throw new ScriptException("Not an Addon Bridge channel: " + url);
};

source.getChannelCapabilities = function () {
    return { types: [Type.Feed.Videos], sorts: [Type.Order.Chronological], filters: [] };
};

source.getChannelContents = function (url) {
    let m = url.match(RE_SHOW);
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
    if (!m) throw new ScriptException("Not an Addon Bridge season: " + url);
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
    return RE_ITEM.test(url) || RE_EPISODE.test(url);
};

source.getContentDetails = function (url) {
    let m = url.match(RE_EPISODE);
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

    throw new ScriptException("Not an Addon Bridge item: " + url);
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
    const sources = buildSources(streams, duration);
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

function buildSources(streams, duration) {
    const seen = {};
    let candidates = [];
    streams.forEach((x, order) => {
        const s = x.stream;
        if (!s || typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) return;
        if (seen[s.url]) return;
        seen[s.url] = true;
        const hints = s.behaviorHints || {};
        const text = [s.name, s.title, s.description, hints.filename].filter(Boolean).join(" ");
        candidates.push({ stream: s, addon: x.addon, hints: hints, height: detectHeight(text), order: order });
    });

    const maxHeight = MAX_HEIGHT_OPTIONS[settingIndex("maxResolution", 0)] ?? Infinity;
    const capped = candidates.filter(c => c.height === 0 || c.height <= maxHeight);
    if (capped.length) candidates = capped;

    if (settingIndex("streamOrder", 0) === 0) {
        candidates.sort((a, b) => (b.height - a.height) || (a.order - b.order));
    }

    return candidates.map(c => {
        const s = c.stream;
        const name = streamLabel(s, c.addon);
        const headers = c.hints.proxyHeaders && c.hints.proxyHeaders.request;
        const modifier = headers && Object.keys(headers).length ? { headers: headers } : null;
        const kind = streamKind(s.url, c.hints.filename);
        const common = { name: name, url: s.url, duration: duration };
        if (modifier) common.requestModifier = modifier;

        if (kind === "hls") return new HLSSource(Object.assign(common, { priority: false }));
        if (kind === "dash") return new DashSource(common);
        return new VideoUrlSource(Object.assign(common, {
            width: c.height ? Math.round(c.height * 16 / 9) : 0,
            height: c.height,
            container: containerOf(s.url, c.hints.filename),
            codec: "",
            bitrate: 0
        }));
    });
}

function streamLabel(s, addon) {
    const name = oneLine(s.name) || addon.name || "Stream";
    const detail = oneLine(firstLine(s.description || s.title || ""));
    let label = name;
    if (detail && label.indexOf(detail) < 0) label += " · " + detail;
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

function streamKind(url, filename) {
    const path = (url.split(/[?#]/)[0] + " " + (filename || "")).toLowerCase();
    if (/\.m3u8\b/.test(path) || /[?&](format|type|ext)=m3u8/i.test(url)) return "hls";
    if (/\.mpd\b/.test(path) || /[?&](format|type|ext)=mpd/i.test(url)) return "dash";
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

class CatalogPager extends ContentPager {
    constructor(entries, seen, excludeId) {
        const page = fetchCatalogPage(entries, seen);
        const results = page.items
            .filter(x => !(excludeId && x.meta.id === excludeId))
            .map(x => isSeriesType(x.type) ? showAsPlaylist(x.meta, x.type) : titleVideo(x.meta, x.type));
        super(results, page.hasMore, {});
        this.entries = entries;
        this.seen = seen;
        this.excludeId = excludeId;
    }
    nextPage() {
        return new CatalogPager(this.entries, this.seen, this.excludeId);
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

function readPastedAddons(sourceUrl) {
    const m = /[?&]addons=([A-Za-z0-9_-]+)/.exec(sourceUrl || "");
    if (!m) return [];
    try {
        const list = JSON.parse(base64UrlDecode(m[1]));
        if (!Array.isArray(list)) return [];
        return list.filter(u => typeof u === "string" && /^(https?|stremio):\/\//i.test(u));
    } catch (e) {
        log("Addon Bridge: could not read the addons in the install link");
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
            else log("Addon Bridge: could not load manifest for " + a.name);
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
            log("Addon Bridge: batch request failed, retrying one by one: " + e);
        }
    }
    return urls.map((u, i) => {
        let res = responses ? responses[i] : null;
        if (!responses) {
            try { res = http.GET(u, {}, false); }
            catch (e) { log("Addon Bridge: request failed " + u + ": " + e); return null; }
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

function itemUrl(type, id) { return BASE + "/item/" + enc(type) + "/" + enc(id); }
function showUrl(type, id) { return BASE + "/show/" + enc(type) + "/" + enc(id); }
function seasonUrl(type, id, key) { return showUrl(type, id) + "/season/" + enc(key); }
function episodeUrl(type, id, videoId) { return showUrl(type, id) + "/video/" + enc(videoId); }
function genreUrl(type, genre) { return BASE + "/genre/" + enc(type) + "/" + enc(genre); }
function imdbUrl(id) {
    const m = /^(tt\d+)/.exec(id || "");
    return m ? "https://www.imdb.com/title/" + m[1] + "/" : null;
}

// ---------------------------------------------------------------- small helpers

function pid(value) {
    return new PlatformID(config.name || "Addon Bridge", value, config.id);
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

log("Addon Bridge loaded with " + ADDONS.length + " built-in addon(s)");
