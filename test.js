const Logger = require("./Logger");
const Library = require("./Library");
const ImmichApi = require("./ImmichApi");

const testDir = process.argv[2] ?? "./photos";

const library = new Library(testDir);
const api = new ImmichApi(library);

function assert(cond, msg) {
    if (cond) {
        console.log(`  ok - ${msg}`);
    } else {
        console.log(`  FAIL - ${msg}`);
        process.exitCode = 1;
    }
}

async function call(method, path, body) {
    const options = {
        method: method,
        headers: {"x-api-key": "test"}
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
        json: () => JSON.parse(text || "null"),
        bytes: () => buf
    };
}

(async () => {
    await api.listen(30123);
    Logger.setLogLevel("warn");

    try {
        // Albums
        let r = await call("GET", "/api/albums");
        let albums = await r.json();
        assert(r.status === 200 && Array.isArray(albums) && albums.length === 1, `albums: one synthetic album (${albums[0]?.albumName}, ${albums[0]?.assetCount} assets)`);

        r = await call("GET", "/api/albums?shared=true");
        assert(r.status === 200, "albums?shared=true: answered");

        // Search
        r = await call("POST", "/api/search/metadata", {page: 1, size: 5, withExif: true});
        let search = await r.json();
        assert(r.status === 200 && search.assets.items.length === 5, `search page 1: ${search.assets.items.length} items`);
        assert(search.assets.nextPage === 2, `search page 1: nextPage ${search.assets.nextPage}`);
        const first = search.assets.items[0];
        assert(first.type === "IMAGE", "search: type IMAGE");
        if (search.assets.total > 0) {
            assert(first.exifInfo?.exifImageWidth > 0 && first.exifInfo?.exifImageHeight > 0,
                `search: sniffed exifInfo ${first.exifInfo?.exifImageWidth}x${first.exifInfo?.exifImageHeight} orientation ${first.exifInfo?.orientation}`);
        }

        // Pagination end
        const total = search.assets.total;
        const lastPage = Math.max(1, Math.ceil(total / 5));
        r = await call("POST", "/api/search/metadata", {page: lastPage, size: 5, withExif: true});
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
    } finally {
        process.exit(process.exitCode ?? 0);
    }
})().catch(err => {
    console.error("test crashed:", err);
    process.exit(1);
});
