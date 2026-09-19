import type { Env } from "./env";

// A Bridge that claims a job and then dies (Studio crash, laptop sleep, closed
// terminal) would otherwise leave the experiment stuck on "running" forever.
// The alarm turns that into a visible failure instead.
const CLAIM_TIMEOUT_MS = 90_000;

export type RunStatus = "pending" | "claimed" | "done" | "failed";

export type RunState = {
  status: RunStatus;
  experimentId: string;
  action: "apply" | "restore";
  plan: unknown;
  snapshot?: string;
  result?: unknown;
  error?: string;
  claimedAt?: number;
};

// One instance per experiment. Serializes the hand-off between the dashboard
// (which queues work) and the Bridge (which polls for it), so two Bridges
// cannot claim the same job.
export class ExperimentRun {
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

  // Queue work for the Bridge to pick up.
  private async start(body: Partial<RunState>): Promise<Response> {
    const state: RunState = {
      status: "pending",
      experimentId: String(body.experimentId ?? ""),
      action: body.action === "restore" ? "restore" : "apply",
      plan: body.plan ?? null,
      snapshot: body.snapshot,
    };
    await this.ctx.storage.put("state", state);
    return Response.json({ ok: true, status: state.status });
  }

  // The Bridge polls this. Only the first caller gets the job.
  private async claim(): Promise<Response> {
    const state = await this.read();
    if (!state || state.status !== "pending") {
      return Response.json({ pending: false });
    }

    state.status = "claimed";
    state.claimedAt = Date.now();
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + CLAIM_TIMEOUT_MS);

    return Response.json({
      pending: true,
      action: state.action,
      experimentId: state.experimentId,
      plan: state.plan,
      snapshot: state.snapshot,
    });
  }

  // The Bridge posts the outcome back here.
  private async report(body: { ok?: boolean; result?: unknown; error?: string }): Promise<Response> {
    const state = await this.read();
    if (!state) return Response.json({ error: "no run in progress" }, { status: 409 });

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
    state.error = `bridge did not report back within ${CLAIM_TIMEOUT_MS / 1000}s`;
    await this.ctx.storage.put("state", state);
  }

  private async read(): Promise<RunState | undefined> {
    return this.ctx.storage.get<RunState>("state");
  }
}
