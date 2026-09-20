/**
 * Replaces "crop the raw Shopify photo into the template" with a proper
 * two-step AI pipeline:
 *
 *  1. A vision call reasons over the actual product photo and writes a short
 *     brief: base fabric colour, any stripe/colour-block pattern, and the
 *     printed graphic/text, ignoring the white studio background and the
 *     garment's photographed silhouette (sleeves, collar, wrinkles).
 *  2. An image-generation call turns that brief into a flat, edge-to-edge
 *     fabric swatch -- a texture sample, not a photo of a folded shirt --
 *     which compose-garment.ts then drops into the template's FRONT panel.
 *
 * This is what actually fixes "it's just the product photo shrunk onto the
 * shirt": the old pipeline composited the photographed garment shape itself;
 * this one composites a swatch built to look like fabric filling the frame.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { composeGarment } from "./compose-garment.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env.local"), quiet: true });

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey) {
  console.error("[garment-texture] OPENAI_API_KEY missing from .env.local");
  process.exit(1);
}
const client = new OpenAI({ apiKey });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";

type GarmentBrief = {
  baseColorHex: string;
  pattern: string;
  graphic: string;
  garmentType: string;
};

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    baseColorHex: {
      type: "string",
      description: "Dominant fabric colour as a 6-digit hex code, ignoring the white studio background",
    },
    pattern: {
      type: "string",
      description: "Any stripe or colour-blocking pattern on the fabric itself, or 'solid' if there is none",
    },
    graphic: {
      type: "string",
      description: "The printed text and/or logo on the garment, transcribed verbatim with a short description of its look, or 'none' if the garment is blank",
    },
    garmentType: {
      type: "string",
      description: "Short garment description, e.g. 'rugby shirt', 'crewneck sweatshirt', 'sweatpants'",
    },
  },
  required: ["baseColorHex", "pattern", "graphic", "garmentType"],
  additionalProperties: false,
};

async function describeGarment(imagePath: string): Promise<GarmentBrief> {
  const b64 = fs.readFileSync(imagePath).toString("base64");
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are briefing a texture artist who will redraw this garment as a flat fabric swatch. Report only the fabric's own colour and print, never the studio background or the way the garment is folded/laid out.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this garment for the texture artist." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ] as never,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "garment_brief", strict: true, schema: BRIEF_SCHEMA },
    },
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  if (!raw) throw new Error("vision step returned an empty response");
  return JSON.parse(raw) as GarmentBrief;
}

async function generateSwatch(brief: GarmentBrief): Promise<Buffer> {
  const prompt = `Macro close-up photograph of fabric, as if the camera lens is pressed almost flat against the material. The colour and pattern must extend to all four edges of the frame with zero negative space -- like a seamless texture tile or a swatch cut from a fabric bolt.

Absolutely do NOT draw: a shirt, a collar, a placket, sleeves, a garment outline or silhouette of any kind, a hanger, a mannequin, folds, wrinkles, shadows, or any background. If the description below mentions a garment feature like a collar, ignore that word and only render the coloured fabric and any printed graphic -- never the shape of the garment.

Garment type (for colour/print reference only, do not draw its shape): ${brief.garmentType}.
Base fabric colour, must fill any area with no print: ${brief.baseColorHex}.
Colour pattern across the fabric (render as flat horizontal bands/blocks filling the frame, not as a shirt shape): ${brief.pattern}.
Printed graphic, centered in the frame, reproduced exactly and kept legible: ${brief.graphic}.
Any text must be rendered perfectly horizontal, left-to-right, upright and legible -- never sideways or rotated, even if the description mentions it running vertically down a leg or sleeve; lay it out horizontally instead.
Lighting: even, flat, no perspective distortion.`;

  const result = await client.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024",
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("image generation returned no data");
  return Buffer.from(b64, "base64");
}

export async function generateGarmentTexture(
  productImagePath: string,
  outPath: string,
): Promise<GarmentBrief> {
  const brief = await describeGarment(productImagePath);
  console.log(`[garment-texture] ${path.basename(productImagePath)} brief:`, brief);

  const swatch = await generateSwatch(brief);
  const swatchPath = outPath.replace(/\.png$/, ".swatch.png");
  fs.mkdirSync(path.dirname(swatchPath), { recursive: true });
  fs.writeFileSync(swatchPath, swatch);

  await composeGarment(swatchPath, outPath, brief.baseColorHex);
  return brief;
}

// CLI: npx tsx generate-garment-texture.ts <productImage> <outPath>
if (process.argv[1] && process.argv[1].endsWith("generate-garment-texture.ts")) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error("usage: generate-garment-texture.ts <productImage> <outPath>");
    process.exit(1);
  }
  generateGarmentTexture(input, output).then((brief) =>
    console.log(`[garment-texture] wrote ${output}`, brief),
  );
}
