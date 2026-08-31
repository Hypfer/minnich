const http = require("http");
const Logger = require("./Logger");
const CropEngine = require("./CropEngine");

/**
 * The kiosk-satellite Immich client's entire server-side surface: six
 * endpoints, one auth header. Three of them are all a photo frame needs;
 * the other three are optional and answered anyway.
 *
 * When a request's API key maps to a panel profile, each photo meets the
 * panel via the CropEngine (crop / keep / exclude) if it has an annotation
 * sidecar, or the legacy attention crop if not.
 *
 * Coordinate spaces: Library sniffs and annotate.js writes stored pixels
 * (what the model sees); sharp extracts after .rotate(), i.e. display
 * pixels. Everything below the decide() boundary is display space — boxes
 * and dimensions are normalized there, once.
 */
class ImmichApi {
    /**
     * @param {import("./Library")} library
     * @param {object} [options]
     * @param {string} [options.apiKey] - when set, requests must carry it as x-api-key; when empty, any key is accepted
     * @param {import("./Smartcrop")} options.smartcrop
     * @param {import("./Sidecars")} [options.sidecars] - annotation store; without it, attention-only
     */
    constructor(library, options = {}) {
        this.library = library;
        this.apiKey = options.apiKey ?? "";
        this.smartcrop = options.smartcrop;
        this.sidecars = options.sidecars ?? null;

        /** @type {Map<string, {verdict: string, window?: number[]}|null>} hash -> decision, per panel suffix */
        this.decisions = new Map();

        /** Optional admin interface; app.js wires it in. It is unauthenticated. */
        this.admin = options.admin ?? null;
    }

