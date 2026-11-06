// Assembles dist/: the runtime page plus vendored libraries, so artifacts render fully offline.
// Every third-party file comes from node_modules (installed once); nothing is fetched at runtime.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const vendor = path.join(dist, "vendor");
const licenses = path.join(vendor, "licenses");

rmSync(dist, { recursive: true, force: true });
mkdirSync(licenses, { recursive: true });

/** Folder of an installed package (pnpm links each direct dependency under ./node_modules). */
function pkgDir(name) {
  const dir = path.join(here, "node_modules", ...name.split("/"));
  if (!existsSync(path.join(dir, "package.json"))) throw new Error(`${name} is not installed: run pnpm install`);
  return dir;
}

/** [package, file inside the package, name in dist/vendor] */
const COPIES = [
  ["@babel/standalone", "babel.min.js", "babel.min.js"],
  ["mermaid", "dist/mermaid.min.js", "mermaid.min.js"],
  ["marked", "lib/marked.umd.js", "marked.umd.js"],
  ["dompurify", "dist/purify.min.js", "purify.min.js"],
  ["chart.js", "dist/chart.umd.min.js", "chart.umd.min.js"],
  ["@tailwindcss/browser", "dist/index.global.js", "tailwind.js"],
];

for (const [pkg, file, out] of COPIES) {
  copyFileSync(path.join(pkgDir(pkg), file), path.join(vendor, out));
}

// React 19 ships no browser build: bundle what artifacts may import into one script exposing a global.
await build({
  stdin: {
    contents: `
      import * as React from "react";
      import * as ReactDOM from "react-dom";
      import * as ReactDOMClient from "react-dom/client";
      import * as JSXRuntime from "react/jsx-runtime";
      window.__clawdeModules = {
        "react": React,
        "react-dom": ReactDOM,
        "react-dom/client": ReactDOMClient,
        "react/jsx-runtime": JSXRuntime,
        "react/jsx-dev-runtime": JSXRuntime,
      };
    `,
    resolveDir: here,
    loader: "js",
  },
  bundle: true,
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(vendor, "react.min.js"),
  legalComments: "none",
  logLevel: "warning",
});

for (const pkg of ["react", "react-dom", "@babel/standalone", "mermaid", "marked", "dompurify", "chart.js", "@tailwindcss/browser"]) {
  const licence = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => path.join(pkgDir(pkg), f)).find(existsSync);
  if (licence) copyFileSync(licence, path.join(licenses, `${pkg.replace("/", "__")}.txt`));
}

cpSync(path.join(here, "src"), dist, { recursive: true });
writeFileSync(path.join(dist, "BUILD.txt"), `Built ${new Date().toISOString()}\n`);
console.log(`sandbox: built ${path.relative(process.cwd(), dist)}`);
