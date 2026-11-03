import sharp from "sharp";
import fs from "node:fs";

const svg = fs.readFileSync(new URL("./icon.svg", import.meta.url));
fs.mkdirSync("icons", { recursive: true });
for (const s of [16, 32, 48, 128]) {
  await sharp(svg, { density: 384 }).resize(s, s).png().toFile(`icons/icon${s}.png`);
}
console.log("done");