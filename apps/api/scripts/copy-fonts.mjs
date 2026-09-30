// Copies the DejaVu fonts next to dist/ so the PDF exporter finds them in bundles that only ship
// traced files (Vercel functions); see dejavu() in src/lib/exporters.ts.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const out = new URL("../fonts/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const name of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) {
  copyFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${name}`), new URL(name, out));
}
