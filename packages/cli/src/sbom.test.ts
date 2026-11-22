import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageName, productionClosure } from "../../../scripts/sbom-closure.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(repo, "scripts", "sbom.mjs");

// A small monorepo: `app` ships; its dev-only tools and the `helpers` test workspace do not.
const lock: Record<string, Record<string, unknown>> = {
  "": { name: "acme", workspaces: ["packages/*"] },
  "packages/app": {
    name: "@acme/app",
    version: "1.0.0",
    dependencies: { "@acme/lib": "*", left: "^1.0.0", "needs-scoped": "^1.0.0" },
    optionalDependencies: { "native-win": "^1.0.0", "native-mac": "^1.0.0" },
    devDependencies: { "@acme/helpers": "*", tool: "^1.0.0" },
  },
  "packages/lib": { name: "@acme/lib", version: "2.0.0", dependencies: { right: "^2.0.0" } },
  "packages/helpers": { name: "@acme/helpers", version: "0.1.0", dependencies: { "only-for-tests": "^1.0.0" } },
  "node_modules/@acme/app": { resolved: "packages/app", link: true },
  "node_modules/@acme/lib": { resolved: "packages/lib", link: true },
  "node_modules/@acme/helpers": { resolved: "packages/helpers", link: true },
  "node_modules/left": { version: "1.4.0", dependencies: { shared: "^1.0.0" } },
  "node_modules/shared": { version: "1.2.0" },
  // `right` needs shared 2, so npm keeps that copy inside it.
  "node_modules/right": { version: "2.0.0", dependencies: { shared: "^2.0.0" } },
  "node_modules/right/node_modules/shared": { version: "2.1.0" },
  "node_modules/needs-scoped": { version: "1.0.0", dependencies: { "@scope/inner": "^1.0.0" } },
  "node_modules/@scope/inner": { version: "1.0.0" },
  "node_modules/native-win": { version: "1.0.0", optional: true },
  "node_modules/tool": { version: "1.0.0", dev: true, dependencies: { "tool-helper": "^1.0.0" } },
  "node_modules/tool-helper": { version: "1.0.0", dev: true },
  "node_modules/only-for-tests": { version: "1.0.0", dev: true },
};

describe("productionClosure", () => {
  const refs = (shipped: string[], entries = lock) => [...productionClosure(entries, shipped).keys()].sort();

  it("follows production edges only: dev-only tools, a test-helper workspace and everything they need are left out", () => {
    expect(refs(["@acme/app"])).toEqual(
      [
        "@acme/app@1.0.0",
        "@acme/lib@2.0.0",
        "@scope/inner@1.0.0",
        "left@1.4.0",
        "native-win@1.0.0",
        "needs-scoped@1.0.0",
        "right@2.0.0",
        "shared@1.2.0",
        "shared@2.1.0",
      ].sort(),
    );
  });

  it("resolves a dependency the way Node does, so a nested copy wins over the hoisted one and both versions are listed", () => {
    const closure = productionClosure(lock, ["@acme/app"]);
    expect([...closure.get("left@1.4.0")!.dependsOn]).toEqual(["shared@1.2.0"]);
    expect([...closure.get("right@2.0.0")!.dependsOn]).toEqual(["shared@2.1.0"]);
  });

  it("builds the graph from production edges: the shipped package does not point at its dev dependencies", () => {
    const edges = [...productionClosure(lock, ["@acme/app"]).get("@acme/app@1.0.0")!.dependsOn].sort();
    expect(edges).toEqual(["@acme/lib@2.0.0", "left@1.4.0", "native-win@1.0.0", "needs-scoped@1.0.0"]);
  });

  it("follows a workspace link to the package folder and keeps scoped names whole", () => {
    const closure = productionClosure(lock, ["@acme/app"]);
    expect(closure.get("@acme/lib@2.0.0")).toMatchObject({ name: "@acme/lib", workspace: true });
    expect(closure.get("@scope/inner@1.0.0")).toMatchObject({ name: "@scope/inner", workspace: false });
    expect(packageName("node_modules/a/node_modules/@scope/pkg", {})).toBe("@scope/pkg");
    expect(packageName("packages/plain", {})).toBe("plain");
  });

  it("treats the same package as production when a shipped workspace needs it, even if another only needs it for tests", () => {
    expect(refs(["@acme/helpers"])).toEqual(["@acme/helpers@0.1.0", "only-for-tests@1.0.0"]);
    expect(refs(["@acme/app", "@acme/helpers"])).toContain("only-for-tests@1.0.0");
  });

  it("skips an optional dependency the lockfile does not have, but refuses a required one", () => {
    const missingRequired = { ...lock, "packages/lib": { name: "@acme/lib", version: "2.0.0", dependencies: { ghost: "^1.0.0" } } };
    expect(() => productionClosure(missingRequired, ["@acme/app"])).toThrow(/@acme\/lib@2\.0\.0 needs ghost/);
    expect(refs(["@acme/app"])).not.toContain("native-mac@1.0.0");
  });

  it("terminates on a dependency cycle", () => {
    const cycle = {
      "": {},
      "packages/app": { name: "app", version: "1.0.0", dependencies: { a: "*" } },
      "node_modules/a": { version: "1.0.0", dependencies: { b: "*" } },
      "node_modules/b": { version: "1.0.0", dependencies: { a: "*" } },
    };
    expect(refs(["app"], cycle)).toEqual(["a@1.0.0", "app@1.0.0", "b@1.0.0"]);
  });

  it("names the workspace packages it knows when asked for one it does not", () => {
    expect(() => productionClosure(lock, ["@acme/nope"])).toThrow(/no workspace package named @acme\/nope.*@acme\/app/);
  });
});

