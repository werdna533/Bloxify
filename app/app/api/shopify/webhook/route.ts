import crypto from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * orders/create. The payload carries the discount codes used, which is how a
 * real purchase gets attributed back to the in-game session that showed the
 * player that code.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get("x-shopify-hmac-sha256") ?? "";

  if (!env.shopifyClientSecret) {
    console.error("[webhook] SHOPIFY_CLIENT_SECRET missing, refusing to trust the payload");
    return Response.json({ error: "server not configured for webhooks" }, { status: 500 });
  }

  const expected = crypto
    .createHmac("sha256", env.shopifyClientSecret)
    .update(raw, "utf8")
    .digest("base64");

  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    console.error("[webhook] HMAC mismatch, rejecting");
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const order = JSON.parse(raw) as {
    id: number;
    total_price?: string;
    discount_codes?: { code: string }[];
    line_items?: { product_id: number; title: string }[];
  };

  const codes = (order.discount_codes ?? []).map((d) => d.code?.toUpperCase()).filter(Boolean);
  const handle = db();

  let sessionId: string | null = null;
  let productId: string | null = null;
  for (const code of codes) {
    const claim = handle
      .prepare(`SELECT session_id, product_id FROM claim_codes WHERE UPPER(code) = ?`)
      .get(code) as { session_id: string; product_id: string } | undefined;
    if (claim) {
      sessionId = claim.session_id;
      productId = claim.product_id;
      break;
    }
  }

  handle
    .prepare(
      `INSERT INTO orders (shopify_order_id, session_id, product_id, total, created_at, discount_code, source)
       VALUES (?, ?, ?, ?, ?, ?, 'live')
       ON CONFLICT(shopify_order_id) DO NOTHING`,
    )
    .run(
      String(order.id),
      sessionId,
      productId ?? (order.line_items?.[0] ? `gid://shopify/Product/${order.line_items[0].product_id}` : null),
      Number(order.total_price ?? 0),
      Date.now() / 1000,
      codes[0] ?? null,
    );

  console.log(
    `[webhook] order ${order.id} recorded${sessionId ? `, attributed to session ${sessionId}` : " (unattributed)"}`,
  );
  return Response.json({ ok: true, attributed: sessionId !== null });
}
