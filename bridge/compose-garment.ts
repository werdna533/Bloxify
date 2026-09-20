/**
 * Deterministic compositing step: drops a generated flat garment swatch (see
 * generate-garment-texture.ts) into the Roblox shirt/pants template's FRONT
 * panel, with the rest of the canvas filled in the garment's real base colour
 * so sleeves/back/sides read as the same fabric instead of jarring white.
 *
 * Coordinates below were measured directly from Roblox's own labelled
 * template diagrams (Template-Shirts-R15.png / Template-Pants-R15.png) by
 * scanning pixel colours for the FRONT block's red fill, not guessed:
 * 585x559 canvas, FRONT torso/waist panel at x:231-358, y:74-201.
 */
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";

const CANVAS = { width: 585, height: 559 };
const FRONT_RECT = { x: 231, y: 74, width: 127, height: 127 };

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").trim();
  const value = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean.padEnd(6, "0").slice(0, 6);
  const num = parseInt(value, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export async function composeGarment(
  swatchImagePath: string,
  outPath: string,
  baseColorHex: string,
): Promise<void> {
  const { r, g, b } = hexToRgb(baseColorHex);

  const base = sharp({
    create: {
      width: CANVAS.width,
      height: CANVAS.height,
      channels: 3,
      background: { r, g, b },
    },
  });

  const frontCrop = await sharp(swatchImagePath)
    .resize(FRONT_RECT.width, FRONT_RECT.height, { fit: "cover" })
    .toBuffer();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await base
    .composite([{ input: frontCrop, left: FRONT_RECT.x, top: FRONT_RECT.y }])
    .png()
    .toFile(outPath);
}

// CLI: npx tsx compose-garment.ts <swatchImage> <outPath> <baseColorHex>
if (process.argv[1] && process.argv[1].endsWith("compose-garment.ts")) {
  const [, , input, output, hex] = process.argv;
  if (!input || !output || !hex) {
    console.error("usage: compose-garment.ts <swatchImage> <outPath> <baseColorHex>");
    process.exit(1);
  }
  composeGarment(input, output, hex).then(() => console.log(`[compose] wrote ${output}`));
}
