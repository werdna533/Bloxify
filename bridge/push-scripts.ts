/**
 * Pushes Luau files from roblox/src into the open place over MCP.
 *
 * We are not using Rojo, so this is the one-way sync that keeps the committed
 * .lua files the source of truth for code while the place file owns the world.
 *
 * Naming: foo.server.lua -> Script, foo.client.lua -> LocalScript, foo.lua -> ModuleScript.
 * Directory structure maps to the instance path, e.g.
 *   roblox/src/ServerScriptService/Storefront/Registry.lua
 *     -> ServerScriptService.Storefront.Registry
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StudioBridge } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "roblox", "src");

type ScriptFile = { instancePath: string[]; className: string; source: string; rel: string };

function collect(dir: string, trail: string[], out: ScriptFile[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, [...trail, entry.name], out);
      continue;
    }
    if (!entry.name.endsWith(".lua")) continue;

    let base = entry.name.slice(0, -4);
    let className = "ModuleScript";
    if (base.endsWith(".server")) {
      base = base.slice(0, -7);
      className = "Script";
    } else if (base.endsWith(".client")) {
      base = base.slice(0, -7);
      className = "LocalScript";
    }
    out.push({
      instancePath: [...trail, base],
      className,
      source: fs.readFileSync(full, "utf8"),
      rel: path.relative(SRC, full).replace(/\\/g, "/"),
    });
  }
}

const files: ScriptFile[] = [];
collect(SRC, [], files);

if (files.length === 0) {
  console.error(`[push] no .lua files under ${SRC}`);
  process.exit(1);
}

// Long-bracket level must not collide with anything in the source itself.
function longBracket(source: string): string {
  let eq = "=";
  while (source.includes(`]${eq}]`)) eq += "=";
  return eq;
}

const entries = files
  .map((f) => {
    const eq = longBracket(f.source);
    const luauPath = `{ ${f.instancePath.map((p) => JSON.stringify(p)).join(", ")} }`;
    return `{ path = ${luauPath}, className = ${JSON.stringify(
      f.className,
    )}, source = [${eq}[\n${f.source}]${eq}] }`;
  })
  .join(",\n");

const luau = `
local files = {
${entries}
}

local results = {}
for _, file in ipairs(files) do
	local parent = game:GetService(file.path[1])
	for i = 2, #file.path - 1 do
		local nextParent = parent:FindFirstChild(file.path[i])
		if not nextParent then
			nextParent = Instance.new("Folder")
			nextParent.Name = file.path[i]
			nextParent.Parent = parent
		end
		parent = nextParent
	end

	local name = file.path[#file.path]
	-- Always recreate: require() caches by instance, so reusing the instance
	-- would keep serving the old source after a push.
	local existing = parent:FindFirstChild(name)
	if existing then existing:Destroy() end

	local created = Instance.new(file.className)
	created.Name = name
	created.Source = file.source
	created.Parent = parent
	table.insert(results, created:GetFullName() .. " (" .. #file.source .. "b)")
end
return results
`;

// Optional: npx tsx push-scripts.ts "Place1" targets a specific open Studio
// by name when more than one is connected, instead of the first one listed.
const studioFilter = process.argv[2];

const bridge = new StudioBridge();
await bridge.connect();
const result = await bridge.executeLuau(luau, "Edit", studioFilter);
if (result.isError) {
  console.error(`[push] FAILED: ${result.text}`);
  await bridge.close();
  process.exit(1);
}
console.log(`[push] ${files.length} file(s) pushed:`);
// Studio serialises Luau arrays as a key-indexed object, not a JSON array.
const parsed = JSON.parse(result.text) as Record<string, string> | string[];
for (const line of Object.values(parsed)) console.log(`  ${line}`);
await bridge.close();
