import sharp from "sharp";
import { readFile } from "node:fs/promises";

/**
 * VS Code ignores SVG for the extension icon, so the source is rasterised here
 * rather than a PNG being hand-maintained beside it.
 *
 * sharp is not a dependency: media/icon.png is committed and changes almost never,
 * and a rasteriser in every install and CI run is a poor trade for one asset.
 * Run `npm i -D sharp && node scripts/make-icon.mjs` when the source changes.
 */
const svg = await readFile(new URL("../media/icon-source.svg", import.meta.url));

await sharp(svg, { density: 384 })
  .resize(128, 128)
  .png({ compressionLevel: 9 })
  .toFile(new URL("../media/icon.png", import.meta.url).pathname);

console.log("media/icon.png written");
