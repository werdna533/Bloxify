import type { Env } from "./env";

/**
 * Telemetry ingest on D1, ported from app/api/events/route.ts. Hand-rolled
 * validation instead of zod, matching plan.ts: this Worker has no
 * dependencies and the shape here is small and fixed.
 */

type Vec3 = [number, number, number];
type ParsedEvent = {
  t: number;
  type: string;
  surface?: "physical" | "gui";
  componentId?: string;
  productId?: string;
  pos?: Vec3;
  look?: Vec3;
  meta?: Record<string, unknown>;
};
type Envelope = {
  sessionId: string;
  placeVersion?: number;
  experimentId?: string;
  source?: "live" | "sim";
  events: unknown[];
};

const SECONDS_CAPS: Record<string, number> = {
  gazeSeconds: 300,
  dwellSeconds: 600,
  openSeconds: 600,
  activeSeconds: 600,
  holdSeconds: 30,
};
const DISTANCE_CAPS: Record<string, number> = { distance: 500, minDistance: 500, avgDistance: 500 };

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");
}

// Luau encodes an empty table as [], not {}, so an event with no metadata
// arrives as an array. Accept it and normalise to {} rather than rejecting.
function parseMeta(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return {};
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

function parseEvent(raw: unknown, index: number): { event?: ParsedEvent; error?: string } {
  if (!raw || typeof raw !== "object") return { error: `event ${index}: not an object` };
  const r = raw as Record<string, unknown>;
  if (typeof r.t !== "number") return { error: `event ${index}: t must be a number` };
  if (typeof r.type !== "string" || r.type.length === 0 || r.type.length > 64) {
    return { error: `event ${index}: type must be a non-empty string up to 64 chars` };
  }
  const event: ParsedEvent = { t: r.t, type: r.type };
  if (r.surface === "physical" || r.surface === "gui") event.surface = r.surface;
  if (typeof r.componentId === "string" && r.componentId.length <= 128) event.componentId = r.componentId;
  if (typeof r.productId === "string" && r.productId.length <= 128) event.productId = r.productId;
  if (isVec3(r.pos)) event.pos = r.pos;
  if (isVec3(r.look)) event.look = r.look;
  const meta = parseMeta(r.meta);
  if (meta) event.meta = meta;
  return { event };
}

function clampMeta(meta: Record<string, unknown> | undefined): string | null {
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

function parseEnvelope(raw: unknown): Envelope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || r.sessionId.length === 0 || r.sessionId.length > 64) return null;
  if (!Array.isArray(r.events) || r.events.length > 500) return null;
  return {
    sessionId: r.sessionId,
    placeVersion: typeof r.placeVersion === "number" ? r.placeVersion : undefined,
    experimentId: typeof r.experimentId === "string" ? r.experimentId : undefined,
    source: r.source === "live" || r.source === "sim" ? r.source : undefined,
    events: r.events,
  };
}

/**
 * A busy live server has many players flushing at once. One request per
 * player would blow through HttpService's per-server request budget, so the
 * game packs every session's events into a single request; a lone envelope
 * (the simulator, or a single-player playtest) is accepted the same way.
 */
export async function ingestEvents(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const envelopes: Envelope[] = [];
  const asBatch = body as { batch?: unknown };
  if (Array.isArray(asBatch?.batch)) {
    for (const raw of asBatch.batch) {
      const env_ = parseEnvelope(raw);
      if (env_) envelopes.push(env_);
    }
    if (envelopes.length === 0) return Response.json({ error: "invalid batch" }, { status: 400 });
  } else {
    const single = parseEnvelope(body);
    if (!single) return Response.json({ error: "invalid envelope" }, { status: 400 });
    envelopes.push(single);
  }

  const statements: D1PreparedStatement[] = [];
  const rejected: { session: string; index: number; reason: string }[] = [];
  let accepted = 0;

  for (const envelope of envelopes) {
    const source = envelope.source ?? "live";
    const events: ParsedEvent[] = [];
    envelope.events.forEach((raw, index) => {
      const { event, error } = parseEvent(raw, index);
      if (event) events.push(event);
      else rejected.push({ session: envelope.sessionId, index, reason: error ?? "invalid" });
    });
    if (events.length === 0) continue;

    const earliest = events.reduce((min, e) => Math.min(min, e.t), Number.POSITIVE_INFINITY);
    statements.push(
      env.DB.prepare(
        `INSERT INTO sessions (id, started_at, experiment_id, place_version, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           experiment_id = COALESCE(excluded.experiment_id, sessions.experiment_id),
           place_version = COALESCE(excluded.place_version, sessions.place_version)`,
      ).bind(
        envelope.sessionId,
        Number.isFinite(earliest) ? earliest : Date.now() / 1000,
        envelope.experimentId ?? null,
        envelope.placeVersion ?? null,
        source,
      ),
    );

    for (const event of events) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO events (session_id, ts, type, surface, component_id, product_id,
                              x, y, z, lx, ly, lz, meta_json, experiment_id, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          envelope.sessionId,
          event.t,
          event.type,
          event.surface ?? null,
          event.componentId ?? null,
          event.productId ?? null,
          event.pos?.[0] ?? null,
          event.pos?.[1] ?? null,
          event.pos?.[2] ?? null,
          event.look?.[0] ?? null,
          event.look?.[1] ?? null,
          event.look?.[2] ?? null,
          clampMeta(event.meta),
          envelope.experimentId ?? null,
          source,
        ),
      );
      if (event.type === "session_ended") {
        statements.push(
          env.DB.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).bind(event.t, envelope.sessionId),
        );
      }
    }
    accepted += events.length;
  }

  if (statements.length > 0) {
    try {
      await env.DB.batch(statements);
    } catch (error) {
      return Response.json(
        { error: `write failed: ${error instanceof Error ? error.message : String(error)}` },
        { status: 500 },
      );
    }
  }

  if (accepted === 0) return Response.json({ ok: false, accepted: 0, rejected }, { status: 400 });
  return Response.json({
    ok: true,
    accepted,
    sessions: envelopes.length,
    ...(rejected.length > 0 ? { rejected } : {}),
  });
}