    /**
     * @public
     * @param {number} port
     * @return {Promise<void>}
     */
    listen(port) {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handle(req, res).catch(err => {
                    Logger.error("Unhandled error while serving", req.method, req.url, err);

                    if (!res.headersSent) {
                        this.send(res, 500, {message: "internal error"});
                    } else {
                        res.destroy();
                    }
                });
            });

            this.server.once("error", reject);
            this.server.listen(port, () => {
                this.server.off("error", reject);

                resolve();
            });
        });
    }

    /**
     * The decision for one photo on one panel: CROP (with window), KEEP
     * (serve original) or EXCLUDE (not for this device). null = no
     * annotation; the caller falls back to the attention crop. Cached per
     * (hash, panel) — search asks for the whole library per request.
     *
     * The full engine result (cls/branch/coverage) rides along for the
     * admin UI; the kiosk only ever reads verdict and window.
     *
     * @public
     * @param {{file: string, w: number, h: number, orientation: number, mtimeMs: number}} meta
     * @param {string} key - the raw API key (panel name + optional suffix)
     * @param {{width: number, height: number}} panel
     * @return {Promise<{verdict: string, window?: [number, number, number, number], detail?: object}|null>}
     */
    async decide(meta, key, panel) {
        const sidecar = await this.sidecars?.get(meta);
        const cacheKey = `${sidecar ? await this.sidecars.hash(meta) : "none"}|${key}`;
        if (this.decisions.has(cacheKey)) {
            return this.decisions.get(cacheKey);
        }

        let decision = null;
        if (sidecar) {
            // Annotated photos always run geometry — the engine's gates
            // (hard things, fill) handle cross-orientation cases the
            // attention path could not. The orientation gate below applies
            // only to un-annotated photos.
            const rotated = CropEngine.rotateThings(sidecar.things, meta.orientation);
            const dims = CropEngine.turnedDims(sidecar.w, sidecar.h, meta.orientation);
            const d = CropEngine.decide(rotated, dims.w, dims.h, panel);
            if (d.verdict === "CROP") {
                decision = {verdict: "CROP", window: d.window, detail: d};
            } else {
                decision = CropEngine.containFill(dims.w, dims.h, panel) >= CropEngine.FILL_MIN
                    ? {verdict: "KEEP", detail: d}
                    : {verdict: "EXCLUDE", detail: d};
            }
        }

        this.decisions.set(cacheKey, decision);

        return decision;
    }

    /**
     * The framing a device gets for one photo: geometry crop when
     * annotated, attention crop for same-facing unannotated photos,
     * original bytes otherwise (KEEP/EXCLUDE — the kiosk letterboxes or
     * pairs it). The admin UI reuses this verbatim, so what it shows is
     * what the panel serves.
     *
     * @public
     * @param {Buffer} bytes
     * @param {{file: string, w: number, h: number, orientation: number, mtimeMs: number}} meta
     * @param {string} key - the raw API key (panel name + optional suffix)
     * @param {{width: number, height: number}} panel
     * @return {Promise<{image: Buffer|null, decision: object|null, reason: string}>} reason: geometry|attention|original|unannotated
     */
    async frame(bytes, meta, key, panel) {
        const dec = await this.decide(meta, key, panel);

        if (dec?.verdict === "CROP") {
            const sidecar = await this.sidecars.get(meta);
            const dims = CropEngine.turnedDims(sidecar.w, sidecar.h, meta.orientation);
            const px = CropEngine.windowToPixels(dec.window, dims.w, dims.h);

            return {image: await this.smartcrop.cropWindow(bytes, panel, px), decision: dec, reason: "geometry"};
        }
        if (dec === null && this.smartcrop.orientationMatches(meta, panel)) {
            return {image: await this.smartcrop.crop(bytes, panel), decision: null, reason: "attention"};
        }

        return {image: bytes, decision: dec, reason: dec ? "original" : "unannotated"};
    }

    /**
     * Forget cached decisions — after a sidecar rewrite they may be stale.
     *
     * @public
     */
    invalidateDecisions() {
        this.decisions.clear();
    }

    /**
     * @private
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     */
    async handle(req, res) {
        const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
        const started = Date.now();

        try {
            // Admin interface first: same port, no key — it is all internal
            if (this.admin?.canHandle?.(url.pathname)) {
                return await this.admin.handle(req, res, url);
            }

            if (this.apiKey && req.headers["x-api-key"] !== this.apiKey) {
                return this.send(res, 401, {message: "invalid api key"});
            }

            // Album picker: one synthetic album, or the shared/asset variants
            if (url.pathname === "/api/albums" && req.method === "GET") {
                if (url.searchParams.has("assetId")) {
                    // "Which albums does this asset belong to?" — ours all do, as one
                    return this.send(res, 200, [{
                        id: "minnich",
                        albumName: "All photos",
                        assetCount: (await this.library.list()).length
                    }]);
                }

                const assets = await this.library.list();

                return this.send(res, 200, [{
                    id: "minnich",
                    albumName: "All photos",
                    assetCount: assets.length
                }]);
            }

            // The playlist
            if (url.pathname === "/api/search/metadata" && req.method === "POST") {
                const body = await this.readBody(req);
                const page = Number(body.page) || 1;
                const size = Math.min(Number(body.size) || 100, 500);
                const withExif = body.withExif === true;

                // EXCLUDE verdicts never reach this panel's playlist;
                // cropped photos report the panel's shape (kiosk fills edge
                // to edge), everything else its true shape for pairing.
                const rawKey = `${req.headers["x-api-key"] ?? ""}`;
                const profile = this.smartcrop?.profile(rawKey);
                const all = await this.library.list();
                const start = (page - 1) * size;
                const visible = [];
                const shapes = new Map(); // id -> {w, h} to report
                for (const m of all) {
                    if (profile) {
                        const dec = await this.decide(m, rawKey, profile);
                        if (dec?.verdict === "EXCLUDE") {
                            continue;
                        }
                        if (dec?.verdict === "CROP" || (dec === null && this.smartcrop.orientationMatches(m, profile))) {
                            shapes.set(m.id, {w: profile.width, h: profile.height});
                        }
                    }
                    visible.push(m);
                }

                const items = visible.slice(start, start + size).map(meta => {
                    const item = {
                        id: meta.id,
                        type: "IMAGE",
                        fileCreatedAt: new Date(meta.mtimeMs).toISOString()
                    };

                    if (withExif && meta.w && meta.h) {
                        const shape = shapes.get(meta.id);
                        item.exifInfo = shape ? {
                            exifImageWidth: shape.w,
                            exifImageHeight: shape.h,
                            orientation: "1"
                        } : {
                            exifImageWidth: meta.w,
                            exifImageHeight: meta.h,
                            orientation: String(meta.orientation)
                        };
                    }

                    return item;
                });

                return this.send(res, 200, {
                    assets: {
                        total: visible.length,
                        items: items,
                        nextPage: start + size < visible.length ? page + 1 : null
                    }
                });
            }

            // Asset detail: metadata overlay decoration; every field optional
            const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
            if (assetMatch && req.method === "GET") {
                const meta = await this.library.get(assetMatch[1]);
                if (!meta) {
                    return this.send(res, 404, {message: "asset not found"});
                }

                return this.send(res, 200, {
                    id: meta.id,
                    type: "IMAGE",
                    fileCreatedAt: new Date(meta.mtimeMs).toISOString(),
                    exifInfo: meta.w ? {
                        exifImageWidth: meta.w,
                        exifImageHeight: meta.h,
                        orientation: String(meta.orientation)
                    } : {}
                });
            }

            // The pixels. Any decodable image; size=preview is the only form
            // asked. A key with a panel profile gets the photo re-framed
            // for that panel via frame(): geometry crop when annotated,
            // attention crop for same-facing unannotated photos, original
            // otherwise.
            const thumbMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
            if (thumbMatch && req.method === "GET") {
                const bytes = await this.library.readAsset(thumbMatch[1]);
                if (!bytes) {
                    return this.send(res, 404, {message: "asset not found"});
                }

                const meta = await this.library.get(thumbMatch[1]);
                const rawKey = `${req.headers["x-api-key"] ?? ""}`;
                const profile = this.smartcrop?.profile(rawKey);
                let out = bytes;
                if (profile && meta) {
                    out = (await this.frame(bytes, meta, rawKey, profile)).image ?? bytes;
                }

                res.writeHead(200, {"Content-Type": "application/octet-stream"});
                res.end(out);

                return;
            }

            // Video playback: a photo folder has none
            const videoMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/video\/playback$/);
            if (videoMatch) {
                return this.send(res, 404, {message: "no videos in minnich"});
            }

            // Anything else the real API serves that we happily ignore
            return this.send(res, 404, {message: `no ${url.pathname}`});
        } finally {
            Logger.debug(req.method, url.pathname, "->", res.statusCode, `${Date.now() - started}ms`);
        }
    }

    /**
     * @private
     * @param {import("http").ServerResponse} res
     * @param {number} status
     * @param {object} body
     */
    send(res, status, body) {
        res.writeHead(status, {"Content-Type": "application/json"});
        res.end(JSON.stringify(body));
    }

    /**
     * @private
     * @param {import("http").IncomingMessage} req
     * @return {Promise<object>}
     */
    readBody(req) {
        return new Promise((resolve) => {
            let body = "";

            req.on("data", chunk => {
                body += chunk;
                if (body.length > 1e5) {
                    req.destroy();
                }
            });
            req.on("end", () => {
                try {
                    resolve(JSON.parse(body || "{}"));
                } catch {
                    resolve({});
                }
            });
        });
    }
}

module.exports = ImmichApi;
