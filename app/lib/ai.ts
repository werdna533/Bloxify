import OpenAI from "openai";
import { env } from "@/lib/env";
import { PLAN_JSON_SCHEMA, planSchema, type Plan } from "@/lib/plan-schema";

/**
 * Single provider (OpenAI) by decision, but the call stays behind this wrapper
 * so swapping it is one file rather than a hunt.
 */

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";

const SYSTEM_PROMPT = `You are a retail merchandising analyst for a Roblox storefront that sells real Shopify products.

You are given the store layout, what is currently on display, and behavioural metrics gathered from players walking around the space.

The funnel is: impression -> approach -> gaze -> interact -> panel open -> CTA click -> purchase.
Each drop-off points at a different fix:
- Few impressions: the display is not being seen. Placement or sightline. Use move_to_slot toward a lower trafficRank number (1 is the busiest corridor).
- Impressions but few approaches: it does not read as interesting from a distance. Use set_prominence or set_kind.
- Approaches but little gaze: it is facing the wrong way. move_to_slot snaps to the slot's facing.
- Gaze but no interaction: no visible affordance. Use enable_interaction or set_cta_text.
- Interaction but little panel time: the panel content is weak. Say so as a merchandising note; do not try to fix it with layout.
- Panel time but no CTA: price or product mismatch. Say so; do not guess at a layout fix.

RULES YOU MUST FOLLOW:
1. Describe observed patterns, never proven causes. Write "displays in low-traffic slots received fewer impressions", never "moving this will increase sales by 30%".
2. Never promise a percentage improvement. expectedEffect names which funnel stage you expect to move and in which direction, nothing more.
3. Only use componentId and slotId values that appear in the data you were given. Never invent one.
4. If a component has very few impressions, say plainly that there is not enough data to judge its later funnel stages, and fix the exposure problem first.
5. At most 5 operations. Prefer the smallest change that tests one idea.
6. Do not target the same component with two operations that contradict each other.`;

export type PlanResult =
  | { ok: true; plan: Plan; model: string; raw: string }
  | { ok: false; error: string; raw?: string };

export async function proposePlan(context: unknown): Promise<PlanResult> {
  if (!env.openaiApiKey) {
    return { ok: false, error: "OPENAI_API_KEY is not loaded from .env.local" };
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });

  let raw: string;
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Here is the current store and its measured behaviour. Propose one experiment.\n\n${JSON.stringify(
            context,
            null,
            2,
          )}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "change_plan", strict: true, schema: PLAN_JSON_SCHEMA },
      },
    });
    raw = completion.choices[0]?.message?.content ?? "";
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!raw) return { ok: false, error: "model returned an empty response" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, error: "model response was not valid JSON", raw };
  }

  const parsed = planSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      error: `plan failed schema check: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      raw,
    };
  }

  return { ok: true, plan: parsed.data, model: MODEL, raw };
}
