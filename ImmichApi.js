const http = require("http");
const Logger = require("./Logger");

/**
 * The kiosk-satellite Immich client's entire server-side surface: six
 * endpoints, one auth header. Three of them are all a photo frame needs;
 * the other three are optional and answered anyway.
 */
class ImmichApi {
    /**
     * @param {import("./Library")} library
     * @param {object} [options]
     * @param {string} [options.apiKey] - when set, requests must carry it as x-api-key; when empty, any key is accepted
     * @param {import("./Smartcrop")} [options.smartcrop]
     */
    constructor(library, options = {}) {
        this.library = library;
        this.apiKey = options.apiKey ?? "";
        this.smartcrop = options.smartcrop ?? null;
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
     * @private
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     */
    async handle(req, res) {
        const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
        const started = Date.now();

        try {
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

                // A key with a panel profile crops, so the playlist reports
                // the shape that panel will actually be shown: a perfect
                // match for the kiosk's fill-the-screen decision, and
                // nothing portrait for its pairing to find.
                const profile = this.smartcrop?.profile(`${req.headers["x-api-key"] ?? ""}`);

                const all = await this.library.list();
                const start = (page - 1) * size;
                const items = all.slice(start, start + size).map(meta => {
                    const item = {
                        id: meta.id,
                        type: "IMAGE",
                        fileCreatedAt: new Date(meta.mtimeMs).toISOString()
                    };

                    // The exifInfo is only asked for when the kiosk pairs
                    // portrait photos; orientation as a string, matching the
                    // exiftool pass-through the client tolerates
                    if (withExif && meta.w && meta.h) {
                        if (profile) {
                            item.exifInfo = {
                                exifImageWidth: profile.width,
                                exifImageHeight: profile.height,
                                orientation: "1"
                            };
                        } else {
                            item.exifInfo = {
                                exifImageWidth: meta.w,
                                exifImageHeight: meta.h,
                                orientation: String(meta.orientation)
                            };
                        }
                    }

                    return item;
                });

                return this.send(res, 200, {
                    assets: {
                        total: all.length,
                        items: items,
                        nextPage: start + size < all.length ? page + 1 : null
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

            // The pixels. Any decodable image; size=preview is the only form asked.
            // A key with a panel profile gets the photo re-framed for that
            // panel instead: cropped around the salient region to the
            // panel's own shape, downscaled to its resolution.
            const thumbMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
            if (thumbMatch && req.method === "GET") {
                const bytes = await this.library.readAsset(thumbMatch[1]);
                if (!bytes) {
                    return this.send(res, 404, {message: "asset not found"});
                }

                const profile = this.smartcrop?.profile(`${req.headers["x-api-key"] ?? ""}`);
                const out = profile ? await this.smartcrop.crop(bytes, profile) : null;

                res.writeHead(200, {"Content-Type": "application/octet-stream"});
                res.end(out ?? bytes);

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
