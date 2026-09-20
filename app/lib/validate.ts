import { MAX_OPS, compactOp, type Op, type Plan } from "@/lib/plan-schema";
import type { Registry } from "@/app/api/registry/route";

export type Rejection = { op: Record<string, unknown>; reason: string };
export type ValidationResult = {
  ok: boolean;
  accepted: Record<string, unknown>[];
  rejected: Rejection[];
  planErrors: string[];
};

const BANNED_SUBSTRINGS = ["http://", "https://", "www.", "<", ">"];

/**
 * Nothing reaches Roblox without passing this. The model can only name things
 * that actually exist in the place right now.
 */
export function validatePlan(plan: Plan, registry: Registry): ValidationResult {
  const componentIds = new Set(registry.components.map((c) => c.componentId));
  const kinds = new Set(registry.kinds);

  const accepted: Record<string, unknown>[] = [];
  const rejected: Rejection[] = [];
  const planErrors: string[] = [];

  if (plan.ops.length === 0) planErrors.push("plan contains no operations");
  if (plan.ops.length > MAX_OPS) {
    planErrors.push(`plan has ${plan.ops.length} operations, cap is ${MAX_OPS}`);
  }

  // "Put it somewhere better" and "hide it" in the same plan is not an experiment.
  const intents = new Map<string, string[]>();
  const intentOf = (op: Op): string | null => {
    if (op.op === "enable_interaction" || op.op === "disable_interaction") return "interaction";
    if (op.op === "move_to_position") return "placement";
    if (op.op === "set_prominence") return "prominence";
    return null;
  };

  for (const op of plan.ops) {
    const compact = compactOp(op);
    const reject = (reason: string) => rejected.push({ op: compact, reason });

    const targets = op.op === "swap_products" ? [op.componentIdA, op.componentIdB] : [op.componentId];
    const unknownTarget = targets.find((id) => id && !componentIds.has(id));
    if (unknownTarget) {
      reject(`componentId "${unknownTarget}" is not in the live registry`);
      continue;
    }
    if (targets.some((id) => !id)) {
      reject("operation is missing its target componentId");
      continue;
    }

    if (op.op === "move_to_position") {
      if (typeof op.x !== "number" || typeof op.z !== "number" || !Number.isFinite(op.x) || !Number.isFinite(op.z)) {
        reject("x and z must be finite numbers");
        continue;
      }
      const facing = op.facingDegrees ?? 0;
      if (!Number.isFinite(facing) || facing < 0 || facing > 360) {
        reject(`facingDegrees ${facing} is outside 0-360`);
        continue;
      }
      if (registry.region) {
        const [cx, cz] = registry.region.center;
        const [sx, sz] = registry.region.size;
        const rad = (-registry.region.rotationY * Math.PI) / 180;
        const dx = op.x - cx;
        const dz = op.z - cz;
        const localX = dx * Math.cos(rad) - dz * Math.sin(rad);
        const localZ = dx * Math.sin(rad) + dz * Math.cos(rad);
        if (Math.abs(localX) > sx / 2 || Math.abs(localZ) > sz / 2) {
          reject(`(${op.x}, ${op.z}) is outside the storefront region`);
          continue;
        }
      }
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
      const cap = op.op === "set_cta_text" ? 40 : 60;
      if (text.length > cap) {
        reject(`text is ${text.length} characters, cap is ${cap}`);
        continue;
      }
      const lowered = text.toLowerCase();
      const banned = BANNED_SUBSTRINGS.find((b) => lowered.includes(b));
      if (banned) {
        reject(`text contains "${banned}", which we do not put on screen`);
        continue;
      }
    }

    const intent = intentOf(op);
    let conflicted = false;
    if (intent) {
      for (const id of targets) {
        const key = `${id}:${intent}`;
        if (intents.has(key)) {
          reject(`conflicts with an earlier ${intent} change to ${id} in the same plan`);
          conflicted = true;
          break;
        }
      }
      if (!conflicted) {
        for (const id of targets) intents.set(`${id}:${intent}`, [op.op]);
      }
    }
    if (conflicted) continue;

    accepted.push(compact);
  }

  return { ok: rejected.length === 0 && planErrors.length === 0, accepted, rejected, planErrors };
}
