// tests/local-sim.js
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const actionFile = path.join(process.cwd(), "action.yml");
if (!fs.existsSync(actionFile)) {
  fail("action.yml missing");
}

let doc;
try {
  const raw = fs.readFileSync(actionFile, "utf8");
  doc = yaml.load(raw);
} catch (e) {
  fail(`Failed to read/parse action.yml: ${e?.message ?? e}`);
}

if (!doc?.runs?.using) fail("action.yml: missing runs.using");
if (doc.runs.using !== "node20") fail(`action.yml: runs.using must be node20, got ${doc.runs.using}`);

if (!doc?.runs?.main) fail("action.yml: missing runs.main");
const main = String(doc.runs.main).replace(/^\.\//, "");
if (main !== "dist/index.js") fail(`action.yml: runs.main must be dist/index.js, got ${doc.runs.main}`);

const distEntry = path.join(process.cwd(), main);
if (!fs.existsSync(distEntry)) fail(`Missing ${main}. Build output must be committed for JavaScript actions.`);

console.log("ok: action.yml contract and dist entry validated");
