import type { Env } from "./env";

// A Roblox place that claims a job and then dies (server restart, crash)
// would otherwise leave "Create Storefront" stuck forever. The alarm turns
// that into a visible failure instead, same reasoning as ExperimentRun.
const CLAIM_TIMEOUT_MS = 60_000;

export type SetupStatus = "none" | "pending" | "claimed" | "done" | "failed";

export type SetupState = {
  status: SetupStatus;
  job: unknown;
  result?: unknown;
  error?: string;
  claimedAt?: number;
};

/**
 * One instance total (idFromName("singleton")): this Worker deployment backs
 * exactly one storefront, the same assumption the rest of the schema already
 * makes. Serializes the hand-off between the dashboard (which queues a
 * layout) and the Roblox place's own poller (which claims and builds it), so
 * two live servers polling the same place can't double-build.
 */
export class StorefrontSetup {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/start") return this.start(await request.json());
    if (pathname === "/claim") return this.claim();
    if (pathname === "/report") return this.report(await request.json());
    if (pathname === "/state") return Response.json((await this.read()) ?? { status: "none" });

    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Queue a layout for the Roblox poller to pick up.
  private async start(body: { job?: unknown }): Promise<Response> {
    const state: SetupState = { status: "pending", job: body.job ?? null };
    await this.ctx.storage.put("state", state);
    return Response.json({ ok: true, status: state.status });
  }

  // The Roblox poller calls this. Only the first caller gets the job.
  private async claim(): Promise<Response> {
    const state = await this.read();
    if (!state || state.status !== "pending") {
      return Response.json({ pending: false });
    }

    state.status = "claimed";
    state.claimedAt = Date.now();
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + CLAIM_TIMEOUT_MS);

    return Response.json({ pending: true, job: state.job });
  }

  // Roblox posts the outcome back here after it finishes building.
  private async report(body: { ok?: boolean; result?: unknown; error?: string }): Promise<Response> {
    const state = await this.read();
    if (!state) return Response.json({ error: "no setup in progress" }, { status: 409 });

    state.status = body.ok === false ? "failed" : "done";
    state.result = body.result;
    state.error = body.error;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.deleteAlarm();

    return Response.json({ ok: true, status: state.status });
  }

  // Fires only if a claim was never reported back.
  async alarm(): Promise<void> {
    const state = await this.read();
    if (!state || state.status !== "claimed") return;

    state.status = "failed";
    state.error = `no Roblox place reported back within ${CLAIM_TIMEOUT_MS / 1000}s`;
    await this.ctx.storage.put("state", state);
  }

  private async read(): Promise<SetupState | undefined> {
    return this.ctx.storage.get<SetupState>("state");
  }
}
