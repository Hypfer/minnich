const Logger = require("./Logger");
const Library = require("./Library");
const ImmichApi = require("./ImmichApi");
const Smartcrop = require("./Smartcrop");

if (process.env.LOGLEVEL) {
    Logger.setLogLevel(process.env.LOGLEVEL);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PHOTO_DIR = process.env.PHOTO_DIR ?? "/photos";
const API_KEY = process.env.API_KEY ?? ""; // any value disables key checks

// Per-device panel profiles, keyed by the API key the kiosk sends: a key
// that maps here gets its photos cropped to that panel's shape (around the
// salient region) and downscaled to its resolution. Any other key — or no
// Smartcrop at all when unset — gets the originals.
//
// SMARTCROP='{"echoshow5":{"width":960,"height":480},"echoshow8":{"width":1280,"height":800},"lenovotabk10":{"width":1920,"height":1200}}'
let smartcrop = null;
if (process.env.SMARTCROP) {
    try {
        smartcrop = new Smartcrop(JSON.parse(process.env.SMARTCROP));
        Logger.info(`Smartcrop profiles: ${[...smartcrop.profiles.keys()].join(", ")}`);
    } catch (err) {
        Logger.error(`Invalid SMARTCROP env (expected JSON key -> {{width, height}}), serving originals: ${err?.message ?? err}`);
    }
}

const library = new Library(PHOTO_DIR);
const api = new ImmichApi(library, {
    apiKey: API_KEY,
    smartcrop: smartcrop
});

api.listen(PORT).then(() => {
    Logger.info(`minnich serving ${PHOTO_DIR} on :${PORT}`);
}).catch(err => {
    Logger.error("Error while starting server", err);
    process.exit(1);
});