interface Component {
  "bom-ref": string;
  name: string;
  version?: string;
  purl?: string;
  licenses?: unknown[];
  hashes?: { alg: string }[];
  properties?: { name: string }[];
}
interface Bom {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  metadata: { component: { name: string; type: string; "bom-ref": string } };
  components: Component[];
  dependencies: { ref: string; dependsOn: string[] }[];
}

const manifest = (dir: string): { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(path.join(repo, "packages", dir, "package.json"), "utf8"));

describe.skipIf(!existsSync(path.join(repo, "package-lock.json")))("the software bill of materials for this repository", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "vivah-sbom-"));
  let cli: Bom;
  let api: Bom;

  const generate = (name: string, ...extra: string[]): Bom => {
    const out = path.join(scratch, name);
    const run = spawnSync(process.execPath, [script, "--out", out, ...extra], { cwd: repo, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/Deprecation/i);
    return JSON.parse(readFileSync(out, "utf8")) as Bom;
  };

  beforeAll(() => {
    cli = generate("cli.json");
    api = generate("api.json", "--package", "@vivahlens/cloud-api");
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const names = (bom: Bom) => bom.components.map((c) => c.name);

  it("is a CycloneDX document that describes the product as an application, named by its package name", () => {
    expect(cli.bomFormat).toBe("CycloneDX");
    expect(cli.specVersion).toMatch(/^1\.[5-9]$/);
    expect(cli.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(cli.metadata.component).toMatchObject({ name: "vivahlens", type: "application" });
  });

  it("lists what the command-line product needs at run time, and none of the tools it is built and tested with", () => {
    const declared = Object.keys({ ...manifest("cli").dependencies, ...manifest("cli").optionalDependencies, ...manifest("cli").peerDependencies });
    expect(declared.length).toBeGreaterThan(5);
    for (const dependency of ["@vivahlens/cli", ...declared, "zod", "jpeg-js"]) expect(names(cli), dependency).toContain(dependency);
    for (const tool of ["@vivahlens/testkit", "@vivahlens/cloud-api", "vitest", "typescript", "@types/node", "esbuild", "fengari"]) {
      expect(names(cli), tool).not.toContain(tool);
    }
    expect(cli.components.some((c) => c.properties?.some((p) => p.name === "cdx:npm:package:development"))).toBe(false);
  });

  it("gives every component the name its package URL carries: our packages by package name, not by folder", () => {
    for (const c of cli.components) {
      const fromPurl = decodeURIComponent(c.purl!.slice("pkg:npm/".length, c.purl!.lastIndexOf("@")));
      expect(c.name, c["bom-ref"]).toBe(fromPurl);
    }
    expect(names(cli)).toContain("@vivahlens/adapter-lightroom");
    expect(names(cli)).not.toContain("lightroom");
  });

  it("describes every third-party component well enough to audit: version, package URL, SHA-512 hash and licence", () => {
    const thirdParty = cli.components.filter((c) => !c.name.startsWith("@vivahlens/"));
    expect(thirdParty.map((c) => c.name).sort()).toEqual(["jpeg-js", "zod"]);
    for (const c of thirdParty) {
      expect(c.version, c.name).toBeTruthy();
      expect(c.purl, c.name).toMatch(/^pkg:npm\//);
      expect(c.hashes?.map((h) => h.alg), c.name).toContain("SHA-512");
      expect(c.licenses?.length, c.name).toBeGreaterThan(0);
    }
  });

  it("has a graph made of production edges that points only at listed components", () => {
    const listed = new Set([...cli.components.map((c) => c["bom-ref"]), cli.metadata.component["bom-ref"]]);
    for (const d of cli.dependencies) {
      expect(listed.has(d.ref), d.ref).toBe(true);
      for (const target of d.dependsOn) expect(listed.has(target), `${d.ref} -> ${target}`).toBe(true);
    }
    const dependsOn = (name: string) => cli.dependencies.find((d) => d.ref.startsWith(`${name}@`))!.dependsOn.map((r) => r.slice(0, r.lastIndexOf("@"))).sort();
    const cliManifest = manifest("cli");
    expect(dependsOn("@vivahlens/cli")).toEqual(Object.keys({ ...cliManifest.dependencies, ...cliManifest.optionalDependencies, ...cliManifest.peerDependencies }).sort());
    expect(cli.dependencies.find((d) => d.ref === cli.metadata.component["bom-ref"])!.dependsOn).toEqual(["@vivahlens/cli@0.0.0"]);
  });

  it("gives the hosted service its own list, without the command-line product", () => {
    expect(names(api)).toEqual(expect.arrayContaining(["@vivahlens/cloud-api", "@vivahlens/core", "zod"]));
    expect(names(api)).not.toContain("@vivahlens/cli");
    expect(names(api)).not.toContain("jpeg-js");
    expect(api.dependencies.find((d) => d.ref === api.metadata.component["bom-ref"])!.dependsOn).toEqual(["@vivahlens/cloud-api@0.0.0"]);
  });

  it("refuses a package it does not know, naming the ones it does", () => {
    const run = spawnSync(process.execPath, [script, "--package", "@vivahlens/nope", "--out", path.join(scratch, "x.json")], { cwd: repo, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/no workspace package named @vivahlens\/nope.*@vivahlens\/cli/);
  });
});
