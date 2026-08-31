/**
 * The crop geometry engine, ported from croplab (G:\aistuff\croplab\geometry.js)
 * where every rule was validated by eyeball on a 39-photo corpus. Pure
 * functions of (things, panel) — no I/O, no state, safe to run per request.
 *
 * Subject-class taxonomy:
 *   HARD:   any thing with croppable=false (people, animals) -> union window,
 *           every hard thing must survive >= hardMin, coverage >= covMin
 *   ANCHOR: no hard things, but compact things exist (<= anchorMax % of frame
 *           and <= 5:1 elongation — a stem is structure, not a subject) ->
 *           largest window containing the anchor cluster, slid within its
 *           slack to maximize scene coverage, kept off the window edges
 *   WIDE:   everything else -> free slide maximizing interest-weighted
 *           coverage; soft edge-zone for compact-ish things; flat-vista
 *           centroid tiebreak so equal-interest vistas frame horizon-centered
 *
 * Verdicts:
 *   CROP      extract window, resize to panel
 *   KEEP      geometry cannot frame this photo for this panel; serve the
 *             original (the kiosk letterboxes it) — but only when the whole
 *             photo would still fill the panel decently, else
 *   EXCLUDE   the contain-fit would waste more than (1 - fillMin) of the
 *             panel: this device should not list the photo at all
 */

const DEFAULTS = {
    covMin: 70,
    hardMin: 85,
    anchorMax: 5,
    margin: 6
};

// Below this contain-fill fraction, a KEEP photo floats too absurdly in
// letterbox to be worth listing for the panel at all.
const FILL_MIN = 0.55;

// Point transforms (0..1000, origin top-left) from stored to display space
// for each EXIF orientation. Photos are annotated and dimensioned in stored
// space (the raw pixels); sharp extracts after .rotate(), i.e. in display
// space. Everything geometry-related is normalized to display space first.
const ORIENT_MAP = {
    2: p => [1000 - p[0], p[1]],
    3: p => [1000 - p[0], 1000 - p[1]],
    4: p => [p[0], 1000 - p[1]],
    5: p => [p[1], p[0]],
    6: p => [1000 - p[1], p[0]],
    7: p => [1000 - p[1], 1000 - p[0]],
    8: p => [p[1], 1000 - p[0]]
};

/** Display (EXIF-rotated) dims for stored dims and an orientation tag. */
function turnedDims(w, h, orientation) {
    const swapped = orientation >= 5 && orientation <= 8;

    return swapped ? {w: h, h: w} : {w: w, h: h};
}

/**
 * Annotation boxes in display space. Orientation 1 (no tag) is the corpus
 * case and returns the input untouched.
 *
 * @param {Array<object>} things
 * @param {number} orientation - EXIF orientation 1..8
 * @return {Array<object>}
 */
function rotateThings(things, orientation) {
    const m = ORIENT_MAP[orientation];
    if (!m) {
        return things;
    }

    return things.map(t => {
        const [ax, ay] = m([t.left, t.top]);
        const [bx, by] = m([t.right, t.bottom]);

        return {
            ...t,
            left: Math.min(ax, bx), top: Math.min(ay, by),
            right: Math.max(ax, bx), bottom: Math.max(ay, by)
        };
    });
}


/** Fraction of [t] inside the window, both in normalized 0..1 coords. */
function overlap(t, wx1, wy1, wx2, wy2) {
    const ox = Math.max(0, Math.min(t.right / 1000, wx2) - Math.max(t.left / 1000, wx1));
    const oy = Math.max(0, Math.min(t.bottom / 1000, wy2) - Math.max(t.top / 1000, wy1));

    return (ox * oy) / Math.max(1e-9, ((t.right - t.left) / 1000) * ((t.bottom - t.top) / 1000));
}

/**
 * @param {Array<object>} things
 * @param {number} anchorMax
 */
function classify(things, anchorMax) {
    const hard = things.filter(t => t.croppable === false);
    if (hard.length > 0) {
        return {cls: "HARD", focus: things};
    }

    const dims = things.map(t => [t.right - t.left, t.bottom - t.top]);
    const areas = dims.map(([w, h]) => w * h / 10000);
    const elong = dims.map(([w, h]) => Math.max(w, h) / Math.max(1, Math.min(w, h)));
    const compact = things.filter((t, i) => areas[i] <= anchorMax && elong[i] <= 5);
    if (compact.length > 0) {
        return {cls: "ANCHOR", focus: compact, soft: compact};
    }

    const soft = things.filter((t, i) => elong[i] <= 5)
        .sort((a, b) => (b.interest ?? 0) - (a.interest ?? 0))
        .slice(0, 2);

    return {cls: "WIDE", focus: things, soft: soft};
}

/**
 * The decision for one photo on one panel.
 *
 * @param {Array<object>} things - sidecar things (left/top/right/bottom in 0..1000)
 * @param {number} photoW - post-EXIF-rotate pixel width
 * @param {number} photoH
 * @param {{width: number, height: number}} panel
 * @param {object} [tuning] - overrides of DEFAULTS
 * @return {{cls: string, verdict: string, window: [number, number, number, number], coverage: number, hardWorst: number|null}}
 */
