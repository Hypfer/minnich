const fs = require("fs/promises");
const fsConstants = require("fs").constants;
const path = require("path");
const Logger = require("./Logger");

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);

const SCAN_INTERVAL_MS = 60_000; // the kiosk re-reads the playlist every activation anyway
const MAX_DEPTH = 8; // nested album folders, not an arbitrary filesystem walk


/**
 * The photo folder as a library: a scan that maps filenames to stable ids
 * and sniffs each image's dimensions and EXIF orientation from its header,
 * without decoding it.
 */
class Library {
    /**
     * @param {string} dir
     */
    constructor(dir) {
        this.dir = dir;

        /** @type {Map<string, {file: string, name: string, w: number, h: number, orientation: number, mtimeMs: number}>} */
        this.assets = new Map(); // id -> meta

        this.lastScan = 0;
        this.scanning = null;
    }

    /**
     * @public
     */
    async rescan() {
        if (Date.now() - this.lastScan < SCAN_INTERVAL_MS) {
            return;
        }
        if (this.scanning) {
            return this.scanning;
        }

        this.scanning = this._scan().finally(() => {
            this.scanning = null;
        });

        return this.scanning;
    }

    /**
     * @private
     */
    async _scan() {
        this.lastScan = Date.now();

        const fresh = new Map();

        await this._walk(this.dir, "", 0, fresh);

        const added = fresh.size - this.assets.size;
        this.assets = fresh;

        Logger.debug(`Scanned ${this.dir}: ${this.assets.size} assets`);
        if (added > 0) {
            Logger.info(`Library grew by ${added} asset(s)`);
        }
    }

    /**
     * Depth-first walk of the photo dir. [relDir] is the path relative to
     * the library root ("" at the root), both for ids — two files named
     * alike in different folders must not collide — and for skipping the
     * walk's own descent loops.
     *
     * @private
     * @param {string} dir - absolute directory
     * @param {string} relDir - relative to the library root
     * @param {number} depth
     * @param {Map<string, object>} fresh
     */
    async _walk(dir, relDir, depth, fresh) {
        if (depth > MAX_DEPTH) {
            return;
        }

        const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => {
            Logger.error(`Cannot read photo dir ${dir}`);

            return [];
        });

        for (const e of entries) {
            const rel = relDir ? `${relDir}/${e.name}` : e.name;

            if (e.isDirectory()) {
                await this._walk(path.join(dir, e.name), rel, depth + 1, fresh);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (!IMAGE_EXT.has(ext)) {
                    continue;
                }

                const file = path.join(dir, e.name);

                try {
                    // Only the first 64 KiB is needed for the headers
                    const header = await this._head(file);
                    const sniffed = sniffImage(header, ext);
                    const stats = await fs.stat(file);

                    fresh.set(stableId(rel), {
                        file: file,
                        name: rel,
                        w: sniffed?.w ?? 0,
                        h: sniffed?.h ?? 0,
                        orientation: sniffed?.orientation ?? 1,
                        mtimeMs: stats.mtimeMs
                    });
                } catch (err) {
                    Logger.warn(`Skipping unreadable file ${rel}: ${err?.message ?? err}`);
                }
            }
        }
    }

    /**
     * @private
     * @param {string} file
     * @return {Promise<Buffer>}
     */
    async _head(file, n = 65536) {
        const handle = await fs.open(file, fsConstants.O_RDONLY);

        try {
            const buf = Buffer.alloc(n);
            const {bytesRead} = await handle.read(buf, 0, n, 0);

            return buf.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    }

    /**
     * The library, newest first (mtime desc) — the order the kiosk expects
     * when it does not shuffle.
     *
     * @public
     * @return {Array<{id: string, file: string, name: string, w: number, h: number, orientation: number, mtimeMs: number}>}
     */
    async list() {
        await this.rescan();

        return [...this.assets.entries()]
            .map(([id, meta]) => ({id: id, ...meta}))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    /**
     * @public
     * @param {string} id
     */
    async get(id) {
        await this.rescan();

        return this.assets.get(id) ?? null;
    }

    /**
     * @public
     * @param {string} id
     * @return {Promise<Buffer|null>}
     */
    async readAsset(id) {
        const meta = await this.get(id);
        if (!meta) {
            return null;
        }

        return fs.readFile(meta.file).catch(() => null);
    }
}


/**
 * A stable id independent of the array order: the kiosk stores nothing but
 * the id between sessions, so the same photo must keep its id forever.
 * The relative path, not the bare filename, so same-named files in
 * different folders get different ids.
 *
 * @param {string} relPath
 * @return {string}
 */
function stableId(relPath) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;

    for (let i = 0; i < relPath.length; i++) {
        h1 = ((h1 ^ relPath.charCodeAt(i)) * 0x01000193) >>> 0;
        h2 = ((h2 + relPath.charCodeAt(i) * (i + 7)) * 2654435761) >>> 0;
    }

    return (h1.toString(36) + h2.toString(36)).padStart(12, "0");
}


