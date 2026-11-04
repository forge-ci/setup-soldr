// Post-process an ncc bundle into dist/<name>.js with deterministic content.
//
// Two normalizations are applied:
//
// 1) CRLF -> LF. ncc inlines tslib.js verbatim into the bundle. On Windows,
//    `node_modules/tslib/tslib.js` is extracted with CRLF line endings by npm,
//    so the bundled output has a CRLF block where tslib lives. On Linux/macOS
//    the same file is LF. Without this normalization dist/ differs across
//    build hosts.
//
// 2) Reassign webpack modules to stable numeric IDs. webpack emits modules in
//    discovery order, which depends on filesystem enumeration and module
//    resolution timing. On Windows the same set of modules can receive
//    different numeric IDs than on Linux. Sorting by normalized module body and
//    rewriting __nccwpck_require__(id) references makes the output
//    byte-identical across platforms.
//
// Usage: node scripts/bundle-entrypoint.mjs main
//        node scripts/bundle-entrypoint.mjs post
//        node scripts/bundle-entrypoint.mjs cleanup
//        node scripts/bundle-entrypoint.mjs cook
//        node scripts/bundle-entrypoint.mjs cook-post

import { copyFileSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { createHash } from "node:crypto";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/bundle-entrypoint.mjs <main|post|cleanup|cook|cook-post>");
  process.exit(1);
}

const actionEntrypoints = new Map([
  ["cleanup", { path: "cleanup/dist/index.js", dir: "cleanup/dist" }],
  ["cook", { path: "cook/dist/main.js", dir: "cook/dist" }],
  ["cook-post", { path: "cook/dist/post.js", dir: "cook/dist" }],
]);

const sourcePath = `dist-${name}/index.js`;
const actionEntrypoint = actionEntrypoints.get(name);
const targetPath = actionEntrypoint?.path ?? `dist/${name}.js`;
mkdirSync("dist", { recursive: true });
if (actionEntrypoint) {
  mkdirSync(actionEntrypoint.dir, { recursive: true });
}

// ncc produces side-chunk files (`<id>.index.js`) for any dynamic
// import — `await import(...)` in our own code OR transitively inside
// any npm dep (e.g. @actions/artifact → @azure/identity). The runtime
// resolves `require('./<id>.index.js')` relative to the bundle's own
// directory, so we MUST copy these chunks alongside dist/<name>.js or
// the action crashes with `Cannot find module './<id>.index.js'` —
// which is exactly what bit v0.9.22 in zccache CI on the cargo-
// registry save path. When chunks are present we also SKIP the
// module-ID renumbering below, because the renumbering touches
// `__nccwpck_require__(<id>)` references that include the chunk IDs;
// rewriting them would desync the bundle from the on-disk chunk
// filenames. (Determinism for chunkless bundles is preserved.)
const sourceDir = `dist-${name}`;
const targetDir = actionEntrypoint?.dir ?? "dist";
const chunkFiles = readdirSync(sourceDir).filter(
  (f) => /^\d+\.index\.js$/.test(f),
);
for (const chunk of chunkFiles) {
  copyFileSync(pathJoin(sourceDir, chunk), pathJoin(targetDir, chunk));
}
if (chunkFiles.length > 0) {
  console.log(
    `bundle-entrypoint: copied ${chunkFiles.length} chunk(s) into ${targetDir}/ (renumbering disabled): ` +
      chunkFiles.join(", "),
  );
}

const buf = readFileSync(sourcePath);
// Normalize CRLF -> LF. Standalone CR (without LF) is left alone - ncc bundles
// don't emit lone CRs in practice and we want to fail loudly if they appear
// rather than silently transform.
const lfText = buf.toString("utf8").replace(/\r\n/g, "\n");

// Skip the sortWebpackModules renumbering when chunk files are
// present — it would rewrite chunk-id references in the main bundle
// and desync them from the on-disk `<id>.index.js` filenames.
const sortedText = chunkFiles.length > 0
  ? stripTrailingLineWhitespace(lfText)
  : stripTrailingLineWhitespace(sortWebpackModules(lfText));

const out = Buffer.from(sortedText, "utf8");
writeFileSync(targetPath, out);

console.log(
  `wrote ${targetPath} (${out.length} bytes; normalized from ${buf.length} bytes)`,
);

/**
 * Sort the `var __webpack_modules__ = ({ ... });` block by normalized module
 * body and reassign stable numeric IDs.
 *
 * Bundle shape produced by ncc/webpack:
 *
 *   /******\/ (() => {
 *   /******\/ 	var __webpack_modules__ = ({
 *
 *   /***\/ 1234:
 *   /***\/ (... module body ...),
 *
 *   /***\/ 5678:
 *   /***\/ (... module body ...)
 *
 *   /******\/ 	});
 *   ...runtime + entry...
 *
 * Inside __webpack_modules__, every module except the last ends with
 * `/***\/ }),` and the last ends with `/***\/ })` (no trailing comma).
 * After sorting we re-apply that punctuation: all-but-last get the comma,
 * last drops it.
 */
