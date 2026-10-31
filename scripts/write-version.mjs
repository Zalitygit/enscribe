// Writes package.json's version into the VERSION file, then stages it.
// Run by npm's `version` lifecycle (after the bump, before the commit), so the
// updated VERSION lands in the same commit/tag as package.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(root, "VERSION"), version + "\n");
execFileSync("git", ["add", "VERSION"], { cwd: root, stdio: "ignore" });
