import { fetchProducts } from "@/lib/shopify";
import { env } from "@/lib/env";
import { composeGarmentTexture, normalizeProductImage, fetchImageBuffer } from "@/lib/garment-texture";
import { robloxAssetsConfigured, uploadImageToRoblox } from "@/lib/roblox-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type JobItem = {
  componentId: string;
  productId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  kind: string;
  garmentOnLegs: boolean;
  x: number;
  z: number;
  facingDegrees: number;
  imageAssetId?: string | null;
  shirtTemplateId?: string | null;
  pantsTemplateId?: string | null;
};

/**
 * The dashboard side of "Create Storefront": fetches the Shopify catalog
 * (the one thing only this backend has credentials for), asks the Worker's
 * agent to classify each product and compute a layout, then -- since a
 * Worker can't run `sharp` -- does asset processing here (garment texture
 * generation, Roblox Open Cloud upload) before queueing the finished job for
 * the Roblox place's own poller to build. Requires the Cloudflare Worker;
 * there is no local-SQLite equivalent, since the whole point is a durable
 * job queue a live Roblox server can poll without MCP.
 */
export async function POST() {
  if (!env.workerUrl) {
    return Response.json(
      { error: "storefront creation requires the Cloudflare Worker (set WORKER_URL in .env.local)" },
      { status: 400 },
    );
  }

  const products = await fetchProducts();
  if (products.length === 0) {
    return Response.json({ error: "no Shopify products found" }, { status: 400 });
  }

  const planRes = await fetch(`${env.workerUrl}/storefront/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.backendAuthToken}` },
    body: JSON.stringify({
      products: products.map((p) => ({
        productId: p.id,
        title: p.title,
        price: p.price,
        imageUrl: p.imageUrl,
      })),
    }),
  });
  const planBody = await planRes.json().catch(() => ({}));
  if (!planRes.ok) return Response.json(planBody, { status: planRes.status });

  const job = (planBody as { job: JobItem[] }).job;
  const hasKey = robloxAssetsConfigured();
  const assetErrors: string[] = [];

  if (hasKey) {
    await Promise.all(
      job.map(async (item) => {
        if (!item.imageUrl) return;
        try {
          const raw = await fetchImageBuffer(item.imageUrl);

          const panel = await normalizeProductImage(raw);
          const panelUpload = await uploadImageToRoblox(panel, `${item.componentId}-panel`);
          if (panelUpload.ok) item.imageAssetId = panelUpload.assetId;
          else assetErrors.push(`${item.componentId} panel image: ${panelUpload.error}`);

          if (item.kind === "Mannequin") {
            const { buffer } = await composeGarmentTexture(raw);
            const garmentUpload = await uploadImageToRoblox(buffer, `${item.componentId}-garment`);
            if (garmentUpload.ok) {
              if (item.garmentOnLegs) item.pantsTemplateId = garmentUpload.assetId;
              else item.shirtTemplateId = garmentUpload.assetId;
            } else {
              assetErrors.push(`${item.componentId} garment texture: ${garmentUpload.error}`);
            }
          }
        } catch (error) {
          assetErrors.push(`${item.componentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  const queueRes = await fetch(`${env.workerUrl}/storefront/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.backendAuthToken}` },
    body: JSON.stringify({ job }),
  });
  const queueBody = await queueRes.json().catch(() => ({}));
  if (!queueRes.ok) return Response.json(queueBody, { status: queueRes.status });

  return Response.json({
    ...queueBody,
    needsManualAssetUpload: !hasKey,
    assetErrors: assetErrors.length > 0 ? assetErrors : undefined,
  });
}
