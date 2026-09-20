import { z } from "zod";

export const MAX_OPS = 5;
export const MAX_CTA = 40;
export const MAX_SIGNAGE = 60;

export const OP_NAMES = [
  "move_to_position",
  "set_kind",
  "set_prominence",
  "enable_interaction",
  "disable_interaction",
  "set_cta_text",
  "set_signage",
  "swap_products",
] as const;

/**
 * Flat op shape on purpose. OpenAI strict structured output requires every
 * declared property to be required, so unused fields come back as null rather
 * than being absent, and the refinement below enforces the real per-op rules.
 */
export const opSchema = z
  .object({
    op: z.enum(OP_NAMES),
    componentId: z.string().nullable(),
    x: z.number().nullable(),
    z: z.number().nullable(),
    facingDegrees: z.number().nullable(),
    kind: z.string().nullable(),
    level: z.number().nullable(),
    text: z.string().nullable(),
    componentIdA: z.string().nullable(),
    componentIdB: z.string().nullable(),
  })
  .superRefine((op, ctx) => {
    const needsComponent = op.op !== "swap_products";
    if (needsComponent && !op.componentId) {
      ctx.addIssue({ code: "custom", message: `${op.op} requires componentId` });
    }
    if (op.op === "move_to_position" && (op.x === null || op.z === null)) {
      ctx.addIssue({ code: "custom", message: "move_to_position requires x and z" });
    }
    if (op.op === "set_kind" && !op.kind) {
      ctx.addIssue({ code: "custom", message: "set_kind requires kind" });
    }
    if (op.op === "set_prominence" && !(op.level === 1 || op.level === 2 || op.level === 3)) {
      ctx.addIssue({ code: "custom", message: "set_prominence requires level 1, 2 or 3" });
    }
    if (op.op === "set_cta_text") {
      if (!op.text) ctx.addIssue({ code: "custom", message: "set_cta_text requires text" });
      else if (op.text.length > MAX_CTA) {
        ctx.addIssue({ code: "custom", message: `cta text is ${op.text.length} chars, cap is ${MAX_CTA}` });
      }
    }
    if (op.op === "set_signage") {
      if (!op.text) ctx.addIssue({ code: "custom", message: "set_signage requires text" });
      else if (op.text.length > MAX_SIGNAGE) {
        ctx.addIssue({ code: "custom", message: `signage is ${op.text.length} chars, cap is ${MAX_SIGNAGE}` });
      }
    }
    if (op.op === "swap_products" && (!op.componentIdA || !op.componentIdB)) {
      ctx.addIssue({ code: "custom", message: "swap_products requires componentIdA and componentIdB" });
    }
  });

export const planSchema = z.object({
  hypothesis: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  confidence: z.enum(["low", "medium", "high"]),
  expectedEffect: z.string().min(1),
  ops: z.array(opSchema).max(MAX_OPS),
});

export type Op = z.infer<typeof opSchema>;
export type Plan = z.infer<typeof planSchema>;

/** Sent to OpenAI as the response_format json_schema. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hypothesis", "evidence", "confidence", "expectedEffect", "ops"],
  properties: {
    hypothesis: {
      type: "string",
      description: "One sentence naming the observed pattern, not a claimed cause.",
    },
    evidence: {
      type: "array",
      description: "Specific numbers from the metrics that support the hypothesis.",
      items: { type: "string" },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    expectedEffect: {
      type: "string",
      description: "Which funnel stage should move, described as an expectation, not a promise.",
    },
    ops: {
      type: "array",
      description: `At most ${MAX_OPS} operations.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "op",
          "componentId",
          "x",
          "z",
          "facingDegrees",
          "kind",
          "level",
          "text",
          "componentIdA",
          "componentIdB",
        ],
        properties: {
          op: { type: "string", enum: [...OP_NAMES] },
          componentId: { type: ["string", "null"] },
          x: { type: ["number", "null"], description: "Target x coordinate for move_to_position." },
          z: { type: ["number", "null"], description: "Target z coordinate for move_to_position." },
          facingDegrees: {
            type: ["number", "null"],
            description: "Facing angle in degrees for move_to_position, 0-360. Point it back toward the main path.",
          },
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

/** Strips the nulls so the Luau side receives only the keys an op actually uses. */
export function compactOp(op: Op): Record<string, unknown> {
  const out: Record<string, unknown> = { op: op.op };
  for (const [key, value] of Object.entries(op)) {
    if (key !== "op" && value !== null && value !== undefined) out[key] = value;
  }
  return out;
}
