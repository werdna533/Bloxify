import { env } from "@/lib/env";

/**
 * Uploads an image to Roblox via the Open Cloud Assets API -- a real,
 * documented REST API (apis.roblox.com), not Studio/MCP. This is the piece
 * that makes automated storefront creation work for someone else's game:
 * MCP's own upload_image tool only reaches a Studio session that is open on
 * this machine, which a customer's live server obviously isn't.
 *
 * Implemented against Roblox's published contract (POST /assets/v1/assets,
 * x-api-key auth, a long-running Operation polled at /assets/v1/{path}).
 * Untested against a live key in this session -- no ROBLOX_API_KEY was
 * available to test with -- exercise it once a real key is configured.
 */

const ASSETS_ENDPOINT = "https://apis.roblox.com/assets/v1/assets";
const OPERATIONS_BASE = "https://apis.roblox.com/assets/v1";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 30_000;

export function robloxAssetsConfigured(): boolean {
  return Boolean(env.robloxApiKey && env.robloxCreatorId);
}

type OperationResponse = {
  path?: string;
  done?: boolean;
  response?: { assetId?: string };
  error?: { message?: string };
};

export async function uploadImageToRoblox(
  imageBuffer: Buffer,
  displayName: string,
): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  if (!robloxAssetsConfigured()) {
    return { ok: false, error: "ROBLOX_API_KEY / ROBLOX_CREATOR_ID not configured" };
  }

  const request = {
    assetType: "Decal",
    displayName: displayName.slice(0, 50),
    description: "Uploaded by Commerce Lab for a Roblox storefront display.",
    creationContext: { creator: { userId: env.robloxCreatorId } },
  };

  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append(
    "fileContent",
    new Blob([new Uint8Array(imageBuffer)], { type: "image/png" }),
    `${displayName}.png`,
  );

  let operationPath: string;
  try {
    const res = await fetch(ASSETS_ENDPOINT, {
      method: "POST",
      headers: { "x-api-key": env.robloxApiKey },
      body: form,
    });
    if (!res.ok) {
      return { ok: false, error: `Open Cloud upload HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const op = (await res.json()) as OperationResponse;
    if (op.response?.assetId) return { ok: true, assetId: op.response.assetId };
    if (!op.path) return { ok: false, error: "Open Cloud returned no operation path or assetId" };
    operationPath = op.path;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Asset moderation/processing is async -- poll the operation until it
  // reports done, same long-running-operation pattern Google Cloud APIs use.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${OPERATIONS_BASE}/${operationPath}`, {
        headers: { "x-api-key": env.robloxApiKey },
      });
      if (!res.ok) continue;
      const op = (await res.json()) as OperationResponse;
      if (op.error) return { ok: false, error: op.error.message ?? "Open Cloud processing failed" };
      if (op.done && op.response?.assetId) return { ok: true, assetId: op.response.assetId };
    } catch {
      // Transient -- keep polling until the deadline.
    }
  }

  return { ok: false, error: `asset processing did not finish within ${POLL_TIMEOUT_MS / 1000}s` };
}
