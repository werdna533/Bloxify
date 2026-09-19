import { db } from "@/lib/db";
import { env, requireAuth } from "@/lib/env";
import { createClaimCode } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes, players read this off a wall

function mintCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `RBX-${out}`;
}

/**
 * One single-use discount code per in-game session and product. The order
 * webhook carries the code back, which is what makes a real purchase
 * attributable to a specific session in the Roblox store.
 */
export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    sessionId?: string;
    productId?: string;
  };
  if (!body.sessionId || !body.productId) {
    return Response.json({ error: "sessionId and productId are required" }, { status: 400 });
  }

  const handle = db();

  // Reuse rather than mint a second code if they click twice.
  const existing = handle
    .prepare(`SELECT code FROM claim_codes WHERE session_id = ? AND product_id = ?`)
    .get(body.sessionId, body.productId) as { code: string } | undefined;
  if (existing) {
    return Response.json({ code: existing.code, url: storeUrl(), reused: true });
  }

  const code = mintCode();
  try {
    await createClaimCode(code, body.productId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[claim] Shopify refused to mint:", message);

    // Distinguish a missing permission from an outage: the first is a
    // two-minute fix in the Shopify admin, the second is worth retrying.
    const missingScope = /access scope|Access denied/i.test(message);
    return Response.json(
      {
        error: missingScope
          ? "Shopify app is missing the write_discounts scope, so no discount code can be issued. Showing the store link without a code."
          : `could not mint code: ${message}`,
        reason: missingScope ? "missing_scope" : "shopify_error",
        url: storeUrl(),
      },
      { status: 502 },
    );
  }

  handle
    .prepare(
      `INSERT INTO claim_codes (code, session_id, product_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(code, body.sessionId, body.productId, Date.now() / 1000);

  return Response.json({ code, url: storeUrl(), reused: false });
}

function storeUrl(): string {
  return `https://${env.shopifyDomain}`;
}
