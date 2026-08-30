const Logger = require("./Logger");
const sharp = require("sharp");

/**
 * Server-side smart cropping: re-frames each photo for the panel that asks
 * for it, around the salient region, so the kiosk's fill-the-screen logic
 * measures a perfect shape match and covers edge to edge.
 *
 * The per-device channel is the API key: the kiosk sends nothing else about
 * itself (no screen size, no useful user agent), so a key maps to a panel
 * profile. An unknown key gets the original untouched — the behavior
 * minnich had before this existed.
 *
 * The crop is sharp's attention strategy (libvips' saliency heuristic under
 * the hood: edge, saturation and skin-tone density over candidate crops),
 * which also downscales to the panel in the same pass — a 12 MP original
 * has no business traveling to a 960 px screen. No disk cache: one run is
 * ~50 ms, and the kiosk caches on its side anyway.
 */
class Smartcrop {
    /**
     * @param {object} profiles - api key -> {width, height}
     */
    constructor(profiles = {}) {
        /** @type {Map<string, {width: number, height: number}>} */
        this.profiles = new Map(Object.entries(profiles));

        // One run at a time: instant enough that a queue never grows,
        // serialized enough that a screensaver activation (the kiosk fetches
        // in bursts) cannot stack five crops on a weak host.
        this.queue = Promise.resolve();
    }

    /**
     * The profile a request's key maps to, or null when it is unknown (or
     * the key check is disabled entirely — then nobody gets cropped).
     *
     * @public
     * @param {string} apiKey
     * @return {{width: number, height: number}|null}
     */
    profile(apiKey) {
        // A key like "lenovotabk10:portrait" (or ":landscape") is the base
        // profile with its axes swapped, so a rotatable tablet gets
        // correctly framed photos in either orientation without a second
        // entry.
        const [name, orientation] = `${apiKey}`.split(":");
        const base = this.profiles.get(name);
        if (!base) return null;
        if (orientation === "portrait") {
            return {width: base.height, height: base.width};
        }
        if (orientation === "landscape") {
            return {width: Math.max(base.width, base.height), height: Math.min(base.width, base.height)};
        }
        return base;
    }

    /**
     * @public
     * @param {{width: number, height: number}} profile
     * @return {number}
     */
    aspect(profile) {
        return profile.width / profile.height;
    }

    /**
     * Crop [buffer] to [profile] around the salient region, downscaled to
     * the panel and lightly sharpened to survive the resize. Resolves null
     * when sharp fails — the caller falls back to the original, because a
     * photo shown uncropped beats a photo not shown at all.
     *
     * @public
     * @param {Buffer} buffer
     * @param {{width: number, height: number}} profile
     * @return {Promise<Buffer|null>}
     */
    crop(buffer, profile) {
        const run = this.queue.then(() => sharp(buffer)
            .rotate() // honor the EXIF orientation tag before cropping
            .resize(profile.width, profile.height, {
                fit: "cover",
                position: sharp.strategy.attention
            })
            .sharpen({sigma: 0.5})
            .jpeg({quality: 85, mozjpeg: true})
            .toBuffer()
        );

        // A failed run must not poison the queue for the next one.
        this.queue = run.then(() => undefined, () => undefined);

        return run.catch(err => {
            Logger.warn(`smartcrop failed, serving original: ${err?.message ?? err}`);

            return null;
        });
    }
}

module.exports = Smartcrop;
