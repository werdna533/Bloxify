import type { Env } from "./env";

/**
 * The reasoning half of "Create Storefront": given a fetched Shopify catalog
 * and the room's own geometry, decide what kind of display each product gets
 * and where it goes. Follows the same split as the rest of this project --
 * judgment goes through the LLM (product classification), geometry math does
 * not (compose-garment.ts chose deterministic pixel math over an AI image
 * edit for the identical reason: coordinates and collisions are not
 * something to ask a language model to get right).
 */

const MODEL = "gpt-5.4";
const KINDS = ["Mannequin", "PlushStand", "ProductStand", "ProductWall"] as const;

export type ProductInput = {
  productId: string;
  title: string;
  price: number;
  imageUrl: string | null;
};

export type Classification = {
  productId: string;
  kind: (typeof KINDS)[number];
  garmentOnLegs: boolean;
};

export type Region = { center: number[]; size: number[]; rotationY: number; floorY: number };
export type Placement = { x: number; z: number; facingDegrees: number };

export type StorefrontJobItem = {
  componentId: string;
  productId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  kind: string;
  garmentOnLegs: boolean;
  x: number;
  z: number;
  facingDegrees: number;
  // Filled in by the Next.js backend after this job comes back from
  // /storefront/create, before it's queued via /storefront/queue -- a
  // Worker can't run `sharp` or do the Open Cloud upload itself.
  imageAssetId?: string | null;
  shirtTemplateId?: string | null;
  pantsTemplateId?: string | null;
};

const CLASSIFY_PROMPT = `You are classifying Shopify products into physical Roblox storefront display types.

Kinds available: ${KINDS.join(", ")}.
- "Mannequin": wearable clothing (shirts, sweaters, jackets, pants, shorts). Set garmentOnLegs true only for a bottom-half garment (pants, shorts, skirts); false for anything worn on the torso.
- "PlushStand": a plush toy, stuffed animal, or similarly soft single-object collectible.
- "ProductStand": a small standalone product that isn't clothing or a plush (a mug, a bottle, a keychain, etc.).
- "ProductWall": anything better shown as a flat poster/graphic than a 3D object (stickers, art prints, gift cards).

Classify strictly from the product title (price is a weak secondary signal); do not invent details the title doesn't imply.`;

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classifications"],
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "kind", "garmentOnLegs"],
        properties: {
          productId: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          garmentOnLegs: { type: "boolean" },
        },
      },
    },
  },
} as const;

export async function classifyProducts(
  env: Env,
  products: ProductInput[],
): Promise<{ ok: true; classifications: Classification[] } | { ok: false; error: string }> {
  if (!env.OPENAI_API_KEY) return { ok: false, error: "OPENAI_API_KEY is not bound" };
  if (products.length === 0) return { ok: true, classifications: [] };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: CLASSIFY_PROMPT },
          {
            role: "user",
            content: `Classify these products:\n\n${JSON.stringify(
              products.map((p) => ({ productId: p.productId, title: p.title, price: p.price })),
              null,
              2,
            )}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "classifications", strict: true, schema: CLASSIFY_SCHEMA },
        },
      }),
    });
    if (!res.ok) return { ok: false, error: `OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = body.choices?.[0]?.message?.content ?? "";
    if (!raw) return { ok: false, error: "model returned an empty response" };

    const parsed = JSON.parse(raw) as { classifications: Classification[] };
    if (!Array.isArray(parsed.classifications)) {
      return { ok: false, error: "model response missing classifications" };
    }
    return { ok: true, classifications: parsed.classifications };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const LINE_MARGIN = 8; // studs inset from the region edge
const LINE_SPACING_MIN = 8; // studs between adjacent displays
const LINE_SPACING_MAX = 14; // caps spacing so a handful of items don't spread edge-to-edge

function regionToWorld(region: Region, localX: number, localZ: number): [number, number] {
  const rad = (region.rotationY * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [region.center[0] + localX * cos - localZ * sin, region.center[1] + localX * sin + localZ * cos];
}

/**
 * A straight row through the middle of the region, evenly spaced, all facing
 * the same direction -- the region part's own local +Z axis in world space,
 * so rotating the StorefrontRegion part in Studio is what controls which way
 * the row faces (e.g. back toward spawn). Deterministic and simple on
 * purpose: a fresh storefront should be walkable in one pass, not scattered.
 * Roblox's own move_to_position validator (StorefrontAPI.lua) is still the
 * authoritative collision/bounds check when the poller actually builds each
 * one -- this is only ever a starting layout, never trusted blind.
 */
export function layoutComponents(region: Region, count: number): Placement[] {
  if (count === 0) return [];

  const usableWidth = Math.max(0, region.size[0] - 2 * LINE_MARGIN);
  const spacing =
    count > 1 ? Math.min(LINE_SPACING_MAX, Math.max(LINE_SPACING_MIN, usableWidth / (count - 1))) : 0;
  const span = spacing * (count - 1);
  const startLocalX = -span / 2;

  const rad = (region.rotationY * Math.PI) / 180;
  const forwardX = -Math.sin(rad);
  const forwardZ = Math.cos(rad);
  const facingDegrees = ((Math.atan2(forwardZ, forwardX) * 180) / Math.PI + 360) % 360;

  const placements: Placement[] = [];
  for (let i = 0; i < count; i++) {
    const [x, z] = regionToWorld(region, startLocalX + spacing * i, 0);
    placements.push({ x, z, facingDegrees });
  }
  return placements;
}

function slugify(title: string, index: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return base || `item_${index}`;
}

export async function proposeStorefrontLayout(
  env: Env,
  input: { products: ProductInput[]; region: Region },
): Promise<{ ok: true; job: StorefrontJobItem[] } | { ok: false; error: string }> {
  const classified = await classifyProducts(env, input.products);
  if (!classified.ok) return classified;

  const positions = layoutComponents(input.region, input.products.length);

  const classByProduct = new Map(classified.classifications.map((c) => [c.productId, c]));
  const usedIds = new Set<string>();

  const job = input.products.map((product, i) => {
    const cls = classByProduct.get(product.productId);
    const pos = positions[i];

    let componentId = `display_${slugify(product.title, i)}`;
    while (usedIds.has(componentId)) componentId = `${componentId}_${i}`;
    usedIds.add(componentId);

    return {
      componentId,
      productId: product.productId,
      title: product.title,
      price: product.price,
      imageUrl: product.imageUrl,
      kind: cls?.kind ?? "ProductStand",
      garmentOnLegs: cls?.garmentOnLegs ?? false,
      x: pos.x,
      z: pos.z,
      facingDegrees: pos.facingDegrees,
    };
  });

  return { ok: true, job };
}