function decide(things, photoW, photoH, panel, tuning = {}) {
    const o = {...DEFAULTS, ...tuning};
    const ar = panel.width / panel.height;
    const K = ar * (photoH / photoW); // panel AR expressed in fractional photo space

    const {cls, focus, soft} = classify(things, o.anchorMax);

    let ux1 = 1e9, uy1 = 1e9, ux2 = -1e9, uy2 = -1e9;
    for (const t of focus) {
        ux1 = Math.min(ux1, t.left); uy1 = Math.min(uy1, t.top);
        ux2 = Math.max(ux2, t.right); uy2 = Math.max(uy2, t.bottom);
    }
    const mw = (ux2 - ux1) * o.margin / 100, mh = (uy2 - uy1) * o.margin / 100;
    const uw = (ux2 - ux1) + 2 * mw, uh = (uy2 - uy1) + 2 * mh;
    const cx = (ux1 + ux2) / 2, cy = (uy1 + uy2) / 2;

    let fw = Math.min(1, K), fh = fw / K;
    if (fh > 1) {
        fh = 1;
        fw = K;
    }
    const fits = uw / 1000 <= fw + 1e-9 && uh / 1000 <= fh + 1e-9;

    const covAll = (wx1, wy1) =>
        things.reduce((s, t) => s + (t.interest ?? 1) * overlap(t, wx1, wy1, wx1 + fw, wy1 + fh), 0)
        / things.reduce((s, t) => s + (t.interest ?? 1), 0);

    // soft edge-exclusion: a centroid may roam the middle band (25..75 % of the
    // window) penalty-free; a quadratic ramp toward the edges. Dead-center is
    // never demanded — rule-of-thirds placements stay penalty-free too.
    const edgeZone = (tx, ty, wx1, wy1) => {
        const rx = (tx - wx1) / Math.max(1e-9, fw), ry = (ty - wy1) / Math.max(1e-9, fh);
        const pen = r => 8 * Math.max(0, Math.abs(r - 0.5) - 0.25) ** 2;

        return -(pen(rx) + pen(ry));
    };

    let x1, y1, branch;

    if (cls === "WIDE") {
        branch = "W";
        const zone = soft.length > 0
            ? (wx1, wy1) => soft.reduce((s, t) =>
                s + edgeZone((t.left + t.right) / 2 / 1000, (t.top + t.bottom) / 2 / 1000, wx1, wy1), 0) / soft.length
            : () => 0;
        // flat-vista guard: equal interest everywhere and only large regions ->
        // coverage is a coin flip; pull toward the scene centroid instead so the
        // horizon lands mid-window, the way a human frames a vista.
        const iSpread = Math.max(...things.map(t => t.interest ?? 1)) - Math.min(...things.map(t => t.interest ?? 1));
        const allBig = things.every(t => ((t.right - t.left) * (t.bottom - t.top)) / 10000 > 10);
        const pull = iSpread < 0.15 && allBig ? 1 : 0;
        const sceneCy = things.reduce((s, t) => s + (t.top + t.bottom) / 2, 0) / (things.length * 1000);
        const score = (wx1, wy1) => covAll(wx1, wy1) + zone(wx1, wy1) - pull * Math.abs(wy1 + fh / 2 - sceneCy);

        ({x1, y1} = slide(score, 0, 1 - fw, 0, 1 - fh));
    } else if (fits) {
        branch = "A";
        const fcx = focus.reduce((s, t) => s + (t.left + t.right) / 2, 0) / (focus.length * 1000);
        const fcy = focus.reduce((s, t) => s + (t.top + t.bottom) / 2, 0) / (focus.length * 1000);
        const zone = (wx1, wy1) => edgeZone(fcx, fcy, wx1, wy1);
        // containment slack: the window may slide as long as the margined focus
        // union stays inside; within that band, coverage of ALL things decides.
        const mx1 = ux1 - mw, my1 = uy1 - mh, mx2 = ux2 + mw, my2 = uy2 + mh;
        const xLo = Math.max(0, Math.min(1 - fw, mx2 / 1000 - fw));
        const xHi = Math.max(xLo, Math.min(1 - fw, mx1 / 1000));
        const yLo = Math.max(0, Math.min(1 - fh, my2 / 1000 - fh));
        const yHi = Math.max(yLo, Math.min(1 - fh, my1 / 1000));
        const score = (wx1, wy1) => covAll(wx1, wy1) + zone(wx1, wy1);

        ({x1, y1} = slide(score, xLo, xHi, yLo, yHi));
    } else {
        // The focus union cannot fit any window of this shape: fix the window
        // size, slide along the free axis, keep as much interest as possible.
        branch = "B";
        if (fh < 1) {
            let best = -1;
            for (let i = 0; i <= 200; i++) {
                const wy1 = (1 - fh) * i / 200;
                const c = focus.reduce((s, t) => s + (t.interest ?? 1) * overlap(t, 0, wy1, 1, wy1 + fh), 0)
                    - 0.0001 * Math.abs(wy1 + fh / 2 - cy / 1000);
                if (c > best) {
                    best = c;
                    x1 = 0;
                    y1 = wy1;
                }
            }
        } else {
            let best = -1;
            for (let i = 0; i <= 200; i++) {
                const wx1 = (1 - fw) * i / 200;
                const c = focus.reduce((s, t) => s + (t.interest ?? 1) * overlap(t, wx1, 0, wx1 + fw, 1), 0)
                    - 0.0001 * Math.abs(wx1 + fw / 2 - cx / 1000);
                if (c > best) {
                    best = c;
                    x1 = wx1;
                    y1 = 0;
                }
            }
        }
    }

    const x2 = x1 + fw, y2 = y1 + fh;
    const keep = things.map(t => overlap(t, x1, y1, x2, y2));
    const hardIdx = things.map((t, i) => (t.croppable === false ? i : -1)).filter(i => i >= 0);
    const hardWorst = hardIdx.length > 0 ? Math.min(...hardIdx.map(i => keep[i])) : null;
    const focusKeep = focus.map(t => overlap(t, x1, y1, x2, y2));
    const covTotal = focus.reduce((s, t) => s + (t.interest ?? 1), 0);
    const coverage = 100 * focus.reduce((s, t, i) => s + (t.interest ?? 1) * focusKeep[i], 0) / covTotal;

    let verdict;
    if (cls === "WIDE") {
        verdict = "CROP";
    } else if (cls === "HARD") {
        verdict = coverage >= o.covMin && hardWorst >= o.hardMin / 100 ? "CROP" : "KEEP";
    } else {
        verdict = coverage >= o.covMin ? "CROP" : "KEEP"; // ANCHOR: gate on anchor coverage
    }

    return {cls: cls, branch: branch, verdict: verdict, window: [x1, y1, x2, y2], coverage: coverage, hardWorst: hardWorst};
}

