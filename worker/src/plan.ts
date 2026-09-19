import type { Env } from "./env";

/**
 * The planning half of the agent, running at the edge.
 *
 * The dashboard sends a pre-built context (store layout plus metrics) rather
 * than the Worker reaching back through the tunnel for it, so nothing here
 * depends on the local backend being reachable from the internet.
 *
 * Validation is hand-rolled instead of pulling in a schema library: the Worker
 * has no dependencies today and this is a fixed, small set of operations.
 */

const MODEL = "gpt-5.4";
const MAX_OPS = 5;
const MAX_CTA = 40;
const MAX_SIGNAGE = 60;

export const OP_NAMES = [
  "move_to_slot",
  "set_kind",
  "set_prominence",
  "enable_interaction",
  "disable_interaction",
  "set_cta_text",
  "set_signage",
  "swap_products",
] as const;

export type Op = {
  op: string;
  componentId: string | null;
  slotId: string | null;
  kind: string | null;
  level: number | null;
  text: string | null;
  componentIdA: string | null;
  componentIdB: string | null;
};

export type Plan = {
  hypothesis: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  expectedEffect: string;
  ops: Op[];
};

const SYSTEM_PROMPT = `You are a retail merchandising analyst for a Roblox storefront that sells real Shopify products.

You are given the store layout, what is currently on display, and behavioural metrics gathered from players walking around the space.

The funnel is: impression -> approach -> gaze -> interact -> panel open -> CTA click -> purchase.
Each drop-off points at a different fix:
- Few impressions: the display is not being seen. Placement or sightline. Use move_to_slot toward a lower trafficRank number (1 is the busiest corridor), and check visibilityScore before choosing a destination.
- Impressions but few approaches: it does not read as interesting from a distance. Use set_prominence or set_kind.
- Approaches but little gaze: it is facing the wrong way. move_to_slot snaps to the slot's facing.
- Gaze but no interaction: no visible affordance. Use enable_interaction or set_cta_text.
- Interaction but little panel time: the panel content is weak. Say so as a merchandising note; do not try to fix it with layout.
- Panel time but no CTA: price or product mismatch. Say so; do not guess at a layout fix.

RULES YOU MUST FOLLOW:
1. Describe observed patterns, never proven causes.
2. Never promise a percentage improvement. expectedEffect names which funnel stage you expect to move and in which direction, nothing more.
3. Only use componentId and slotId values that appear in the data you were given. Never invent one.
4. If a component has very few impressions, say plainly that there is not enough data to judge its later funnel stages, and fix the exposure problem first.
5. At most 5 operations. Prefer the smallest change that tests one idea.
6. Do not target the same component with two operations that contradict each other.`;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hypothesis", "evidence", "confidence", "expectedEffect", "ops"],
  properties: {
    hypothesis: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    expectedEffect: { type: "string" },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "op",
          "componentId",
          "slotId",
          "kind",
          "level",
          "text",
          "componentIdA",
          "componentIdB",
        ],
        properties: {
          op: { type: "string", enum: [...OP_NAMES] },
          componentId: { type: ["string", "null"] },
          slotId: { type: ["string", "null"] },
          kind: { type: ["string", "null"] },
          level: { type: ["number", "null"] },
          text: { type: ["string", "null"] },
          componentIdA: { type: ["string", "null"] },
          componentIdB: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export async function proposePlan(
  env: Env,
  context: unknown,
): Promise<{ ok: true; plan: Plan; model: string } | { ok: false; error: string; raw?: string }> {
  if (!env.OPENAI_API_KEY) return { ok: false, error: "OPENAI_API_KEY is not bound" };

  let raw: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
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
          json_schema: { name: "change_plan", strict: true, schema: PLAN_SCHEMA },
        },
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    raw = body.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!raw) return { ok: false, error: "model returned an empty response" };

  let parsed: Plan;
  try {
    parsed = JSON.parse(raw) as Plan;
  } catch {
    return { ok: false, error: "model response was not valid JSON", raw };
  }

  if (!parsed.hypothesis || !Array.isArray(parsed.ops)) {
    return { ok: false, error: "plan is missing required fields", raw };
  }
  return { ok: true, plan: parsed, model: MODEL };
}