/**
 * Dimensions and EXIF orientation from the image header, no decode. This is
 * the one thing minnich does better than the real Immich for this client:
 * the server knows every photo's shape, so portrait pairing and
 * fill-the-screen get real aspects for free.
 *
 * @param {Buffer} buf
 * @param {string} ext
 * @return {{w: number, h: number, orientation: number}|null}
 */
function sniffImage(buf, ext) {
    const size = sniffSize(buf, ext);
    const orientation = (ext === ".jpg" || ext === ".jpeg") ? sniffJpegOrientation(buf) : 1;

    if (!size) {
        return orientation > 1 ? {w: 0, h: 0, orientation: orientation} : null;
    }

    return {...size, orientation: orientation};
}


/**
 * @param {Buffer} buf
 * @param {string} ext
 * @return {{w: number, h: number}|null}
 */
function sniffSize(buf, ext) {
    switch (ext) {
        case ".png":
            return sniffPngSize(buf);
        case ".webp":
            return sniffWebpSize(buf);
        case ".gif":
            return sniffGifSize(buf);
        default:
            return sniffJpegSize(buf);
    }
}


/**
 * Walk the JPEG segments to the SOF marker.
 *
 * @param {Buffer} buf
 * @return {{w: number, h: number}|null}
 */
function sniffJpegSize(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        return null;
    }

    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }

        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }

        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return {h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7)};
        }

        i += 2 + len;
    }

    return null;
}


/**
 * Find the APP1 EXIF block and read orientation (tag 0x0112). A portrait
 * phone photo is commonly stored as a landscape frame plus this tag.
 *
 * @param {Buffer} buf
 * @return {number}
 */
function sniffJpegOrientation(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        return 1;
    }

    let i = 2;
    while (i + 4 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }

        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }

        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xe1 && buf.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
            const tiff = i + 10;
            const le = buf.toString("latin1", tiff, tiff + 2) === "II";
            const rd16 = (o) => le ? buf.readUInt16LE(tiff + o) : buf.readUInt16BE(tiff + o);
            const rd32 = (o) => le ? buf.readUInt32LE(tiff + o) : buf.readUInt32BE(tiff + o);
            const ifd = rd32(4);
            const count = rd16(ifd);

            for (let e = 0; e < count && ifd + 2 + e * 12 + 12 <= buf.length; e++) {
                const base = ifd + 2 + e * 12;
                if (rd16(base) === 0x0112) {
                    const v = rd16(base + 8);

                    return v >= 1 && v <= 8 ? v : 1;
                }
            }

            return 1;
        }

        i += 2 + len;
    }

    return 1;
}


/**
 * @param {Buffer} buf
 * @return {{w: number, h: number}|null}
 */
function sniffPngSize(buf) {
    if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") {
        return null;
    }

    return {w: buf.readUInt32BE(16), h: buf.readUInt32BE(20)};
}


/**
 * @param {Buffer} buf
 * @return {{w: number, h: number}|null}
 */
function sniffWebpSize(buf) {
    if (buf.length < 30 || buf.toString("latin1", 0, 4) !== "RIFF") {
        return null;
    }

    if (buf.toString("latin1", 8, 12) === "VP8X") {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));

        return {w: w, h: h};
    }

    return null;
}


/**
 * @param {Buffer} buf
 * @return {{w: number, h: number}|null}
 */
function sniffGifSize(buf) {
    if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "GIF") {
        return null;
    }

    return {w: buf.readUInt16LE(6), h: buf.readUInt16LE(8)};
}


module.exports = Library;
