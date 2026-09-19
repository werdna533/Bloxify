import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_BAT = path.join(os.homedir(), "AppData", "Local", "Roblox", "mcp.bat");

export type ToolResult = { text: string; isError: boolean };

export class StudioBridge {
  private client: Client | null = null;
  private studioId: string | null = null;

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: "cmd.exe",
      args: ["/c", MCP_BAT],
      stderr: "pipe",
    });
    const client = new Client({ name: "commerce-lab-bridge", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  async listToolNames(): Promise<string[]> {
    if (!this.client) throw new Error("not connected");
    const res = await this.client.listTools();
    return res.tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client) throw new Error("not connected");
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { text, isError: res.isError === true };
  }

  /** Studio MCP requires a studio_id on every call. Resolve and cache it. */
  async getStudioId(): Promise<string> {
    if (this.studioId) return this.studioId;
    const res = await this.call("list_roblox_studios", {});
    const parsed = JSON.parse(res.text) as { studios: { id: string; name: string }[] };
    if (!parsed.studios?.length) throw new Error("no Roblox Studio instances connected");
    this.studioId = parsed.studios[0].id;
    console.log(`[bridge] studio: ${parsed.studios[0].name} (${this.studioId})`);
    return this.studioId;
  }

  async executeLuau(code: string, datamodel: "Edit" | "Client" | "Server" = "Edit"): Promise<ToolResult> {
    return this.call("execute_luau", {
      studio_id: await this.getStudioId(),
      datamodel_type: datamodel,
      code,
    });
  }

  /** The connection dies when Studio closes or the place changes. Re-handshake rather than crash. */
  async reconnect(): Promise<void> {
    this.client = null;
    this.studioId = null;
    await this.connect();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