export type Rejection = { op: Record<string, unknown>; reason: string };
export type Validation = {
  ok: boolean;
  accepted: Record<string, unknown>[];
  rejected: Rejection[];
  planErrors: string[];
};

const BANNED = ["http://", "https://", "www.", "<", ">"];

function compact(op: Op): Record<string, unknown> {
  const out: Record<string, unknown> = { op: op.op };
  for (const [key, value] of Object.entries(op)) {
    if (key !== "op" && value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** Nothing reaches Roblox without passing this. */
export function validatePlan(
  plan: Plan,
  registry: { components: { componentId: string }[]; slots: { slotId: string }[]; kinds: string[] },
): Validation {
  const componentIds = new Set(registry.components.map((c) => c.componentId));
  const slotIds = new Set(registry.slots.map((s) => s.slotId));
  const kinds = new Set(registry.kinds ?? []);

  const accepted: Record<string, unknown>[] = [];
  const rejected: Rejection[] = [];
  const planErrors: string[] = [];
  const intents = new Set<string>();

  if (plan.ops.length === 0) planErrors.push("plan contains no operations");
  if (plan.ops.length > MAX_OPS) {
    planErrors.push(`plan has ${plan.ops.length} operations, cap is ${MAX_OPS}`);
  }

  for (const op of plan.ops) {
    const shape = compact(op);
    const reject = (reason: string) => rejected.push({ op: shape, reason });

    const targets = op.op === "swap_products" ? [op.componentIdA, op.componentIdB] : [op.componentId];
    if (targets.some((t) => !t)) {
      reject("operation is missing its target componentId");
      continue;
    }
    const unknown = targets.find((t) => t && !componentIds.has(t));
    if (unknown) {
      reject(`componentId "${unknown}" is not in the live registry`);
      continue;
    }

    if (op.op === "move_to_slot" && (!op.slotId || !slotIds.has(op.slotId))) {
      reject(`slotId "${op.slotId}" is not in the live registry`);
      continue;
    }
    if (op.op === "set_kind" && (!op.kind || !kinds.has(op.kind))) {
      reject(`kind "${op.kind}" is not in the component library`);
      continue;
    }
    if (op.op === "set_prominence" && ![1, 2, 3].includes(op.level ?? 0)) {
      reject(`prominence level ${op.level} is outside 1-3`);
      continue;
    }
    if (op.op === "set_cta_text" || op.op === "set_signage") {
      const text = op.text ?? "";
      const cap = op.op === "set_cta_text" ? MAX_CTA : MAX_SIGNAGE;
      if (text.length > cap) {
        reject(`text is ${text.length} characters, cap is ${cap}`);
        continue;
      }
      const banned = BANNED.find((b) => text.toLowerCase().includes(b));
      if (banned) {
        reject(`text contains "${banned}", which we do not put on screen`);
        continue;
      }
    }

    // "Move it somewhere better" and "hide it" in one plan is not an experiment.
    const intent =
      op.op === "move_to_slot"
        ? "placement"
        : op.op === "set_prominence"
          ? "prominence"
          : op.op === "enable_interaction" || op.op === "disable_interaction"
            ? "interaction"
            : null;

    if (intent) {
      const keys = targets.map((t) => `${t}:${intent}`);
      const clash = keys.find((k) => intents.has(k));
      if (clash) {
        reject(`conflicts with an earlier ${intent} change to the same component in this plan`);
        continue;
      }
      keys.forEach((k) => intents.add(k));
    }

    accepted.push(shape);
  }

  return { ok: rejected.length === 0 && planErrors.length === 0, accepted, rejected, planErrors };
}
