/**
 * Panel profiles, keyed by the API key the kiosk sends. A key that maps
 * here gets its photos re-framed for that panel; any other key gets the
 * originals. ":portrait"/":landscape" suffixes swap axes (Smartcrop.profile).
 */
const PANELS = {
    echoshow5: {width: 960, height: 480},
    echoshow8: {width: 1280, height: 800},
    lenovotabk10: {width: 1920, height: 1200}
};

const Logger = require("./Logger");
const sharp = require("sharp");

/**
 * Server-side cropping. Two flavors:
 *
 *  - crop(): sharp's attention strategy — the saliency heuristic minnich
 *    shipped before annotations existed, still the fallback for photos
 *    without a sidecar
 *  - cropWindow(): extract a geometry-engine window at exact pixels
 *
 * The per-device channel is the API key: the kiosk sends nothing else about
 * itself (no screen size, no useful user agent).
 */
class Smartcrop {
    /**
     * @param {object} [profiles] - api key -> {width, height}; defaults to PANELS
     */
    constructor(profiles = PANELS) {
        /** @type {Map<string, {width: number, height: number}>} */
        this.profiles = new Map(Object.entries(profiles));

        // Serialized: a screensaver activation fetches in bursts, and five
        // stacked crops on a weak host help nobody.
        this.queue = Promise.resolve();
    }

    /**
     * The profile a request's key maps to, or null when unknown.
     *
     * @public
     * @param {string} apiKey
     * @return {{width: number, height: number}|null}
     */
    profile(apiKey) {
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
     * Whether [meta] and [profile] face the same way — a landscape photo for
     * a landscape panel. Mismatched photos are served untouched so the
     * kiosk's portrait pairing can find them. The photo's shape is the
     * EXIF-adjusted one.
     *
     * @public
     * @param {{w: number, h: number, orientation: number}} meta
     * @param {{width: number, height: number}} profile
     * @return {boolean}
     */
    orientationMatches(meta, profile) {
        const turned = meta.orientation >= 5 && meta.orientation <= 8;
        const photoPortrait = turned ? meta.w < meta.h : meta.h > meta.w;
        const panelPortrait = profile.height > profile.width;

        return photoPortrait === panelPortrait;
    }

    /**
     * Attention crop, downscaled to the panel. Resolves null when sharp
     * fails — a photo shown uncropped beats a photo not shown at all.
     *
     * @public
     * @param {Buffer} buffer
     * @param {{width: number, height: number}} profile
     * @return {Promise<Buffer|null>}
     */
    crop(buffer, profile) {
        return this.run(sharp(buffer)
            .rotate() // honor the EXIF orientation tag before cropping
            .resize(profile.width, profile.height, {
                fit: "cover",
                position: sharp.strategy.attention
            })
            .sharpen({sigma: 0.5})
            .jpeg({quality: 85, mozjpeg: true}));
    }

    /**
     * Extract [px] (EXIF-rotated pixel space) and resize to the panel.
     *
     * @public
     * @param {Buffer} buffer - raw file bytes
     * @param {{width: number, height: number}} profile - output panel
     * @param {{left: number, top: number, width: number, height: number}} px
     * @return {Promise<Buffer|null>}
     */
    cropWindow(buffer, profile, px) {
        return this.run(sharp(buffer)
            .rotate() // EXIF-rotate first: the window is in rotated space
            .extract(px)
            .resize(profile.width, profile.height, {kernel: "lanczos3"})
            .sharpen({sigma: 0.5})
            .jpeg({quality: 85, mozjpeg: true}));
    }

    /**
     * @private
     * @param {sharp.Sharp} pipeline
     * @return {Promise<Buffer|null>}
     */
    run(pipeline) {
        const run = this.queue.then(() => pipeline.toBuffer());
        this.queue = run.then(() => undefined, () => undefined);

        return run.catch(err => {
            Logger.warn(`crop failed, serving original: ${err?.message ?? err}`);

            return null;
        });
    }
}

module.exports = Smartcrop;
