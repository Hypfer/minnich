/**
 * The sidecar writer — a one-shot job, deliberately not part of the server:
 * the LLM lives on a desktop GPU that is sometimes asleep, and photo serving
 * must not depend on it. Run when new photos have landed:
 *
 *   LLM_URL=http://host:port MODEL=name docker compose run --rm minnich node annotate.js
 *
 * Annotates photos whose sidecar is absent or stale (version/classifier
 * mismatch — the same check the server applies). Single sample, temperature
 * 0: validated across a 39-photo corpus in croplab, where sampling added
 * cost, not confidence.
 */

const fs = require("fs/promises");
const path = require("path");
const Logger = require("./Logger");
const Library = require("./Library");
const Sidecars = require("./Sidecars");

// The LLM endpoint and model are deployment details — no internal IPs in the
// repo. 127.0.0.1 works when the server runs on the annotating host itself;
// set LLM_URL/MODEL otherwise. A missing LLM fails per request, not at boot.
const LLM_URL = process.env.LLM_URL ?? "http://127.0.0.1:1234";
const MODEL = process.env.MODEL ?? "";
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "4", 10);
const PHOTO_DIR = process.env.PHOTO_DIR ?? "/photos";
// FORCE=1: re-annotate everything, overwriting existing sidecars. The
// default skips photos whose sidecar is current (the same classifier-aware
// check the server applies).
const FORCE = process.env.FORCE === "1";
const MAX_TOKENS = 6000;

// Croplab's converged prompt (prompt-crop-v4.md), plus an explicit interest
// range: 1-5 things, named fields (positional arrays transpose x/y about a
// quarter of the time), and the croppable flag the HARD class is built on.
const PROMPT = `List the 1-5 most visually interesting things in this image (main subject first).
Coordinates 0-1000, origin top-left.
interest: 0.0-1.0.
For each thing also say if it may be partially cut off when cropping the image:
- croppable=false for people, animals, faces: they must never be cut
- croppable=true for scenery, buildings, plants, objects: partial views are fine
JSON only:
{"things":[{"label":"","left":0,"top":0,"right":0,"bottom":0,"interest":0.0,"croppable":true}]}`;

// Must match Sidecars.js's expectations and its CLASSIFIER — bump together.
const SIDECAR_VERSION = 1;
const CLASSIFIER = "v1";


/**
 * Parse the model's answer. Coordinates are clamped into the frame and
 * degenerate boxes (under 5 units on a side) are dropped rather than trusted.
 *
 * @param {string} text
 * @return {Array<object>|null}
 */
function parseThings(text) {
    const m = `${text}`.replace(/```[a-z]*\n?/g, "").match(/\{[\s\S]*\}/);
    if (!m) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(m[0]);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed.things)) {
        return null;
    }

    const things = [];
    for (const t of parsed.things.slice(0, 5)) {
        const box = [t.left, t.top, t.right, t.bottom].map(Number);
        if (!box.every(Number.isFinite)) {
            continue;
        }
        let [x1, y1, x2, y2] = box.map(v => Math.max(0, Math.min(1000, v)));
        if (x2 - x1 < 5 || y2 - y1 < 5) {
            continue;
        }

        things.push({
            label: String(t.label ?? "?").slice(0, 80),
            interest: Math.max(0, Math.min(1, Number(t.interest) || 0.5)),
            croppable: t.croppable !== false,
            left: Math.round(x1), top: Math.round(y1),
            right: Math.round(x2), bottom: Math.round(y2)
        });
    }

    return things.length > 0 ? things : null;
}


/**
 * One annotation attempt. Returns things or null; the caller retries once.
 *
 * @param {Buffer} photo
 * @return {Promise<Array<object>|null>}
 */
async function ask(photo) {
    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            model: MODEL,
            messages: [{
                role: "user",
                content: [
                    {type: "text", text: PROMPT},
                    {type: "image_url", image_url: {url: `data:image/jpeg;base64,${photo.toString("base64")}`}}
                ]
            }],
            max_tokens: MAX_TOKENS,
            temperature: 0
        })
    });
    if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}`);
    }

    const body = await res.json();

    return parseThings(body.choices?.[0]?.message?.content ?? "");
}


/**
 * @param {{file: string, w: number, h: number}} meta
 * @param {string} hash
 * @param {Array<object>} things
 */
async function writeSidecar(meta, hash, things) {
    const dir = path.join(PHOTO_DIR, ".minnich");
    await fs.mkdir(dir, {recursive: true});

    const payload = JSON.stringify({
        version: SIDECAR_VERSION,
        classifier: CLASSIFIER,
        w: meta.w,
        h: meta.h,
        things: things
    });
    const tmp = path.join(dir, `.tmp-${hash}-${process.pid}`);
    const dst = path.join(dir, `${hash}.json`);

    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, dst);
}


async function main() {
    const library = new Library(PHOTO_DIR);
    const sidecars = new Sidecars(PHOTO_DIR);
    const assets = (await library.list()).filter(a => a.w && a.h);

    const seen = new Set();
    const pending = [];
    for (const meta of assets) {
        const hash = await sidecars.hash(meta);
        if (seen.has(hash)) {
            continue; // identical file, one annotation
        }
        seen.add(hash);
        if (!FORCE && await sidecars.get(meta) !== null) {
            continue; // current sidecar exists (version + classifier match)
        }
        pending.push({meta: meta, hash: hash});
    }

    Logger.info(`Annotating ${pending.length} of ${assets.length} photos (${MODEL || "unset"} @ ${LLM_URL}, x${CONCURRENCY}${FORCE ? ", forced" : ""})`);

    let done = 0, failed = 0, index = 0;

    async function worker() {
        while (index < pending.length) {
            const job = pending[index++];
            const photo = await fs.readFile(job.meta.file).catch(() => null);
            if (!photo) {
                failed++;
                continue;
            }

            let things = null;
            for (let attempt = 0; attempt < 2 && !things; attempt++) {
                things = await ask(photo).catch(err => {
                    Logger.warn(`annotate attempt ${attempt + 1} failed for ${job.meta.name}: ${err?.message ?? err}`);
                    return null;
                });
            }

            if (things) {
                await writeSidecar(job.meta, job.hash, things);
            } else {
                failed++;
                Logger.error(`no usable annotation for ${job.meta.name}, skipped`);
            }

            done++;
            if (done % 5 === 0 || done === pending.length) {
                Logger.info(`progress: ${done}/${pending.length} (${failed} failed)`);
            }
        }
    }

    await Promise.all(Array.from({length: CONCURRENCY}, worker));

    Logger.info(`Done: ${done - failed} annotated, ${failed} failed`);
    if (failed > 0) {
        process.exitCode = 2;
    }
}

main().catch(err => {
    Logger.error("annotate.js failed", err);
    process.exit(1);
});