/**
 * Two-pass (coarse 21x21, refine) argmax of [score] over the given ranges.
 *
 * @param {function(number, number): number} score
 * @param {number} xLo
 * @param {number} xHi
 * @param {number} yLo
 * @param {number} yHi
 * @return {{x1: number, y1: number}}
 */
function slide(score, xLo, xHi, yLo, yHi) {
    const step = (lo, hi) => (hi - lo) / 20;
    let best = -Infinity, bx = xLo, by = yLo;

    for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
            const x = xLo + (xHi - xLo) * i / 20, y = yLo + (yHi - yLo) * j / 20;
            const s = score(x, y);
            if (s > best) {
                best = s;
                bx = x;
                by = y;
            }
        }
    }
    for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
            const x = Math.max(xLo, Math.min(xHi, bx - step(xLo, xHi) + (xHi - xLo) * i / 20));
            const y = Math.max(yLo, Math.min(yHi, by - step(yLo, yHi) + (yHi - yLo) * j / 20));
            const s = score(x, y);
            if (s > best) {
                best = s;
                bx = x;
                by = y;
            }
        }
    }

    return {x1: bx, y1: by};
}

/**
 * How much of the panel the whole photo covers when contain-fit (the KEEP
 * presentation): below fillMin the photo should not be listed for this
 * device at all rather than float absurdly in a sea of letterbox.
 *
 * @param {number} photoW
 * @param {number} photoH
 * @param {{width: number, height: number}} panel
 * @return {number} 0..1
 */
function containFill(photoW, photoH, panel) {
    const photoAr = photoW / photoH, panelAr = panel.width / panel.height;

    return photoAr > panelAr
        ? panel.width * (panel.width / photoAr) / (panel.width * panel.height)
        : (panel.height * photoAr) * panel.height / (panel.width * panel.height);
}

/**
 * Pixels for sharp.extract, with clamping against round-off at the edges.
 *
 * @param {[number, number, number, number]} window - fractional
 * @param {number} photoW
 * @param {number} photoH
 */
function windowToPixels(window, photoW, photoH) {
    const left = Math.max(0, Math.min(photoW - 2, Math.round(window[0] * photoW)));
    const top = Math.max(0, Math.min(photoH - 2, Math.round(window[1] * photoH)));
    const width = Math.max(2, Math.min(photoW - left, Math.round((window[2] - window[0]) * photoW)));
    const height = Math.max(2, Math.min(photoH - top, Math.round((window[3] - window[1]) * photoH)));

    return {left: left, top: top, width: width, height: height};
}

module.exports = {
    decide: decide,
    classify: classify,
    containFill: containFill,
    windowToPixels: windowToPixels,
    rotateThings: rotateThings,
    turnedDims: turnedDims,
    DEFAULTS: DEFAULTS,
    FILL_MIN: FILL_MIN
};
