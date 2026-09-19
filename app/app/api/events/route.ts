import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const vec3 = z.array(z.number()).length(3);

// Luau encodes an empty table as [], not {}, so an event carrying no metadata
// arrives as an array. Accept it and normalise rather than rejecting.
const metaSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .transform((value) => (Array.isArray(value) ? {} : value));

const eventSchema = z.object({
  t: z.number(),
  type: z.string().min(1).max(64),
  surface: z.enum(["physical", "gui"]).optional(),
  componentId: z.string().max(128).optional(),
  productId: z.string().max(128).optional(),
  pos: vec3.optional(),
  look: vec3.optional(),
  meta: metaSchema.optional(),
});

const envelopeSchema = z.object({
  sessionId: z.string().min(1).max(64),
  placeVersion: z.number().optional(),
  experimentId: z.string().max(64).optional(),
  source: z.enum(["live", "sim"]).optional(),
  events: z.array(z.unknown()).max(500),
});

// A client can lie about how long it looked at something. Clamp so one bad
// message cannot wreck the averages mid-demo.
const SECONDS_CAPS: Record<string, number> = {
  gazeSeconds: 300,
  dwellSeconds: 600,
  openSeconds: 600,
  activeSeconds: 600,
  holdSeconds: 30,
};
const DISTANCE_CAPS: Record<string, number> = {
  distance: 500,
  minDistance: 500,
  avgDistance: 500,
};

function clampMeta(meta: Record<string, unknown> | undefined) {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const cap = SECONDS_CAPS[key] ?? DISTANCE_CAPS[key];
      out[key] = cap === undefined ? value : Math.min(Math.max(value, 0), cap);
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    console.error("[events] rejected envelope:", JSON.stringify(parsed.error.issues).slice(0, 500));
    return Response.json({ error: "invalid envelope", issues: parsed.error.issues }, { status: 400 });
  }

  const { sessionId, placeVersion, experimentId } = parsed.data;
  const source = parsed.data.source ?? "live";

  // Validate per event. One malformed event must never discard the batch it
  // travelled in — that silently loses everything a player just did.
  const events: z.infer<typeof eventSchema>[] = [];
  const rejected: { index: number; reason: string }[] = [];
  parsed.data.events.forEach((raw, index) => {
    const event = eventSchema.safeParse(raw);
    if (event.success) events.push(event.data);
    else rejected.push({ index, reason: event.error.issues.map((i) => i.message).join("; ") });
  });

  if (rejected.length > 0) {
    console.error(`[events] dropped ${rejected.length} malformed event(s):`, JSON.stringify(rejected).slice(0, 400));
  }
  if (events.length === 0) {
    return Response.json({ ok: false, accepted: 0, rejected }, { status: 400 });
  }

  const handle = db();

  const upsertSession = handle.prepare(`
    INSERT INTO sessions (id, started_at, experiment_id, place_version, source)
    VALUES (@id, @startedAt, @experimentId, @placeVersion, @source)
    ON CONFLICT(id) DO UPDATE SET
      experiment_id = COALESCE(excluded.experiment_id, sessions.experiment_id),
      place_version = COALESCE(excluded.place_version, sessions.place_version)
  `);

  const endSession = handle.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`);

  const insertEvent = handle.prepare(`
    INSERT INTO events (session_id, ts, type, surface, component_id, product_id,
                        x, y, z, lx, ly, lz, meta_json, experiment_id, source)
    VALUES (@sessionId, @ts, @type, @surface, @componentId, @productId,
            @x, @y, @z, @lx, @ly, @lz, @metaJson, @experimentId, @source)
  `);

  const earliest = events.reduce((min, e) => Math.min(min, e.t), Number.POSITIVE_INFINITY);

  const write = handle.transaction(() => {
    upsertSession.run({
      id: sessionId,
      startedAt: Number.isFinite(earliest) ? earliest : Date.now() / 1000,
      experimentId: experimentId ?? null,
      placeVersion: placeVersion ?? null,
      source,
    });

    for (const event of events) {
      insertEvent.run({
        sessionId,
        ts: event.t,
        type: event.type,
        surface: event.surface ?? null,
        componentId: event.componentId ?? null,
        productId: event.productId ?? null,
        x: event.pos?.[0] ?? null,
        y: event.pos?.[1] ?? null,
        z: event.pos?.[2] ?? null,
        lx: event.look?.[0] ?? null,
        ly: event.look?.[1] ?? null,
        lz: event.look?.[2] ?? null,
        metaJson: clampMeta(event.meta),
        experimentId: experimentId ?? null,
        source,
      });
      if (event.type === "session_ended") endSession.run(event.t, sessionId);
    }
  });

  try {
    write();
  } catch (error) {
    console.error("[events] write failed:", error);
    return Response.json({ error: "write failed" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    accepted: events.length,
    ...(rejected.length > 0 ? { rejected } : {}),
  });
}
