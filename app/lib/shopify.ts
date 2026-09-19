import { env } from "@/lib/env";

const API_VERSION = "2024-10";

type GraphQLResponse<T> = { data?: T; errors?: { message: string }[] };

export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!env.shopifyDomain || !env.shopifyAdminToken) {
    throw new Error("SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN missing from .env.local");
  }

  const res = await fetch(`https://${env.shopifyDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.shopifyAdminToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("Shopify returned no data");
  return body.data;
}

export type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  price: number;
  imageUrl: string | null;
  onlineStoreUrl: string | null;
};

export async function fetchProducts(): Promise<ShopifyProduct[]> {
  const data = await shopifyGraphQL<{
    products: {
      edges: {
        node: {
          id: string;
          title: string;
          handle: string;
          onlineStoreUrl: string | null;
          featuredImage: { url: string } | null;
          priceRangeV2: { minVariantPrice: { amount: string } };
        };
      }[];
    };
  }>(`
    {
      products(first: 25) {
        edges {
          node {
            id
            title
            handle
            onlineStoreUrl
            featuredImage { url }
            priceRangeV2 { minVariantPrice { amount } }
          }
        }
      }
    }
  `);

  return data.products.edges.map(({ node }) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    price: Number(node.priceRangeV2.minVariantPrice.amount),
    imageUrl: node.featuredImage?.url ?? null,
    onlineStoreUrl: node.onlineStoreUrl,
  }));
}

/**
 * Mints a single-use discount code tied to one in-game session. The order
 * webhook carries the code back, which is what turns "someone bought a mug"
 * into "the player in session X bought a mug after seeing it in Roblox".
 */
export async function createClaimCode(
  code: string,
  productId: string,
  percentage = 0.05,
): Promise<{ code: string; id: string }> {
  const data = await shopifyGraphQL<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(
    `
    mutation CreateClaim($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `,
    {
      input: {
        title: `Roblox session claim ${code}`,
        code,
        startsAt: new Date().toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: {
          value: { percentage },
          items: { products: { productsToAdd: [productId] } },
        },
      },
    },
  );

  const errors = data.discountCodeBasicCreate.userErrors;
  if (errors?.length) {
    throw new Error(errors.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; "));
  }
  const id = data.discountCodeBasicCreate.codeDiscountNode?.id;
  if (!id) throw new Error("Shopify created no discount node");
  return { code, id };
}
