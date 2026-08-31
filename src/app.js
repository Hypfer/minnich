const Logger = require("./Logger");
const Library = require("./Library");
const ImmichApi = require("./ImmichApi");
const Smartcrop = require("./Smartcrop");
const Sidecars = require("./Sidecars");
const Admin = require("./Admin");

if (process.env.LOGLEVEL) {
    Logger.setLogLevel(process.env.LOGLEVEL);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PHOTO_DIR = process.env.PHOTO_DIR ?? "/photos";
const API_KEY = process.env.API_KEY ?? ""; // when set, requests must carry it
const NIGHTLY_SCAN_HOUR = 3; // rescan the photo folder every day at 03:00 local

const smartcrop = new Smartcrop(); // panel profiles are built in, not configured
const library = new Library(PHOTO_DIR);
const sidecars = new Sidecars(PHOTO_DIR);
const api = new ImmichApi(library, {
    apiKey: API_KEY,
    smartcrop: smartcrop,
    sidecars: sidecars,
    admin: new Admin(library)
});
// Admin needs the api for decisions/framing; the api needs Admin for routing.
api.admin.init(api);

// Deliberate scans only: once now, then nightly. Requests in between are
// served from memory — walking the disk per request would be insane.
library.scan().then(() => {
    Logger.info(`Library: ${library.assets.size} assets`);
}).catch(err => {
    Logger.error("Startup scan failed", err);
});

const nightly = () => {
    library.scan().catch(err => Logger.error("Nightly scan failed", err));
    scheduleNextNightly();
};
const msUntil = hour => {
    const next = new Date();
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= Date.now()) {
        next.setDate(next.getDate() + 1);
    }

    return next.getTime() - Date.now();
};
const scheduleNextNightly = () => {
    setTimeout(nightly, msUntil(NIGHTLY_SCAN_HOUR)).unref();
};
scheduleNextNightly();

api.listen(PORT).then(() => {
    Logger.info(`minnich serving ${PHOTO_DIR} on :${PORT} (admin on /admin, nightly scan at ${NIGHTLY_SCAN_HOUR}:00)`);
    Logger.info(`Panels: ${[...smartcrop.profiles.keys()].join(", ")}`);
}).catch(err => {
    Logger.error("Error while starting server", err);
    process.exit(1);
});
