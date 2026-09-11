import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The extension host provides `vscode` at runtime, so it is never bundled. */
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** The webview runs in a browser context, so mermaid is bundled into it. */
const webview = {
  entryPoints: ["src/webview/diagram.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "media/diagram.js",
  sourcemap: !production,
  minify: true,
  logLevel: "info",
};

const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
