/**
 * The management interface: /admin on the same server and port as the API,
 * no auth — all internal. Rides along on ImmichApi's http server; the
 * delegation happens before the API-key check.
 *
 *  - the library grid: every photo, its sidecar state, and for a chosen
 *    panel preset the verdict plus the annotated boxes and the crop window
 *    drawn over a preview
 *  - the per-photo view: large annotated original next to the exact bytes
 *    the panel would serve, plus the engine's explanation
 *  - an annotate trigger: runs annotate.js as a child process (it stays a
 *    separate process — serving must not depend on the LLM) and surfaces
 *    its log as progress feedback
 */

const {spawn} = require("child_process");
const path = require("path");
const Logger = require("./Logger");
const CropEngine = require("./CropEngine");
const sharp = require("sharp");

const RING = 300; // log lines kept for the UI

/** XML-escape a model-provided label before it enters the overlay SVG. */
function esc(s) {
    return `${s}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

class Admin {
    /**
     * @param {import("./Library")} library
     */
    constructor(library) {
        this.library = library;
        this.api = null; // set by init() — ImmichApi owns the routing

        /** annotate.js child state; the log ring doubles as its feedback channel */
        this.annotate = {running: false, code: null, startedAt: null, finishedAt: null, lines: []};
    }

    /**
     * @public
     * @param {import("./ImmichApi")} api
     */
    init(api) {
        this.api = api;
    }

    /**
     * @public
     * @param {string} pathname
     * @return {boolean}
     */
    canHandle(pathname) {
        return pathname === "/admin" || pathname.startsWith("/admin/");
    }

    /**
     * Panel options for the dropdown: each built-in profile plus its
     * ":portrait"/":landscape" variants, labeled with the dimensions the
     * variant actually resolves to. Variants identical to the base profile
     * (same numbers, e.g. landscape on an already-landscape panel) are
     * skipped — no redundant options.
     *
     * @private
     * @return {Array<{key: string, label: string}>}
     */
    panelOptions() {
        const keys = [...this.api.smartcrop.profiles.keys()].sort();
        const options = [];

        for (const name of keys) {
            const base = this.api.smartcrop.profile(name);
            options.push({key: name, label: `${name} (${base.width}×${base.height})`});

            for (const suffix of ["portrait", "landscape"]) {
                const key = `${name}:${suffix}`;
                const p = this.api.smartcrop.profile(key);
                if (p.width !== base.width || p.height !== base.height) {
                    options.push({key: key, label: `${key} (${p.width}×${p.height})`});
                }
            }
        }

        return options;
    }
    /**
     * @public
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     * @param {URL} url
     */
    async handle(req, res, url) {
        try {
            if (url.pathname === "/admin" && req.method === "GET") {
                return this.html(res);
            }

            if (url.pathname === "/admin/api/state" && req.method === "GET") {
                return this.json(res, 200, {
                    panels: this.panelOptions(),
                    annotate: {...this.annotate, lines: this.annotate.lines.slice(-40)},
                    library: {
                        assets: this.library.assets.size,
                        lastScan: this.library.lastScan || null,
                        scanning: !!this.library.scanning
                    }
                });
            }

            if (url.pathname === "/admin/api/photos" && req.method === "GET") {
                return this.json(res, 200, await this.photos(url.searchParams.get("panel") ?? ""));
            }

            let m = url.pathname.match(/^\/admin\/api\/photo\/([^/]+)$/);
            if (m && req.method === "GET") {
                return this.photoDetail(res, m[1], url.searchParams.get("panel") ?? "");
            }

            m = url.pathname.match(/^\/admin\/api\/photo\/([^/]+)\/preview$/);
            if (m && req.method === "GET") {
                return this.photoPreview(res, m[1], url, true);
            }

            m = url.pathname.match(/^\/admin\/api\/photo\/([^/]+)\/framed$/);
            if (m && req.method === "GET") {
                return this.photoFramed(res, m[1], url.searchParams.get("panel") ?? "");
            }

            if (url.pathname === "/admin/api/annotate" && req.method === "POST") {
                return this.json(res, 200, this.startAnnotate(url.searchParams.get("force") === "1"));
            }

            if (url.pathname === "/admin/api/scan" && req.method === "POST") {
                this.library.scan(); // async; state reports scanning
                return this.json(res, 200, {started: true});
            }

            return this.json(res, 404, {message: "no such admin route"});
        } catch (err) {
            Logger.error("admin error", url.pathname, err);

            return this.json(res, 500, {message: "admin error"});
        }
    }

    /**
     * The library as the admin sees it: one row per photo with its sidecar
     * state and its verdict for the chosen panel key.
     *
     * @private
     * @param {string} key - raw panel key, as the kiosk would send it
     */
    async photos(key) {
        const panel = this.api.smartcrop.profile(key);
        const out = [];
        for (const meta of await this.library.list()) {
            const sidecar = await this.api.sidecars?.get(meta);
            const dims = CropEngine.turnedDims(meta.w, meta.h, meta.orientation);
            let verdict = null, cls = null, coverage = null, hardWorst = null;

            if (panel) {
                const dec = await this.api.decide(meta, key, panel);
                verdict = dec ? dec.verdict : (this.api.smartcrop.orientationMatches(meta, panel) ? "ATTENTION" : null);
                cls = dec?.detail?.cls ?? null;
                coverage = dec?.detail ? Math.round(dec.detail.coverage) : null;
                hardWorst = dec?.detail?.hardWorst != null ? Math.round(dec.detail.hardWorst * 100) : null;
            }

            out.push({
                id: meta.id,
                name: meta.name,
                w: dims.w,
                h: dims.h,
                annotated: !!sidecar,
                things: sidecar ? sidecar.things.length : 0,
                verdict: verdict,
                cls: cls,
                coverage: coverage,
                hardWorst: hardWorst
            });
        }

        return out;
    }

    /**
     * Everything about one photo: display-space things, the engine's
     * explanation, and the raw sidecar for transparency.
     *
     * @private
     */
    async photoDetail(res, id, key) {
        const meta = await this.library.get(id);
        if (!meta) {
            return this.json(res, 404, {message: "asset not found"});
        }

        const sidecar = await this.api.sidecars?.get(meta);
        const panel = this.api.smartcrop.profile(key);
        const dims = CropEngine.turnedDims(meta.w, meta.h, meta.orientation);

        let decision = null, reason = null;
        if (panel) {
            decision = await this.api.decide(meta, key, panel);
            reason = decision
                ? (decision.verdict === "CROP" ? "geometry" : "original")
                : (this.api.smartcrop.orientationMatches(meta, panel) ? "attention" : "unannotated");
        }

        return this.json(res, 200, {
            id: meta.id,
            name: meta.name,
            w: dims.w,
            h: dims.h,
            orientation: meta.orientation,
            annotated: !!sidecar,
            things: sidecar ? CropEngine.rotateThings(sidecar.things, meta.orientation) : null,
            panel: key || null,
            panelDims: panel ? {w: panel.width, h: panel.height} : null,
            decision: decision,
            reason: reason
        });
    }

    /**
     * The original, EXIF-rotated, downscaled, with the annotation boxes
     * (red = must not be cut) and the crop window (dashed) drawn over it.
     * All in display space, like the geometry itself.
     *
     * @private
     */
    async photoPreview(res, id, url, withBoxes) {
        const meta = await this.library.get(id);
        const bytes = meta ? await this.library.readAsset(id) : null;
        if (!meta || !bytes) {
            return this.json(res, 404, {message: "asset not found"});
        }

        const target = Math.max(120, Math.min(1280, Number(url.searchParams.get("w")) || 420));
        const dims = CropEngine.turnedDims(meta.w, meta.h, meta.orientation);
        const w = target;
        const h = Math.max(2, Math.round(target * dims.h / Math.max(1, dims.w)));

        const sidecar = await this.api.sidecars?.get(meta);
        const things = withBoxes && sidecar ? CropEngine.rotateThings(sidecar.things, meta.orientation) : [];

        const key = url.searchParams.get("panel") ?? "";
        const panel = this.api.smartcrop.profile(key);
        let window = null;
        if (panel) {
            const dec = await this.api.decide(meta, key, panel);
            if (dec?.verdict === "CROP") {
                window = dec.window;
            }
        }

        const sx = w / 1000, sy = h / 1000;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`;
        if (window) {
            const rx = Math.round(window[0] * w), ry = Math.round(window[1] * h);
            const rw = Math.round((window[2] - window[0]) * w), rh = Math.round((window[3] - window[1]) * h);
            svg += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="#39d353" stroke-width="3" stroke-dasharray="10 6"/>`;
        }
        for (const t of things) {
            const hard = t.croppable === false;
            svg += `<rect x="${Math.round(t.left * sx)}" y="${Math.round(t.top * sy)}" width="${Math.round((t.right - t.left) * sx)}" height="${Math.round((t.bottom - t.top) * sy)}" fill="${hard ? "rgba(248,81,73,0.12)" : "rgba(255,255,255,0.06)"}" stroke="${hard ? "#f85149" : "rgba(255,255,255,0.85)"}" stroke-width="${hard ? 3 : 2}"/>`;
            if (target >= 640) {
                svg += `<text x="${Math.round(t.left * sx) + 4}" y="${Math.round(t.top * sy) + 16}" fill="${hard ? "#ffb3ae" : "#e6edf3"}" font-size="14" font-family="sans-serif">${esc(t.label)} ${Number(t.interest ?? 0).toFixed(2)}</text>`;
            }
        }
        svg += "</svg>";

        const out = await sharp(bytes)
            .rotate()
            .resize(w, h)
            .composite([{input: Buffer.from(svg)}])
            .jpeg({quality: 84})
            .toBuffer()
            .catch(err => {
                Logger.warn(`admin preview failed for ${meta.name}: ${err?.message ?? err}`);

                return null;
            });

        if (!out) {
            return this.json(res, 500, {message: "preview failed"});
        }

        res.writeHead(200, {"Content-Type": "image/jpeg", "Cache-Control": "no-store"});
        res.end(out);
    }

    /**
     * The exact bytes the kiosk gets for this photo under this key.
     *
     * @private
     */
    async photoFramed(res, id, key) {
        const meta = await this.library.get(id);
        const bytes = meta ? await this.library.readAsset(id) : null;
        if (!meta || !bytes) {
            return this.json(res, 404, {message: "asset not found"});
        }

        const panel = this.api.smartcrop.profile(key);
        if (!panel) {
            res.writeHead(200, {"Content-Type": "application/octet-stream", "Cache-Control": "no-store"});
            res.end(bytes);

            return;
        }

        const {image} = await this.api.frame(bytes, meta, key, panel);

        res.writeHead(200, {"Content-Type": "application/octet-stream", "Cache-Control": "no-store"});
        res.end(image ?? bytes);
    }

    /**
     * Spawn annotate.js against the same photo dir the server serves.
     * Its log lines land in the state endpoint; caches are invalidated
     * when it exits so fresh sidecars take effect immediately. force=1
     * re-annotates everything (FORCE env in the child).
     *
     * @private
     * @param {boolean} force
     * @return {{started: boolean}}
     */
    startAnnotate(force = false) {
        if (this.annotate.running) {
            return {started: false};
        }

        this.annotate = {running: true, code: null, startedAt: Date.now(), finishedAt: null, lines: []};
        const push = line => {
            this.annotate.lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`.slice(0, 500));
            if (this.annotate.lines.length > RING) {
                this.annotate.lines.shift();
            }
        };

        // Same photo dir as this server serves; LLM_URL/MODEL/CONCURRENCY
        // come from the server's own environment (deployment details). The
        // child gets PHOTO_DIR explicitly: the parent env may disagree
        // (tests) or be unset. It scans the dir itself, so photos added
        // since this server's last scan are annotated too.
        const child = spawn(process.execPath, [path.join(__dirname, "annotate.js")], {
            env: {...process.env, PHOTO_DIR: this.library.dir, FORCE: force ? "1" : ""}
        });

        const feed = stream => stream.on("data", buf => {
            for (const line of buf.toString("utf8").split("\n")) {
                if (line.trim()) {
                    push(line);
                }
            }
        });
        feed(child.stdout);
        feed(child.stderr);

        child.on("error", err => push(`spawn failed: ${err?.message ?? err}`));
        child.on("exit", code => {
            this.annotate.running = false;
            this.annotate.code = code;
            this.annotate.finishedAt = Date.now();
            push(`annotate.js exited with code ${code}`);

            // the child may have annotated photos this server has not yet
            // scanned; rescan so they appear, then drop cached decisions
            this.library.scan().catch(() => {}).then(() => {
                this.api.invalidateDecisions();
                this.api.sidecars?.invalidate();
            });
        });

        return {started: true};
    }

    /**
     * @private
     */
    json(res, status, body) {
        res.writeHead(status, {"Content-Type": "application/json"});
        res.end(JSON.stringify(body));
    }

    /**
     * @private
     */
    html(res) {
        res.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"});
        res.end(PAGE);
    }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>minnich admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
  header { position: sticky; top: 0; z-index: 5; display: flex; gap: 12px; align-items: center;
           padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0 8px 0 0; }
  select, button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
                   padding: 6px 10px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #8b949e; }
  #status.run { color: #d29922; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; padding: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; cursor: pointer; }
  .card:hover { border-color: #58a6ff; }
  .card img { display: block; width: 100%; aspect-ratio: auto; background: #010409; min-height: 60px; }
  .card .meta { padding: 6px 8px; display: flex; gap: 6px; align-items: center; justify-content: space-between; }
  .card .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8b949e; }
  .b { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid; white-space: nowrap; }
  .CROP { color: #39d353; border-color: #39d353; }
  .KEEP { color: #d29922; border-color: #d29922; }
  .EXCLUDE { color: #f85149; border-color: #f85149; }
  .ATTENTION { color: #58a6ff; border-color: #58a6ff; }
  .NONE { color: #8b949e; border-color: #8b949e; }
  dialog { max-width: min(1200px, 94vw); background: #161b22; color: #e6edf3; border: 1px solid #30363d;
           border-radius: 10px; padding: 16px; }
  dialog::backdrop { background: rgba(1,4,9,.8); }
  .pair { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
  .pair figure { margin: 0; flex: 1 1 340px; }
  .pair img { width: 100%; border-radius: 6px; display: block; }
  figcaption { color: #8b949e; margin-top: 4px; }
  table { border-collapse: collapse; margin-top: 10px; width: 100%; }
  td, th { border: 1px solid #30363d; padding: 3px 8px; text-align: left; font-size: 13px; }
  .explain { color: #8b949e; margin: 10px 0 0; }
  #log { display: none; background: #010409; border: 1px solid #30363d; border-radius: 6px;
         padding: 8px; margin: 10px 16px; max-height: 180px; overflow-y: auto; font: 12px/1.5 ui-monospace, monospace;
         white-space: pre-wrap; color: #8b949e; }
  #log.show { display: block; }
</style>
</head>
<body>
<header>
  <h1>minnich</h1>
  <select id="panel"></select>
  <button id="run">Run annotate</button>
  <label style="display:flex;align-items:center;gap:4px;color:#8b949e;cursor:pointer">
    <input type="checkbox" id="force"> all</label>
  <button id="scan">Rescan</button>
  <span id="status"></span>
</header>
<div id="log"></div>
<main id="grid"></main>

<dialog id="dlg">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
    <strong id="d-name"></strong>
    <button onclick="dlg.close()">close</button>
  </div>
  <div class="pair" style="margin-top:10px">
    <figure><img id="d-orig"><figcaption>original + boxes (<span style="color:#f85149">never cut</span>,
      <span style="color:#e6edf3">scenery</span>, <span style="color:#39d353">crop window</span>)</figcaption></figure>
    <figure><img id="d-framed"><figcaption id="d-why"></figcaption></figure>
  </div>
  <p class="explain" id="d-explain"></p>
  <div id="d-things"></div>
</dialog>

<script>
var panel = "", timer = null;

function badge(v) {
  var cls = v || "NONE";
  var txt = v || "no annotation";
  return '<span class="b ' + cls + '">' + txt + '</span>';
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function loadPhotos() {
  var grid = document.getElementById("grid");
  grid.textContent = "loading…";
  var photos = await (await fetch("/admin/api/photos?panel=" + encodeURIComponent(panel))).json();
  grid.textContent = "";
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    var card = document.createElement("div");
    card.className = "card";
    var cov = p.coverage != null ? " · " + p.coverage + "%" : "";
    card.innerHTML = '<img loading="lazy" src="/admin/api/photo/' + encodeURIComponent(p.id) +
      '/preview?panel=' + encodeURIComponent(panel) + '&w=420">' +
      '<div class="meta"><span class="name" title="' + esc(p.name) + '">' + esc(p.name.split("/").pop()) +
      '</span>' + badge(p.verdict) + "</div>" +
      '<div class="meta"><span class="name">' + p.w + "×" + p.h + cov + "</span>" +
      '<span class="name">' + (p.annotated ? p.things + " things" : "") + "</span></div>";
    card.onclick = openDetail.bind(null, p.id);
    grid.appendChild(card);
  }
}

async function openDetail(id) {
  var d = await (await fetch("/admin/api/photo/" + encodeURIComponent(id) + "?panel=" + encodeURIComponent(panel))).json();
  document.getElementById("d-name").textContent = d.name;
  document.getElementById("d-orig").src = "/admin/api/photo/" + encodeURIComponent(id) +
    "/preview?panel=" + encodeURIComponent(panel) + "&w=1000";
  document.getElementById("d-framed").src = "/admin/api/photo/" + encodeURIComponent(id) +
    "/framed?panel=" + encodeURIComponent(panel);
  var why = {geometry: "geometry crop — what the panel serves", attention: "attention crop (unannotated fallback)",
             original: "original — the kiosk letterboxes it", unannotated: "original (unannotated, wrong-facing)"};
  var dec = d.decision ? " · " + d.decision.verdict : "";
  document.getElementById("d-why").textContent = (why[d.reason] || d.reason) + dec;
  var ex = d.decision && d.decision.detail
    ? d.decision.detail.cls + " / branch " + d.decision.detail.branch +
      " · coverage " + Math.round(d.decision.detail.coverage) + "%" +
      (d.decision.detail.hardWorst != null ? " · worst hard-subject " + Math.round(d.decision.detail.hardWorst * 100) + "%" : "")
    : d.annotated ? "no panel selected" : "not annotated";
  document.getElementById("d-explain").textContent = ex + (d.panelDims ? " · panel " + d.panelDims.w + "×" + d.panelDims.h : "");
  var t = d.things || [];
  document.getElementById("d-things").innerHTML = t.length
    ? "<table><tr><th>label</th><th>interest</th><th>croppable</th><th>box (0-1000)</th></tr>" +
      t.map(function (x) {
        return "<tr><td>" + esc(x.label) + "</td><td>" + Number(x.interest).toFixed(2) +
          "</td><td>" + (x.croppable === false ? "no" : "yes") + "</td><td>" +
          x.left + "," + x.top + " – " + x.right + "," + x.bottom + "</td></tr>";
      }).join("") + "</table>"
    : "";
  dlg.showModal();
}

async function refreshState() {
  var s = await (await fetch("/admin/api/state")).json();
  var sel = document.getElementById("panel");
  if (sel.options.length === 0) {
    for (var i = 0; i < s.panels.length; i++) {
      var o = document.createElement("option");
      o.value = s.panels[i].key;
      o.textContent = s.panels[i].label;
      sel.appendChild(o);
    }
    if (s.panels.length) { panel = s.panels[0].key; sel.value = panel; loadPhotos(); }
    sel.onchange = function () { panel = sel.value; loadPhotos(); };
  }
  var st = document.getElementById("status");
  var log = document.getElementById("log");
  if (s.annotate.running) {
    st.textContent = "annotating…";
    st.className = "run";
    document.getElementById("run").disabled = true;
    log.className = "show";
    log.textContent = s.annotate.lines.join("\\n");
    log.scrollTop = log.scrollHeight;
    if (!timer) { timer = setInterval(refreshState, 2000); }
  } else {
    st.textContent = s.annotate.code == null ? "idle" :
      "last run: exit " + s.annotate.code;
    st.className = "";
    document.getElementById("run").disabled = false;
    if (timer) {
      clearInterval(timer); timer = null;
      log.className = "show";
      log.textContent = s.annotate.lines.join("\\n") || "(no output)";
      loadPhotos(); // fresh sidecars, fresh verdicts
    }
  }
  if (s.library) {
    st.title = s.library.assets + " assets · scanned " +
      (s.library.lastScan ? new Date(s.library.lastScan).toLocaleString() : "never");
    if (s.library.scanning && !timer) { timer = setInterval(refreshState, 2000); }
  }
}

document.getElementById("run").onclick = async function () {
  var force = document.getElementById("force").checked ? "?force=1" : "";
  await fetch("/admin/api/annotate" + force, {method: "POST"});
  refreshState();
};
document.getElementById("scan").onclick = async function () {
  await fetch("/admin/api/scan", {method: "POST"});
  refreshState();
  setTimeout(loadPhotos, 1500);
};
refreshState();
</script>
</body>
</html>`;

module.exports = Admin;
