// Renders every example (examples/*.rx.js -> examples/out: MP4, GIF, contact sheet) and copies the
// README media to docs/examples. Fails if any example has an error. Needs ffmpeg.
// Run: npm run examples (part of npm run check).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/node/cli.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "examples"), out = join(dir, "out"), media = join(root, "docs", "examples");
const gif: Record<string, number> = { teaser: 320 };   // examples the README shows as a GIF, and its width
const log = console.log;
let failed = 0;
mkdirSync(media, { recursive: true });
for (const f of readdirSync(dir).filter((x) => x.endsWith(".rx.js")).sort()) {
  const name = f.replace(/\.rx\.js$/, ""), lines: string[] = [];
  console.log = (s: string) => lines.push(s);
  const code = await main(["build", join(dir, f), ...(gif[name] ? ["--gif", String(gif[name])] : [])]).finally(() => { console.log = log; });
  if (code !== 0) { failed++; console.log(`FAIL ${f}`); continue; }
  for (const file of [`${name}.mp4`, ...(gif[name] ? [`${name}.gif`] : [])]) copyFileSync(join(out, file), join(media, file));
  copyFileSync(join(out, "_preview", `${name}.png`), join(media, `${name}_sheet.png`));
  console.log(`ok   ${f}: ${lines[0].split(" -> ")[0]}`);
}
if (failed) { console.error(`${failed} example(s) failed`); process.exit(1); }
console.log(`README media -> ${media}`);
