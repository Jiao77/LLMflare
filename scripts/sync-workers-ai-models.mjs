import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const targetPath = join(process.cwd(), "public", "workers-ai-models.json");
const wranglerEntry = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

try {
  const output = execFileSync(
    process.execPath,
    [wranglerEntry, "ai", "models", "list", "--task", "Text Generation", "--hide-experimental", "--json"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const catalog = JSON.parse(output);
  const models = [...new Set(catalog.map((item) => item?.name).filter((name) => typeof name === "string" && name.startsWith("@cf/")))].sort();

  if (!models.length) throw new Error("Workers AI model sync returned an empty catalog");
  writeFileSync(targetPath, JSON.stringify({ generatedAt: new Date().toISOString(), models }, null, 2) + "\n");
  console.log(`Synced ${models.length} Workers AI text-generation models.`);
} catch (cause) {
  if (existsSync(targetPath)) {
    try {
      const existing = JSON.parse(readFileSync(targetPath, "utf8"));
      if (Array.isArray(existing.models) && existing.models.length > 0) {
        console.warn(`[WARN] Workers AI model catalog sync failed; using cached catalog (${existing.models.length} models, generated at ${existing.generatedAt || "unknown"}). Reason: ${cause instanceof Error ? cause.message : String(cause)}`);
        process.exit(0);
      }
    } catch {}
  }
  throw cause;
}
