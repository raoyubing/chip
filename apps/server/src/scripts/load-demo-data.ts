import { loadLocalEnv } from "../env.js";

loadLocalEnv();

const { getDatabasePath, initDb, loadDemoData } = await import("../db.js");

const reset = process.argv.includes("--reset");

await initDb();
loadDemoData({ reset });

console.log(`Demo data loaded${reset ? " after clearing existing data" : ""}: ${getDatabasePath()}`);
