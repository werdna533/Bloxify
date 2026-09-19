import { db } from "@/lib/db";
import { fetchProducts } from "@/lib/shopify";
import { readRegistry } from "@/app/api/registry/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pulls products from Shopify, caches them, and maps each to the storefront
 * component showing it. Falls back to the cache if Shopify is unreachable so a
 * flaky connection cannot empty the dashboard mid-demo.
 */
export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get("refresh") !== "0";
  const handle = db();
  let syncError: string | null = null;

  if (refresh) {
    try {
      const products = await fetchProducts();
      const registry = readRegistry();
      const componentByProduct = new Map(
        registry?.components.map((c) => [c.productId, c.componentId]) ?? [],
      );

      const upsert = handle.prepare(`
        INSERT INTO products (shopify_id, title, price, image_url, url, component_id)
        VALUES (@shopifyId, @title, @price, @imageUrl, @url, @componentId)
        ON CONFLICT(shopify_id) DO UPDATE SET
          title = excluded.title,
          price = excluded.price,
          image_url = excluded.image_url,
          url = excluded.url,
          component_id = COALESCE(excluded.component_id, products.component_id)
      `);

      handle.transaction(() => {
        for (const p of products) {
          upsert.run({
            shopifyId: p.id,
            title: p.title,
            price: p.price,
            imageUrl: p.imageUrl,
            url: p.onlineStoreUrl,
            componentId: componentByProduct.get(p.id) ?? null,
          });
        }
      })();
    } catch (error) {
      syncError = error instanceof Error ? error.message : String(error);
      console.error("[products] Shopify sync failed, serving cache:", syncError);
    }
  }

  const rows = handle.prepare(`SELECT * FROM products ORDER BY title`).all();
  return Response.json({ products: rows, syncError, cached: syncError !== null });
}
