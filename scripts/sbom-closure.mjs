// Which packages end up inside a shipped product: the production edges, followed through package-lock.json.
//
// npm's own selectors cannot answer this in a monorepo. `npm sbom --omit dev` treats a package as development-only when ANY
// path to it crosses a dev edge, which drops zod and jpeg-js here (docs/research/platform-release-security-verification-3.md
// §5.1); and with no filter, a private test-helper workspace looks like part of the product.

// peerDependencies are followed only when the lockfile has them: npm installs them, and an optional peer may be absent.
const PRODUCTION_EDGES = ["dependencies", "optionalDependencies", "peerDependencies"];
const MODULES = "node_modules/";

/** A lockfile entry's package name: its own `name` (workspaces, aliases), else the folder it sits in. */
export function packageName(lockPath, entry) {
  if (entry.name) return entry.name;
  const at = lockPath.lastIndexOf(MODULES);
  return at === -1 ? lockPath.slice(lockPath.lastIndexOf("/") + 1) : lockPath.slice(at + MODULES.length);
}

const refOf = (lockPath, entry) => `${packageName(lockPath, entry)}@${entry.version}`;
const isWorkspace = (lockPath) => !lockPath.includes(MODULES);

/** Where Node would find `name` when it is required from the package installed at `from`: its own node_modules, then each parent's. */
function locate(entries, from, name) {
  for (let dir = from; ; ) {
    const candidate = `${dir}${dir ? "/" : ""}${MODULES}${name}`;
    if (entries[candidate]) return candidate;
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf(`/${MODULES}`);
    dir = cut === -1 ? "" : dir.slice(0, cut);
  }
}

/**
 * @param {Record<string, any>} entries the `packages` object of a lockfile (version 3)
 * @param {string[]} shipped names of the workspace packages that are delivered
 * @returns {Map<string, {ref: string, name: string, version: string, workspace: boolean, dependsOn: Set<string>}>}
 *          every package they need at run time, keyed by `name@version`, with the edges between them
 */
export function productionClosure(entries, shipped) {
  const starts = shipped.map((name) => {
    const found = Object.keys(entries).find((p) => p !== "" && isWorkspace(p) && packageName(p, entries[p]) === name);
    if (!found) {
      const known = Object.keys(entries).filter((p) => p !== "" && isWorkspace(p)).map((p) => packageName(p, entries[p]));
      throw new Error(`no workspace package named ${name} in package-lock.json (have: ${known.join(", ")})`);
    }
    return found;
  });

  const closure = new Map();
  const visited = new Set();
  const stack = [...starts];
  while (stack.length > 0) {
    const at = stack.pop();
    if (visited.has(at)) continue;
    visited.add(at);

    const entry = entries[at];
    const ref = refOf(at, entry);
    const node = closure.get(ref) ?? { ref, name: packageName(at, entry), version: entry.version, workspace: isWorkspace(at), dependsOn: new Set() };
    closure.set(ref, node);

    for (const edge of PRODUCTION_EDGES) {
      for (const dependency of Object.keys(entry[edge] ?? {})) {
        const found = locate(entries, at, dependency);
        if (!found) {
          if (edge === "dependencies") throw new Error(`${ref} needs ${dependency}, which package-lock.json does not contain`);
          continue;
        }
        // A workspace is installed as a link to its folder; the folder's entry is the package.
        const target = entries[found].link ? entries[found].resolved : found;
        node.dependsOn.add(refOf(target, entries[target]));
        stack.push(target);
      }
    }
  }
  return closure;
}
