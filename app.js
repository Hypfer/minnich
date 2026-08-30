const Logger = require("./Logger");
const Library = require("./Library");
const ImmichApi = require("./ImmichApi");

if (process.env.LOGLEVEL) {
    Logger.setLogLevel(process.env.LOGLEVEL);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PHOTO_DIR = process.env.PHOTO_DIR ?? "/photos";
const API_KEY = process.env.API_KEY ?? ""; // any value disables key checks

const library = new Library(PHOTO_DIR);
const api = new ImmichApi(library, {
    apiKey: API_KEY
});

api.listen(PORT).then(() => {
    Logger.info(`minnich serving ${PHOTO_DIR} on :${PORT}`);
}).catch(err => {
    Logger.error("Error while starting server", err);
    process.exit(1);
});
