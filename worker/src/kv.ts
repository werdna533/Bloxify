import type { Env } from "./env";

/** registry.json and geometry.json, ported from the local `kv` table to D1. */

export async function readKv(env: Env, key: string): Promise<unknown | null> {
  const row = await env.DB.prepare(`SELECT value FROM kv WHERE key = ?`).bind(key).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

export async function writeKv(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, JSON.stringify(value), Date.now() / 1000)
    .run();
}

export async function getRegistry(request: Request, env: Env): Promise<Response> {
  const registry = await readKv(env, "registry");
  if (!registry) return Response.json({ error: "no registry yet" }, { status: 404 });
  return Response.json(registry);
}

export async function postRegistry(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { slots?: unknown[]; components?: unknown[] };
  if (!Array.isArray(body?.slots) || !Array.isArray(body?.components)) {
    return Response.json({ error: "expected { slots, components }" }, { status: 400 });
  }
  await writeKv(env, "registry", body);
  return Response.json({ ok: true, slots: body.slots.length, components: body.components.length });
}

export async function getGeometry(request: Request, env: Env): Promise<Response> {
  const geometry = await readKv(env, "geometry");
  if (!geometry) return Response.json({ error: "no geometry yet" }, { status: 404 });
  return Response.json(geometry);
}

export async function postGeometry(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { boxes?: unknown[] };
  if (!Array.isArray(body?.boxes)) {
    return Response.json({ error: "expected { boxes }" }, { status: 400 });
  }
  await writeKv(env, "geometry", body);
  return Response.json({ ok: true, boxes: body.boxes.length });
}
