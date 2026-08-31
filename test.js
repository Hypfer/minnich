const Logger = require("./src/Logger");
const Library = require("./src/Library");
const ImmichApi = require("./src/ImmichApi");
const Smartcrop = require("./src/Smartcrop");
const Sidecars = require("./src/Sidecars");
const CropEngine = require("./src/CropEngine");
const Admin = require("./src/Admin");
const testphotos = require("./testphotos");
const sharp = require("sharp");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

(async () => {
    // Synthetic photos in a temp dir: nothing binary in the repo
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "minnich-test-"));
    await testphotos.make(testDir);

    const library = new Library(testDir);
    const sc = new Smartcrop({testpanel: {width: 640, height: 320}});
    const sidecars = new Sidecars(testDir);
    const api = new ImmichApi(library, {
        smartcrop: sc,
        sidecars: sidecars
    });
    const admin = new Admin(library);
    admin.init(api);
    api.admin = admin;

    function assert(cond, msg) {
        if (cond) {
            console.log(`  ok - ${msg}`);
        } else {
            console.log(`  FAIL - ${msg}`);
            process.exitCode = 1;
        }
    }

    async function call(method, path, body, key = "test") {
        const options = {
            method: method,
            headers: {"x-api-key": key}
        };
        if (body) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }

        const res = await fetch(`http://127.0.0.1:30123${path}`, options);
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString("utf8");

        return {
            status: res.status,
            headers: res.headers,
            json: () => JSON.parse(text || "null"),
            bytes: () => buf
        };
    }

    await api.listen(30123);
    Logger.setLogLevel("warn");

    try {
        // Albums
        let r = await call("GET", "/api/albums");
        let albums = await r.json();
        assert(r.status === 200 && Array.isArray(albums) && albums.length === 1, `albums: one synthetic album (${albums[0]?.albumName}, ${albums[0]?.assetCount} assets)`);

        const allAssets = await library.list();

        r = await call("GET", "/api/albums?shared=true");
        assert(r.status === 200, "albums?shared=true: answered");

        // Search (3 synthetic photos)
        r = await call("POST", "/api/search/metadata", {page: 1, size: 2, withExif: true});
        let search = await r.json();
        assert(r.status === 200 && search.assets.items.length === 2, `search page 1: ${search.assets.items.length} items`);
        assert(search.assets.nextPage === 2, `search page 1: nextPage ${search.assets.nextPage}`);
        const first = search.assets.items[0];
        assert(first.type === "IMAGE", "search: type IMAGE");
        if (search.assets.total > 0) {
            assert(first.exifInfo?.exifImageWidth > 0 && first.exifInfo?.exifImageHeight > 0,
                `search: sniffed exifInfo ${first.exifInfo?.exifImageWidth}x${first.exifInfo?.exifImageHeight} orientation ${first.exifInfo?.orientation}`);
        }

        // Pagination end
        const total = search.assets.total;
        const lastPage = Math.max(1, Math.ceil(total / 2));
        r = await call("POST", "/api/search/metadata", {page: lastPage, size: 2, withExif: true});
        search = await r.json();
        assert(search.assets.nextPage === null, `search last page (${lastPage}): nextPage null`);

        // without exif
        r = await call("POST", "/api/search/metadata", {page: 1, size: 2});
        search = await r.json();
        assert(search.assets.items.every(i => i.exifInfo === undefined), "search without withExif: no exifInfo");

        // Thumbnail: real bytes
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`);
        const bytes = await r.bytes();
        assert(r.status === 200 && bytes.length > 0, `thumbnail: ${bytes.length} bytes`);
        assert(bytes[0] === 0xff && bytes[1] === 0xd8, "thumbnail: JPEG magic bytes");
        const firstMeta = await library.get(first.id);
        const firstBytes = await fs.readFile(firstMeta.file);

        // Asset detail
        r = await call("GET", `/api/assets/${first.id}`);
        let detail = await r.json();
        assert(r.status === 200 && detail.exifInfo.exifImageWidth > 0, "asset detail: dimensions");

        // Albums by asset
        r = await call("GET", `/api/albums?assetId=${first.id}`);
        albums = await r.json();
        assert(r.status === 200 && albums.length === 1, "albums?assetId: one album");

        // Video: 404 by design
        r = await call("GET", `/api/assets/${first.id}/video/playback`);
        assert(r.status === 404, "video playback: 404 by design");

        // Unknown id
        r = await call("GET", "/api/assets/nonexistent/thumbnail");
        assert(r.status === 404, "unknown id: 404");

        // Unknown route
        r = await call("GET", "/api/server/info");
        assert(r.status === 404, "unknown route: 404");

        // Smartcrop: a key with a profile gets panel-shaped, panel-sized bytes
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`, null, "testpanel");
        const cropped = await r.bytes();
        const meta = await sharp(cropped).metadata();
        assert(r.status === 200 && meta.width === 640 && meta.height === 320,
            `smartcrop thumbnail: ${meta.width}x${meta.height}, ${cropped.length} bytes`);
        assert(cropped.length < firstBytes.length, `smartcrop thumbnail smaller than original (${cropped.length}B < ${firstBytes.length}B)`);

        // Smartcrop search: the profile reports the cropped shape
        r = await call("POST", "/api/search/metadata", {page: 1, size: 5, withExif: true}, "testpanel");
        search = await r.json();
        const cinfo = search.assets.items[0].exifInfo;
        assert(cinfo.exifImageWidth === 640 && cinfo.exifImageHeight === 320 && cinfo.orientation === "1",
            `smartcrop search: exifInfo reports panel shape ${cinfo.exifImageWidth}x${cinfo.exifImageHeight}`);

        // Smartcrop: an unknown key still gets the original
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`, null, "unknownkey");
        const orig = await r.bytes();
        const ometa = await sharp(orig).metadata();
        assert(ometa.width === firstMeta.w, `unknown key: original served (${ometa.width}x${ometa.height})`);

        // Smartcrop: a landscape photo under the :portrait variant is
        // mismatched now — it jumps out of the crop too, original served
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`, null, "testpanel:portrait");
        const pmeta = await sharp(await r.bytes()).metadata();
        assert(r.status === 200 && pmeta.width === firstMeta.w && pmeta.height === firstMeta.h,
            `portrait panel, landscape photo: jumps out (${pmeta.width}x${pmeta.height})`);
        assert(sc.profile("testpanel:landscape").width === 640, "landscape key variant: axes normalized");

        // Smartcrop: a portrait photo on a landscape panel jumps out of the
        // crop — original bytes, true exifInfo, so the kiosk can pair it
        const portraitAsset = allAssets.find(m => {
            const turned = m.orientation >= 5 && m.orientation <= 8;
            return turned ? m.w < m.h : m.h > m.w;
        });
        if (portraitAsset) {
            r = await call("GET", `/api/assets/${portraitAsset.id}/thumbnail?size=preview`, null, "testpanel");
            const pm = await sharp(await r.bytes()).metadata();
            assert(pm.width === portraitAsset.w && pm.height === portraitAsset.h,
                `portrait photo on landscape panel: original ${pm.width}x${pm.height} served`);

            r = await call("POST", "/api/search/metadata", {page: 1, size: 500, withExif: true}, "testpanel");
            search = await r.json();
            const reported = search.assets.items.find(i => i.id === portraitAsset.id);
            assert(reported.exifInfo.exifImageWidth === portraitAsset.w,
                `portrait photo search: true dims reported (${reported.exifInfo.exifImageWidth}x${reported.exifInfo.exifImageHeight}) for pairing`);
        } else {
            console.log("  (no portrait photo in test set, skip pairing-out assertions)");
        }

        // ===== Sidecar wiring (contract, not geometry: the engine's
        // correctness lives in croplab's eyeballed renders) =====
        const sidecarDir = path.join(testDir, ".minnich");
        await fs.mkdir(sidecarDir, {recursive: true});
        const hash = await sidecars.hash(first);
        const things = [
            {label: "bands", interest: 0.9, croppable: true, left: 0, top: 0, right: 1000, bottom: 1000}
        ];

        // 1. annotated photo crops through the API (geometry path, not attention)
        await fs.writeFile(path.join(sidecarDir, `${hash}.json`), JSON.stringify({
            version: 1, classifier: "v1", w: firstMeta.w, h: firstMeta.h, things: things
        }), "utf8");
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`, null, "testpanel");
        const geoMeta = await sharp(await r.bytes()).metadata();
        assert(r.status === 200 && geoMeta.width === 640 && geoMeta.height === 320,
            `annotated photo: geometry-cropped to panel (${geoMeta.width}x${geoMeta.height})`);

        // 2. stale classifier reads as absent -> attention fallback
        await fs.writeFile(path.join(sidecarDir, `${hash}.json`), JSON.stringify({
            version: 1, classifier: "v0", w: firstMeta.w, h: firstMeta.h, things: things
        }), "utf8");
        sidecars.cache.delete(hash);
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`, null, "testpanel");
        const attnMeta = await sharp(await r.bytes()).metadata();
        assert(r.status === 200 && attnMeta.width === 640 && attnMeta.height === 320,
            "stale classifier: falls through to attention crop, still serves");

        // 3. no sidecar at all -> attention (compat behavior)
        await fs.rm(path.join(sidecarDir, `${hash}.json`), {force: true});
        sidecars.cache.delete(hash);
        r = await call("GET", `/api/assets/${first.id}/thumbnail?size=preview`, null, "testpanel");
        assert(r.status === 200 && (await sharp(await r.bytes()).metadata()).width === 640,
            "unannotated photo: attention crop, annotated and plain photos mix");
        // ===== frame() byte-identity: what the UI shows is what the kiosk gets =====
        // Self-contained: pick an orientation-1 photo, plant a fresh sidecar,
        // compare frame() against the live kiosk route for the same key.
        const idPhoto = allAssets.find(m => m.orientation === 1 && m.name !== "red.jpg");
        const h3 = await sidecars.hash(idPhoto);
        await fs.writeFile(path.join(sidecarDir, `${h3}.json`), JSON.stringify({
            version: 1, classifier: "v1", w: idPhoto.w, h: idPhoto.h,
            things: [{label: "bands", interest: 0.9, croppable: true, left: 0, top: 0, right: 1000, bottom: 1000}]
        }), "utf8");
        sidecars.cache.delete(h3);
        api.invalidateDecisions();

        const idBytes = await fs.readFile(idPhoto.file);
        const viaFrame = await api.frame(idBytes, idPhoto, "testpanel", sc.profile("testpanel"));
        r = await call("GET", `/api/assets/${idPhoto.id}/thumbnail?size=preview`, null, "testpanel");
        const viaHttp = await r.bytes();
        assert(viaFrame.image.equals(viaHttp),
            "frame() and the kiosk thumbnail route serve identical bytes");
        assert(viaFrame.reason === "geometry",
            `frame() reason geometry for annotated photo (${viaFrame.reason})`);

        // ===== EXIF orientation contract =====
        // Boxes live in stored space (what the model saw); the engine and
        // sharp work display space. decide()/frame() must bridge both.
        const portraitMeta = allAssets.find(m => m.orientation >= 5 && m.orientation <= 8);
        if (portraitMeta) {
            const h2 = await sidecars.hash(portraitMeta);
            // a hard thing dead-center in DISPLAY space (post-rotation): the
            // stored-space box that maps onto it is transformed back below
            await fs.writeFile(path.join(sidecarDir, `${h2}.json`), JSON.stringify({
                version: 1, classifier: "v1",
                w: portraitMeta.w, h: portraitMeta.h,
                things: [{label: "cat", interest: 0.9, croppable: false, left: 400, top: 400, right: 600, bottom: 600}]
            }), "utf8");
            sidecars.cache.delete(h2);
            r = await call("GET", `/api/assets/${portraitMeta.id}/thumbnail?size=preview`, null, "testpanel:portrait");
            const rotatedMeta = await sharp(await r.bytes()).metadata();
            assert(rotatedMeta.width === 320 && rotatedMeta.height === 640,
                `EXIF-rotated annotated photo: display-space crop (${rotatedMeta.width}x${rotatedMeta.height})`);

            // and the box that produced it, seen through the admin's lens
            r = await call("GET", `/admin/api/photo/${portraitMeta.id}?panel=testpanel:portrait`);
            const pdetail = await r.json();
            const t0 = pdetail.things[0];
            const inside = t0.left >= 0 && t0.top >= 0 && t0.right <= 1000 && t0.bottom <= 1000;
            assert(r.status === 200 && t0 && t0.croppable === false && inside,
                "admin photo detail: things returned in display space, in-frame");
        } else {
            console.log("  (no EXIF-rotated photo in test set, skip orientation assertions)");
        }

        // ===== Admin interface =====
        r = await call("GET", "/admin");
        const adminHtml = (await r.bytes()).toString("utf8");
        assert(r.status === 200 && adminHtml.includes("minnich admin"), "/admin: HTML served");
        assert(!("x-api-key" in r.headers || r.status === 401), "admin: no key required");

        r = await call("GET", "/admin/api/state");
        const state = await r.json();
        assert(state.panels.some(p => p.key === "testpanel"),
            "admin state: panel list from backend profiles");
        assert(state.annotate.running === false, "admin state: annotate idle at start");

        // variants exposed with resolved dims; ones identical to the base skipped
        const keys = state.panels.map(p => p.key);
        assert(keys.includes("testpanel:portrait") && !keys.includes("testpanel:landscape"),
            "admin state: portrait variant listed, redundant landscape variant skipped");
        const tp = state.panels.find(p => p.key === "testpanel:portrait");
        assert(tp.label.includes("320×640"), `admin state: variant label shows its dims (${tp.label})`);

        r = await call("GET", "/admin/api/photos?panel=testpanel");
        const photos = await r.json();
        assert(Array.isArray(photos) && photos.length === allAssets.length,
            `admin photos: all ${allAssets.length} photos listed`);
        assert(photos.every(p => typeof p.verdict === "string" || p.verdict === null),
            "admin photos: verdict per photo (or null)");

        // Framed bytes = exactly what the kiosk would get
        r = await call("GET", `/admin/api/photo/${first.id}/framed?panel=testpanel`);
        const framedBytes = await r.bytes();
        const framedMeta = await sharp(framedBytes).metadata();
        assert(framedMeta.width === 640 && framedMeta.height === 320,
            "admin framed: panel-sized bytes via the same pipeline");

        // Preview overlay: original + boxes, still a JPEG
        r = await call("GET", `/admin/api/photo/${first.id}/preview?panel=testpanel&w=420`);
        const previewBytes = await r.bytes();
        const previewMeta = await sharp(previewBytes).metadata();
        assert(previewBytes[0] === 0xff && previewBytes[1] === 0xd8,
            "admin preview: JPEG overlay rendered");
        assert(previewMeta.width === 420, `admin preview: resized to target width (${previewMeta.width})`);

        // Annotate trigger: spawns annotate.js; with the LLM unreachable it
        // fails per-request, feeds the log, exits nonzero, invalidates caches.
        r = await call("POST", "/admin/api/annotate");
        const trigger = await r.json();
        assert(trigger.started === true, "admin annotate: child started");
        r = await call("GET", "/admin/api/state");
        let st2 = await r.json();
        assert(st2.annotate.running === true, "admin annotate: state reports running");

        await new Promise(resolve => {
            const poll = setInterval(async () => {
                const s = await (await fetch("http://127.0.0.1:30123/admin/api/state")).json();
                if (!s.annotate.running) {
                    clearInterval(poll);
                    resolve();
                }
            }, 100);
        });
        r = await call("GET", "/admin/api/state");
        st2 = await r.json();
        assert(st2.annotate.code !== 0 && st2.annotate.lines.length > 0,
            `admin annotate: failed run reports exit ${st2.annotate.code} + log lines`);
        r = await call("GET", "/admin/api/photos?panel=testpanel");
        const photos2 = await r.json();
        assert(photos2.length === photos.length, "admin photos: stable after annotate run");

        // ===== Explicit-scan model: no auto-rescan; new photos appear only
        // after a scan (admin button / nightly / startup) =====
        const beforeCount = (await library.list()).length;

        // a photo dropped in after the last scan is invisible until scanned
        await testphotos.make(testDir + "/subfolder-late");
        let late = await call("POST", "/api/search/metadata", {page: 1, size: 500});
        let lateSearch = await late.json();
        assert(lateSearch.assets.total === beforeCount,
            `no auto-rescan: late photo not listed (${lateSearch.assets.total} = ${beforeCount})`);

        // the admin scan button triggers it
        r = await call("POST", "/admin/api/scan");
        assert((await r.json()).started === true, "admin scan: started");
        await library.scanning; // wait it out
        late = await call("POST", "/api/search/metadata", {page: 1, size: 500});
        lateSearch = await late.json();
        assert(lateSearch.assets.total === beforeCount + 4,
            `after scan: late photos listed (${lateSearch.assets.total})`);

        // state endpoint reports the library
        r = await call("GET", "/admin/api/state");
        const st3 = await r.json();
        assert(st3.library.assets === beforeCount + 4 && st3.library.lastScan > 0,
            "admin state: library assets and lastScan reported");

        // ===== annotate force param: spawns with FORCE=1 =====
        r = await call("POST", "/admin/api/annotate?force=1");
        assert((await r.json()).started === true, "admin annotate force: child started");
        await new Promise(resolve => {
            const poll = setInterval(async () => {
                const s = await (await fetch("http://127.0.0.1:30123/admin/api/state")).json();
                if (!s.annotate.running) {
                    clearInterval(poll);
                    resolve();
                }
            }, 100);
        });
        r = await call("GET", "/admin/api/state");
        st2 = await r.json();
        assert(/forced/.test(st2.annotate.lines.join(" ")),
            "admin annotate force: log line shows forced run");
    } finally {
        // close server so the process ends naturally; exit code is set by asserts
        api.server?.close();
    }
})().catch(err => {
    console.error("test crashed:", err);
    process.exit(1);
});
