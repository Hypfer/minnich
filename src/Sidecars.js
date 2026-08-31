const fs = require("fs/promises");
const crypto = require("crypto");
const path = require("path");

/**
 * Annotation sidecars: one JSON file per photo in a parallel ".minnich"
 * directory inside the photo folder. annotate.js writes them atomically
 * (tmp + rename); the server only reads.
 *
 *   {version: 1, classifier: "v1", w, h, things: [{label, interest,
 *    croppable, left, top, right, bottom}]}
 *
 * Files are keyed by content hash: renaming or moving a photo keeps its
 * annotation, identical files share one. "classifier" is the annotation
 * recipe (model + prompt, abstractly) — bump it to invalidate old files;
 * the server reads a mismatched classifier as "no annotation" until
 * annotate.js refreshes it.
 */

const SIDECAR_VERSION = 1;
const CLASSIFIER = "v1";
const DIR_NAME = ".minnich";

class Sidecars {
    constructor(photoDir) {
        this.dir = path.join(photoDir, DIR_NAME);

        /** @type {Map<string, string>} file|mtime -> sha256 */
        this.hashes = new Map();

        /** @type {Map<string, object|null>} hash -> sidecar (null when unreadable/stale, cached) */
        this.cache = new Map();
    }

    /**
     * The sidecar for one asset, or null. Unusable files cache as null so a
     * broken sidecar costs one stat per scan cycle, not one parse per
     * thumbnail request.
     *
     * @public
     * @param {{file: string, mtimeMs: number}} meta
     * @return {Promise<object|null>}
     */
    async get(meta) {
        const hash = await this.hash(meta);
        if (this.cache.has(hash)) {
            return this.cache.get(hash);
        }

        const sidecar = await fs.readFile(path.join(this.dir, `${hash}.json`), "utf8")
            .then(text => {
                try {
                    return JSON.parse(text);
                } catch {
                    return null;
                }
            })
            .catch(() => null);

        const usable = sidecar
            && sidecar.version === SIDECAR_VERSION
            && sidecar.classifier === CLASSIFIER
            && Array.isArray(sidecar.things)
            && sidecar.things.length > 0;

        this.cache.set(hash, usable ? sidecar : null);

        return usable ? sidecar : null;
    }

    /**
     * Forget cached sidecars (annotate.js may have written new files since
     * the last read). Keeps hashes — contents do not change.
     *
     * @public
     */
    invalidate() {
        this.cache.clear();
    }

    /**
     * sha256 of the file contents, memoized per mtime: the 60 s scan must
     * not re-hash an unchanged library forever.
     *
     * @public
     * @param {{file: string, mtimeMs: number}} meta
     * @return {Promise<string>}
     */
    async hash(meta) {
        const key = `${meta.file}|${meta.mtimeMs}`;
        if (this.hashes.has(key)) {
            return this.hashes.get(key);
        }

        const buf = await fs.readFile(meta.file).catch(() => null);
        const hash = buf ? crypto.createHash("sha256").update(buf).digest("hex") : "missing";

        this.hashes.set(key, hash);

        return hash;
    }
}

module.exports = Sidecars;
