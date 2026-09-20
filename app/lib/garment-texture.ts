import OpenAI from "openai";
import sharp from "sharp";
import { env } from "@/lib/env";

/**
 * Server-side (Node runtime) port of bridge/generate-garment-texture.ts, for
 * the automated Create Storefront flow. Kept separate from the bridge/
 * script rather than imported across the project boundary: bridge/ is a
 * standalone tsx-run CLI tool with its own tsconfig, and this file leans on
 * this app's own "@/lib/env" -- cross-project imports here would be more
 * fragile than the small amount of duplication.
 *
 * Same two-step pipeline, same reasoning as the CLI version: a vision call
 * reasons about the actual garment (colour, pattern, graphic), then
 * `gpt-image-1` turns that into a flat fabric swatch, which gets composited
 * deterministically into the Roblox shirt/pants template's FRONT panel.
 */

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";
const CANVAS = { width: 585, height: 559 };
const FRONT_RECT = { x: 231, y: 74, width: 127, height: 127 };

type GarmentBrief = {
  baseColorHex: string;
  pattern: string;
  graphic: string;
  garmentType: string;
};

const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["baseColorHex", "pattern", "graphic", "garmentType"],
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
} as const;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").trim();
  const value = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0").slice(0, 6);
  const num = parseInt(value, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

async function describeGarment(client: OpenAI, imageBuffer: Buffer): Promise<GarmentBrief> {
  const b64 = imageBuffer.toString("base64");
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

async function generateSwatch(client: OpenAI, brief: GarmentBrief): Promise<Buffer> {
  const prompt = `Macro close-up photograph of fabric, as if the camera lens is pressed almost flat against the material. The colour and pattern must extend to all four edges of the frame with zero negative space -- like a seamless texture tile or a swatch cut from a fabric bolt.

Absolutely do NOT draw: a shirt, a collar, a placket, sleeves, a garment outline or silhouette of any kind, a hanger, a mannequin, folds, wrinkles, shadows, or any background. If the description below mentions a garment feature like a collar, ignore that word and only render the coloured fabric and any printed graphic -- never the shape of the garment.

Garment type (for colour/print reference only, do not draw its shape): ${brief.garmentType}.
Base fabric colour, must fill any area with no print: ${brief.baseColorHex}.
Colour pattern across the fabric (render as flat horizontal bands/blocks filling the frame, not as a shirt shape): ${brief.pattern}.
Printed graphic, centered in the frame, reproduced exactly and kept legible: ${brief.graphic}.
Any text must be rendered perfectly horizontal, left-to-right, upright and legible -- never sideways or rotated, even if the description mentions it running vertically down a leg or sleeve; lay it out horizontally instead.
Lighting: even, flat, no perspective distortion.`;

  const result = await client.images.generate({ model: "gpt-image-1", prompt, size: "1024x1024" });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("image generation returned no data");
  return Buffer.from(b64, "base64");
}

export async function composeGarmentTexture(
  productImageBuffer: Buffer,
): Promise<{ buffer: Buffer; brief: GarmentBrief }> {
  if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
  const client = new OpenAI({ apiKey: env.openaiApiKey });

  const brief = await describeGarment(client, productImageBuffer);
  const swatch = await generateSwatch(client, brief);

  const { r, g, b } = hexToRgb(brief.baseColorHex);
  const base = sharp({
    create: { width: CANVAS.width, height: CANVAS.height, channels: 3, background: { r, g, b } },
  });
  const frontCrop = await sharp(swatch)
    .resize(FRONT_RECT.width, FRONT_RECT.height, { fit: "cover" })
    .toBuffer();

  const buffer = await base
    .composite([{ input: frontCrop, left: FRONT_RECT.x, top: FRONT_RECT.y }])
    .png()
    .toBuffer();

  return { buffer, brief };
}

/** Re-encodes a fetched product photo to PNG for a consistent upload format. */
export async function normalizeProductImage(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer).png().toBuffer();
}

export async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch image ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
