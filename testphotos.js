/**
 * Synthetic test photos, generated on demand (nothing binary is committed).
 * Each is a flat-color image with recognizable structure so sniffing,
 * cropping and orientation logic have something real to chew on:
 *
 *   landscape.jpg  2000x1500  — two-tone horizontal bands (sky over ground)
 *   portrait.jpg   1500x2000  — the same, rotated
 *   red.jpg        1000x1000  — a red square on gray, near a corner
 *
 * test.js regenerates them into a temp dir on every run.
 */

const sharp = require("sharp");
const path = require("path");
const fs = require("fs/promises");

async function make(dir) {
    await fs.mkdir(dir, {recursive: true});

    const bands = `<svg width="2000" height="1500">
        <rect width="2000" height="600" fill="#7ba7d7"/>
        <rect y="600" width="2000" height="900" fill="#8a9a5b"/>
    </svg>`;
    await sharp(Buffer.from(bands)).jpeg({quality: 80}).toFile(path.join(dir, "landscape.jpg"));

    const bandsPortrait = `<svg width="1500" height="2000">
        <rect width="1500" height="800" fill="#7ba7d7"/>
        <rect y="800" width="1500" height="1200" fill="#8a9a5b"/>
    </svg>`;
    await sharp(Buffer.from(bandsPortrait)).jpeg({quality: 80}).toFile(path.join(dir, "portrait.jpg"));

    const redSquare = `<svg width="1000" height="1000">
        <rect width="1000" height="1000" fill="#9a9a9a"/>
        <rect x="120" y="120" width="200" height="200" fill="#d73030"/>
    </svg>`;
    await sharp(Buffer.from(redSquare)).jpeg({quality: 80}).toFile(path.join(dir, "red.jpg"));

    // EXIF orientation 6: stored 2000x1500, displayed 1500x2000. The red
    // square at stored (120,120) must display at (1180,120) after the 90°
    // CW rotation — the contract decide()/frame() must honor.
    const exifPortrait = await sharp(Buffer.from(`<svg width="2000" height="1500">
        <rect width="2000" height="1500" fill="#b7a27b"/>
        <rect x="120" y="120" width="200" height="200" fill="#d73030"/>
    </svg>`)).jpeg({quality: 80}).toBuffer();
    await fs.writeFile(path.join(dir, "exif-portrait.jpg"),
        await sharp(exifPortrait).withMetadata({orientation: 6}).jpeg().toBuffer());

    return {
        landscape: path.join(dir, "landscape.jpg"),
        portrait: path.join(dir, "portrait.jpg"),
        red: path.join(dir, "red.jpg"),
        exifPortrait: path.join(dir, "exif-portrait.jpg")
    };
}

module.exports = {make};
