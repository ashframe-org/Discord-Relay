// Postinstall patch: cubyz-node-client 1.3.0 targets the 0.3.0 handshake,
// but our server is 0.4.0, which inserted a `reload` state into the handshake
// enum (reload=4, assets=5, serverData=6). Without this the client mistakes
// the binary asset pack for the server-data zon and disconnects.
// Idempotent: skips if RELOAD is already present (safe to re-run).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(root, "..", "node_modules", "cubyz-node-client", "dist", "constants.js");

let text;
try {
	text = fs.readFileSync(file, "utf8");
} catch {
	console.log("[patch-cubyz-client] cubyz-node-client not installed, skipping.");
	process.exit(0);
}
if (text.includes("RELOAD:")) {
	console.log("[patch-cubyz-client] already patched, skipping.");
	process.exit(0);
}
const oldBlock = `    SIGNATURE_RESPONSE: 3,
    ASSETS: 4,
    SERVER_DATA: 5,`;
const newBlock = `    SIGNATURE_RESPONSE: 3,
    RELOAD: 4,
    ASSETS: 5,
    SERVER_DATA: 6,`;
if (!text.includes(oldBlock)) {
	console.error("[patch-cubyz-client] expected handshake block not found, NOT patched.");
	process.exit(1);
}
fs.writeFileSync(file, text.replace(oldBlock, newBlock));
console.log("[patch-cubyz-client] handshake states renumbered for 0.4.0.");
