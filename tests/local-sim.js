// tests/local-sim.js
import fs from "node:fs";
import path from "node:path";

const exists = fs.existsSync(path.join(process.cwd(), "action.yml"));
if (!exists) {
  console.error("action.yml missing");
  process.exit(1);
}
console.log("action.yml exists");
