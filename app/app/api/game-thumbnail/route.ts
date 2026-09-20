export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Roblox's icon thumbnail endpoint is public and needs no auth token. */
export async function GET(request: Request) {
  const universeId = new URL(request.url).searchParams.get("universeId");
  if (!universeId) return Response.json({ error: "universeId required" }, { status: 400 });

  const res = await fetch(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${encodeURIComponent(universeId)}&size=150x150&format=Png&isCircular=false`,
    { cache: "no-store" },
  );
  if (!res.ok) return Response.json({ error: `thumbnail API HTTP ${res.status}` }, { status: 502 });

  const body = (await res.json()) as { data?: { imageUrl?: string }[] };
  return Response.json({ imageUrl: body.data?.[0]?.imageUrl ?? null });
}