function sortWebpackModules(text) {
  const headerEndMarker = "/******/ \tvar __webpack_modules__ = ({\n";
  const footerStartMarker = "\n/******/ \t});\n";

  const headerEnd = text.indexOf(headerEndMarker);
  if (headerEnd === -1) {
    throw new Error(
      `bundle-entrypoint: could not locate __webpack_modules__ header in ${sourcePath}`,
    );
  }
  const modulesStart = headerEnd + headerEndMarker.length;

  const footerStart = text.indexOf(footerStartMarker, modulesStart);
  if (footerStart === -1) {
    throw new Error(
      `bundle-entrypoint: could not locate __webpack_modules__ footer in ${sourcePath}`,
    );
  }

  const header = text.slice(0, modulesStart);
  const modulesBlock = text.slice(modulesStart, footerStart);
  const footer = text.slice(footerStart);

  // Split modules. Each module starts at a line of the form `/***/ <id>:`
  // and continues until just before the next such line (or end of block).
  const moduleHeaderRe = /^\/\*\*\*\/ (\d+):$/gm;
  const matches = [];
  let m;
  while ((m = moduleHeaderRe.exec(modulesBlock)) !== null) {
    matches.push({ id: Number(m[1]), start: m.index });
  }
  if (matches.length === 0) {
    // Nothing to sort; pass through.
    return text;
  }

  const modules = matches.map((match, i) => {
    const end =
      i + 1 < matches.length ? matches[i + 1].start : modulesBlock.length;
    return { id: match.id, body: modulesBlock.slice(match.start, end) };
  });

  // Sanity check: every module body should contain a closing `/***/ })` line.
  for (const mod of modules) {
    if (!/\/\*\*\*\/ \}\)/.test(mod.body)) {
      throw new Error(
        `bundle-entrypoint: module ${mod.id} missing close marker; bundle layout has changed`,
      );
    }
  }

  const sortKeys = stableModuleSortKeys(modules);
  modules.sort((a, b) => {
    const aKey = sortKeys.get(a.id);
    const bKey = sortKeys.get(b.id);
    if (aKey === undefined || bKey === undefined) {
      throw new Error("bundle-entrypoint: missing module sort key");
    }
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    return a.id - b.id;
  });

  const idMap = new Map();
  modules.forEach((mod, i) => idMap.set(mod.id, i));

  // Strip trailing whitespace and any `,` after the closing `})` on every
  // module, then reapply: comma on all but the last.
  const normalizedBodies = modules.map((mod) => {
    const newId = idMap.get(mod.id);
    if (newId === undefined) {
      throw new Error(`bundle-entrypoint: missing stable ID for module ${mod.id}`);
    }
    let body = rewriteRequireIds(mod.body, idMap);
    body = body.replace(/^\/\*\*\*\/ \d+:/m, `/***/ ${newId}:`);
    body = body.replace(/\s+$/, "");
    body = body.replace(/\/\*\*\*\/ \}\),?\s*$/, "/***/ })");
    return { id: mod.id, body };
  });

  const lastIdx = normalizedBodies.length - 1;
  const reassembledModules = normalizedBodies
    .map((mod, i) => {
      if (i === lastIdx) {
        return `${mod.body}\n`;
      }
      // Anchor the rewrite to end-of-string so we only touch the closing
      // marker, never an incidental `/***/ })` that might appear earlier.
      const withComma = mod.body.replace(/\/\*\*\*\/ \}\)$/, "/***/ }),");
      return `${withComma}\n\n`;
    })
    .join("");

  return `${rewriteRequireIds(header, idMap)}\n${reassembledModules}${rewriteRequireIds(footer, idMap)}`;
}

function stripTrailingLineWhitespace(text) {
  return text.replace(/[ \t]+$/gm, "");
}

function stableModuleSortKeys(modules) {
  let signatures = new Map(
    modules.map((mod) => [
      mod.id,
      hashString(replaceRequireIdsInText(stableModuleBaseBody(mod.body), () => "<id>")),
    ]),
  );

  for (let i = 0; i < 8; i++) {
    const next = new Map();
    for (const mod of modules) {
      const body = replaceRequireIdsInText(stableModuleBaseBody(mod.body), (rawId) => {
        const target = signatures.get(Number(rawId));
        return target === undefined ? `external:${rawId}` : `module:${target}`;
      });
      next.set(mod.id, hashString(body));
    }

    if (mapsEqual(signatures, next)) {
      return next;
    }
    signatures = next;
  }

  return signatures;
}

function stableModuleBaseBody(body) {
  return body.replace(/^\/\*\*\*\/ \d+:/m, "/***/ <id>:");
}

function rewriteRequireIds(text, idMap) {
  return replaceRequireIdsInText(text, (rawId) => {
    const oldId = Number(rawId);
    const newId = idMap.get(oldId);
    return newId === undefined ? rawId : String(newId);
  });
}

function replaceRequireIdsInText(text, mapId) {
  let rewritten = text.replace(/__nccwpck_require__\((\d+)\)/g, (match, rawId) => {
    return `__nccwpck_require__(${mapId(rawId)})`;
  });

  rewritten = rewritten.replace(
    /(__nccwpck_require__\.t\.bind\(__nccwpck_require__,\s*)(\d+)(\s*,)/g,
    (match, prefix, rawId, suffix) => `${prefix}${mapId(rawId)}${suffix}`,
  );

  rewritten = rewritten.replace(
    /(__nccwpck_require__\.t\(\s*)(\d+)(\s*,)/g,
    (match, prefix, rawId, suffix) => `${prefix}${mapId(rawId)}${suffix}`,
  );

  return rewritten;
}

function hashString(text) {
  return createHash("sha256").update(text).digest("hex");
}

function mapsEqual(a, b) {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}
