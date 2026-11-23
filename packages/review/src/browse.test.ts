import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BrowseError, checkFolder, createFolder, listFolder, places, startFolder } from "./browse.js";

const root = mkdtempSync(path.join(tmpdir(), "vivah-browse-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const make = (...parts: string[]) => mkdirSync(path.join(root, ...parts), { recursive: true });

const code = async (work: Promise<unknown>) => ((await work.then(
  () => undefined,
  (err: unknown) => err,
)) as BrowseError | undefined)?.code;

describe("listing folders", () => {
  it("lists only folders, in the order a person expects, and says what is above", async () => {
    for (const name of ["shoot 10", "shoot 2", "Archive", "zeta"]) make("list", name);
    make("list", ".git");
    make("list", "$RECYCLE.BIN");
    writeFileSync(path.join(root, "list", "IMG_1.jpg"), "x");

    const listing = await listFolder(path.join(root, "list"));
    expect(listing.folders.map((f) => f.name)).toEqual(["Archive", "shoot 2", "shoot 10", "zeta"]);
    expect(listing.folders[0]).toEqual({ name: "Archive", path: path.join(root, "list", "Archive") });
    expect(listing.parent).toBe(root);
    expect(listing.path).toBe(path.join(root, "list"));
    expect(listing.truncated).toBe(false);
  });

  it("spells the path the way the system does, and has no parent at the top", async () => {
    make("spell", "inner");
    expect((await listFolder(path.join(root, "spell", "inner", "..", "")))).toMatchObject({ path: path.join(root, "spell") });
    const top = path.parse(root).root;
    expect((await listFolder(top)).parent).toBeNull();
  });

  it("follows a link to a folder and ignores one that leads nowhere", async () => {
    make("links", "real");
    try {
      symlinkSync(path.join(root, "links", "real"), path.join(root, "links", "alias"), "junction");
      symlinkSync(path.join(root, "links", "gone"), path.join(root, "links", "dangling"), "junction");
    } catch {
      return; // links need a privilege some systems do not give
    }
    expect((await listFolder(path.join(root, "links"))).folders.map((f) => f.name)).toEqual(["alias", "real"]);
  });

  it("stops at a thousand folders and says there are more", async () => {
    for (let i = 0; i < 1005; i++) make("many", `f${String(i).padStart(4, "0")}`);
    const listing = await listFolder(path.join(root, "many"));
    expect(listing.folders).toHaveLength(1000);
    expect(listing.truncated).toBe(true);
  });

  it("explains what is wrong with a path the person typed", async () => {
    writeFileSync(path.join(root, "a-file.txt"), "x");
    expect(await code(listFolder("photos/relative"))).toBe("RELATIVE");
    expect(await code(listFolder(""))).toBe("RELATIVE");
    expect(await code(listFolder(`${root}\0evil`))).toBe("RELATIVE");
    expect(await code(listFolder(path.join(root, "x".repeat(5000))))).toBe("RELATIVE");
    expect(await code(listFolder(path.join(root, "does-not-exist")))).toBe("MISSING");
    expect(await code(listFolder(path.join(root, "a-file.txt")))).toBe("NOT_A_FOLDER");
  });
});

describe("checking a folder", () => {
  it("gives the folder's full path when it can be opened, without listing it", async () => {
    make("check", "inner");
    expect(await checkFolder(path.join(root, "check", "inner", ".."))).toBe(path.join(root, "check"));
  });

  it("says what is wrong when it cannot", async () => {
    writeFileSync(path.join(root, "check-file.txt"), "x");
    expect(await code(checkFolder("relative/path"))).toBe("RELATIVE");
    expect(await code(checkFolder(path.join(root, "check-missing")))).toBe("MISSING");
    expect(await code(checkFolder(path.join(root, "check-file.txt")))).toBe("NOT_A_FOLDER");
  });
});

describe("making a folder", () => {
  it("makes it inside the folder given and reports where", async () => {
    make("mk");
    const made = await createFolder(path.join(root, "mk"), "  Edited  ");
    expect(made).toEqual({ name: "Edited", path: path.join(root, "mk", "Edited") });
    expect((await listFolder(path.join(root, "mk"))).folders.map((f) => f.name)).toEqual(["Edited"]);
  });

  it("refuses names that are not a single usable name, and folders that exist or have no parent", async () => {
    make("mk2", "taken");
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "a:b", "what?", "star*", 'quote"', "pipe|", "tab\tname", "dot.", "CON", "nul.txt", "x".repeat(101)]) {
      expect(await code(createFolder(path.join(root, "mk2"), bad)), JSON.stringify(bad)).toBe("BAD_NAME");
    }
    expect(await code(createFolder(path.join(root, "mk2"), "taken"))).toBe("EXISTS");
    expect(await code(createFolder(path.join(root, "no-such-parent"), "x"))).toBe("MISSING");
    expect(await code(createFolder("relative", "x"))).toBe("RELATIVE");
  });
});

describe("where to start", () => {
  it("offers the usual photo places that exist, once each, with the pictures folder in OneDrive when that is where it is", async () => {
    make("home1", "Desktop");
    make("home1", "Downloads");
    make("home1", "OneDrive", "Pictures");
    const { shortcuts, roots } = await places({ home: path.join(root, "home1"), platform: "linux" });
    expect(shortcuts.map((s) => [s.kind, path.basename(s.path)])).toEqual([["home", "home1"], ["desktop", "Desktop"], ["downloads", "Downloads"], ["pictures", "Pictures"], ["onedrive", "OneDrive"]]);
    expect(roots).toEqual([{ kind: "root", name: "/", path: "/" }]);
  });

  it("leaves out places that do not exist", async () => {
    make("home2");
    expect((await places({ home: path.join(root, "home2"), platform: "linux" })).shortcuts.map((s) => s.kind)).toEqual(["home"]);
  });

  it("starts in the pictures folder, else the home folder", async () => {
    make("home3", "Pictures");
    expect(await startFolder({ home: path.join(root, "home3") })).toBe(path.join(root, "home3", "Pictures"));
    expect(await startFolder({ home: path.join(root, "home2") })).toBe(path.join(root, "home2"));
  });

  it("lists the drives that answer on Windows", async () => {
    if (process.platform !== "win32") return;
    const { roots } = await places({ home: path.join(root, "home2") });
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((d) => d.kind === "drive" && /^[A-Z]:\\$/.test(d.path))).toBe(true);
    expect(roots.some((d) => d.path === `${path.parse(root).root.slice(0, 1).toUpperCase()}:\\`)).toBe(true);
  });
});
