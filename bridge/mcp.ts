import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_BAT = path.join(os.homedir(), "AppData", "Local", "Roblox", "mcp.bat");

export type ToolResult = { text: string; isError: boolean; images: string[] };

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
    const content = (res.content ?? []) as { type: string; text?: string; data?: string }[];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const images = content.filter((c) => c.type === "image" && c.data).map((c) => c.data as string);
    return { text, isError: res.isError === true, images };
  }

  /**
   * Studio MCP requires a studio_id on every call. Resolve and cache it.
   * With more than one Studio open (e.g. testing against a second, blank
   * place alongside the main demo place), pass a substring of the target's
   * name -- shown in Studio's title bar -- to pick it instead of the first
   * one MCP happens to list.
   */
  async getStudioId(nameFilter?: string): Promise<string> {
    if (this.studioId) return this.studioId;
    const res = await this.call("list_roblox_studios", {});
    const parsed = JSON.parse(res.text) as { studios: { id: string; name: string }[] };
    if (!parsed.studios?.length) throw new Error("no Roblox Studio instances connected");
    const chosen = nameFilter
      ? parsed.studios.find((s) => s.name.toLowerCase().includes(nameFilter.toLowerCase()))
      : parsed.studios[0];
    if (!chosen) {
      throw new Error(
        `no connected Studio matches "${nameFilter}". Connected: ${parsed.studios.map((s) => s.name).join(", ")}`,
      );
    }
    this.studioId = chosen.id;
    console.log(`[bridge] studio: ${chosen.name} (${this.studioId})`);
    return this.studioId;
  }

  async executeLuau(
    code: string,
    datamodel: "Edit" | "Client" | "Server" = "Edit",
    studioNameFilter?: string,
  ): Promise<ToolResult> {
    return this.call("execute_luau", {
      studio_id: await this.getStudioId(studioNameFilter),
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
