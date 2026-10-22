// Assembles the Telnyx Edge package in ./edge (edge/func.toml is kept):
//   npm run edge:build   → then: telnyx-edge ship --from-dir=edge --timeout 25m
// Only the server code and public/ are copied — never .env or data/. Settings
// come from account secrets named TELNYXHOTEL_* (see README → Deploy on Telnyx Edge).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const edge = new URL("../edge/", import.meta.url).pathname;
if (!existsSync(`${edge}func.toml`)) throw new Error("edge/func.toml missing: copy edge/func.toml.example and set your function id (README → Deploy on Telnyx Edge)");

const FILES = ["server.js", "frame-policy.js", "auth.js", "calls.js", "calls-codec.js", "guest-stats.js", "contacts.js", "contact-email.js", "geo.js", "edge-metrics.js", "db.js", "recap.js", "settings.js", "concierge.js", "assistant-admin.js", "email.js", "sms.js"];
for (const f of [...FILES, "public", "geo", "build.json"]) rmSync(`${edge}${f}`, { recursive: true, force: true });
for (const f of FILES) cpSync(`${root}${f}`, `${edge}${f}`);
cpSync(`${root}public`, `${edge}public`, { recursive: true });
// The IP → country table for the guest stats map (downloaded once if missing).
if (!existsSync(`${root}geo/ip-country.bin.gz`)) execFileSync(process.execPath, [`${root}scripts/geo-update.js`], { stdio: "inherit" });
cpSync(`${root}geo`, `${edge}geo`, { recursive: true });

const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
// The branch for the page footers (/api/version): Edge has no git checkout.
let branch = process.env.GIT_BRANCH;
try { branch ||= execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).toString().trim(); } catch { /* no git */ }
writeFileSync(`${edge}build.json`, `${JSON.stringify({ branch: branch || "unknown", builtAt: new Date().toISOString() })}\n`);
writeFileSync(`${edge}package.json`, JSON.stringify({
  name: "telnyxhotel-concierge",
  version: pkg.version,
  private: true,
  type: "module",
  main: "server.js",
  scripts: { start: "node server.js" },
  engines: { node: ">=20.12" }, // node:sqlite is only used locally
  dependencies: { ...pkg.dependencies, "@telnyx/edge-runtime": "^0.16.0" },
}, null, 2) + "\n");
// Edge requires a lockfile; node_modules are installed by the platform, not shipped.
rmSync(`${edge}node_modules`, { recursive: true, force: true });
execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: edge, stdio: "inherit" });
console.log("edge/ ready → telnyx-edge ship --from-dir=edge --timeout 25m");
