// One chunk of a proxy (see proxy.ts): loads the trailer file, builds the timeline and draws frames [first, last) at the given scale.
//   node proxy_worker.ts <file> <trailer> <scale> <first> <last> <out.mp4>
import { loadProject } from "./load.ts";
import { renderMp4 } from "./render.ts";

const [file, name, scale, first, last, out] = process.argv.slice(2);
try {
  const tl = loadProject(file).timeline(name);
  await renderMp4(tl, out, { scale: Number(scale), preset: "ultrafast", crf: 26, range: [Number(first), Number(last)] });
} catch (e) {
  console.error((e as Error).message ?? String(e));
  process.exit(1);
}
