import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentUserSid, ensurePrivateDir, forgetUserSid, isCurrentUserOnly, isOwnerOnly, parseAces, restrictToCurrentUser, writePrivateFile } from "./privateFile.js";
import { nodeRunner, scriptedRunner, type ScriptedStep } from "./runner.js";

const SID = "S-1-12-1-1111111111-2222222222-3333333333-4444444444";
const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-private-"));
  temps.push(dir);
  return dir;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
beforeEach(() => forgetUserSid());

const whoami: ScriptedStep = { when: (c) => c.toLowerCase().endsWith("whoami.exe"), reply: { stdout: Buffer.from(`"contoso\\jane","${SID}"\r\n`) } };
const isIcacls = (c: string) => c.toLowerCase().endsWith("icacls.exe");

describe("access lists", () => {
  it("reads the entries of a real access list and accepts only one that grants the current user and nobody else", () => {
    expect(parseAces(`D:PAI(A;;FA;;;${SID})`)).toEqual([{ type: "A", flags: "", rights: "FA", trustee: SID }]);
    expect(isOwnerOnly(`D:PAI(A;;FA;;;${SID})`, SID)).toBe(true);
    expect(isOwnerOnly(`D:AI(A;ID;FA;;;${SID})`, SID)).toBe(true);
    expect(isOwnerOnly(`D:P(A;;FA;;;${SID})S:AI(AU;SA;FA;;;WD)`, SID)).toBe(true);
    // What a file keeps when only a grant (and no inheritance removal) was applied: SYSTEM and Administrators still in.
    expect(isOwnerOnly(`D:AI(A;;0x12019f;;;${SID})(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SID})`, SID)).toBe(false);
    expect(isOwnerOnly(`D:P(A;;FA;;;${SID})(A;;FR;;;WD)`, SID)).toBe(false);
    expect(isOwnerOnly(`D:P(D;;FA;;;BG)(A;;FA;;;${SID})`, SID)).toBe(false);
    expect(isOwnerOnly(`D:P(A;;FA;;;S-1-5-21-1-2-3-1001)`, SID)).toBe(false);
    expect(isOwnerOnly("D:PAI", SID)).toBe(false);
    expect(isOwnerOnly("", SID)).toBe(false);
  });

  it("accepts the short names SDDL uses for a few accounts when they are this user, and only then", () => {
    const administrator = "S-1-5-21-1-2-3-500";
    // The built-in Administrator is written LA and the guest account LG, not as a SID, and the service accounts likewise.
    expect(isOwnerOnly("D:PAI(A;;FA;;;LA)", administrator)).toBe(true);
    expect(isOwnerOnly(`D:P(A;;FA;;;LA)(A;;FA;;;${administrator})`, administrator)).toBe(true);
    expect(isOwnerOnly("D:PAI(A;;FA;;;LG)", "S-1-5-21-1-2-3-501")).toBe(true);
    expect(isOwnerOnly("D:PAI(A;;FA;;;SY)", "S-1-5-18")).toBe(true);
    expect(isOwnerOnly("D:PAI(A;;FA;;;LS)", "S-1-5-19")).toBe(true);
    expect(isOwnerOnly("D:PAI(A;;FA;;;NS)", "S-1-5-20")).toBe(true);

    // Never for a different account, never for a group, and never for a name that is not a SID or an alias at all.
    expect(isOwnerOnly("D:PAI(A;;FA;;;LA)", "S-1-5-21-1-2-3-1001")).toBe(false);
    expect(isOwnerOnly("D:PAI(A;;FA;;;LA)", SID)).toBe(false);
    expect(isOwnerOnly("D:PAI(A;;FA;;;LG)", administrator)).toBe(false);
    expect(isOwnerOnly("D:PAI(A;;FA;;;SY)", SID)).toBe(false);
    expect(isOwnerOnly("D:PAI(A;;FA;;;LS)", "S-1-5-20")).toBe(false);
    expect(isOwnerOnly("D:P(A;;FA;;;LA)(A;;FA;;;BA)", administrator)).toBe(false);
    expect(isOwnerOnly("D:P(A;;FA;;;LA)(A;;FA;;;SY)", administrator)).toBe(false);
    expect(isOwnerOnly("D:P(A;;FA;;;LA)(A;;FR;;;WD)", administrator)).toBe(false);
    expect(isOwnerOnly("D:PAI(A;;FA;;;constructor)", administrator)).toBe(false);
    expect(isOwnerOnly("D:PAI(A;;FA;;;__proto__)", administrator)).toBe(false);
  });

  it("finds the account's SID, remembers it, and refuses to guess when it cannot", async () => {
    const { run, calls } = scriptedRunner([whoami]);
    expect(await currentUserSid(run)).toBe(SID);
    expect(await currentUserSid(run)).toBe(SID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["/user", "/fo", "csv", "/nh"]);

    forgetUserSid();
    await expect(currentUserSid(scriptedRunner([{ when: () => true, reply: { stdout: Buffer.from("garbage") } }]).run)).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED" });
    await expect(currentUserSid(scriptedRunner([{ when: () => true, reply: { code: 1 } }]).run)).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED" });
  });

  it("resets a file's list and then restricts it with the numeric SID, and does the same for a folder so what is made in it inherits only that", async () => {
    const { run, calls } = scriptedRunner([whoami, { when: (c) => isIcacls(c), reply: {} }]);
    await restrictToCurrentUser("C:\\data\\license.json", { run });
    await restrictToCurrentUser("C:\\data", { run, folder: true });
    expect(calls.filter((c) => isIcacls(c.command)).map((c) => c.args)).toEqual([
      ["C:\\data\\license.json", "/reset", "/Q"],
      ["C:\\data\\license.json", "/inheritance:r", "/grant:r", `*${SID}:F`, "/Q"],
      ["C:\\data", "/reset", "/Q"],
      ["C:\\data", "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "/Q"],
    ]);
    await expect(restrictToCurrentUser("x", { run: scriptedRunner([whoami, { when: (c) => isIcacls(c), reply: { code: 5, stderr: "Access is denied." } }]).run })).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED", message: expect.stringContaining("Access is denied.") });
    const secondFails = scriptedRunner([whoami, { when: (_c, args) => args.includes("/inheritance:r"), reply: { code: 5, stderr: "Not enough rights." } }, { when: (c) => isIcacls(c), reply: {} }]);
    await expect(restrictToCurrentUser("x", { run: secondFails.run })).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED", message: expect.stringContaining("Not enough rights.") });
  });
});

describe("writing a private file with a fake icacls", () => {
  /** icacls /save writes the access list as UTF-16 text to the file named after /save. */
  const icaclsThatSaves = (sddl: string): ScriptedStep => ({
    when: (c) => isIcacls(c),
    reply: (_c, args) => {
      const at = args.indexOf("/save");
      if (at >= 0) writeFileSync(args[at + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`file\r\n${sddl}\r\n`, "utf16le")]));
      return {};
    },
  });

  it("writes the secret only after the file's access list has been restricted and found to be the user's alone", async () => {
    const dir = temp();
    const file = path.join(dir, "license.json");
    const { run, calls } = scriptedRunner([whoami, icaclsThatSaves(`D:P(A;;FA;;;${SID})`)]);
    await writePrivateFile(file, '{"token":"s3cret"}', { run, platform: "win32" });
    expect(readFileSync(file, "utf8")).toBe('{"token":"s3cret"}');
    expect(calls.map((c) => (isIcacls(c.command) ? c.args[1] : "whoami"))).toEqual(["whoami", "/reset", "/inheritance:r", "/save"]);
    expect(readdirSync(dir)).toEqual(["license.json"]);
  });

  it("writes nothing, and leaves nothing behind, when the access list cannot be confirmed", async () => {
    const dir = temp();
    const file = path.join(dir, "license.json");
    writeFileSync(file, "the old contents");
    const { run } = scriptedRunner([whoami, icaclsThatSaves(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SID})`)]);
    await expect(writePrivateFile(file, "s3cret", { run, platform: "win32" })).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED" });
    expect(readFileSync(file, "utf8")).toBe("the old contents");
    expect(readdirSync(dir)).toEqual(["license.json"]);
  });

  it("does not reuse a temporary file that is already there", async () => {
    const dir = temp();
    const file = path.join(dir, "x.json");
    const { run } = scriptedRunner([whoami, icaclsThatSaves(`D:P(A;;FA;;;${SID})`)]);
    await writePrivateFile(file, "one", { run, platform: "win32" });
    await writePrivateFile(file, "two", { run, platform: "win32" });
    expect(readFileSync(file, "utf8")).toBe("two");
  });

  it("accepts a file icacls reports as LA when the user is the built-in Administrator, as on a build server", async () => {
    const dir = temp();
    const file = path.join(dir, "license.json");
    const asAdministrator: ScriptedStep = { when: (c) => c.toLowerCase().endsWith("whoami.exe"), reply: { stdout: Buffer.from('"host\\runneradmin","S-1-5-21-1-2-3-500"\r\n') } };
    const { run } = scriptedRunner([asAdministrator, icaclsThatSaves("D:PAI(A;;FA;;;LA)")]);
    await writePrivateFile(file, "s3cret", { run, platform: "win32" });
    expect(readFileSync(file, "utf8")).toBe("s3cret");
  });

  it("says which accounts it found when it refuses, without the numbers that identify a person or a computer", async () => {
    const dir = temp();
    const { run } = scriptedRunner([whoami, icaclsThatSaves(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(D;;FA;;;S-1-5-21-1-2-3-1001)(A;;FA;;;S-1-5-5-0-14554954)(A;ID;FA;;;${SID})`)]);
    const refused = writePrivateFile(path.join(dir, "license.json"), "s3cret", { run, platform: "win32" });
    // A computer's own account keeps its small RID; a work or school account and a logon session keep only what kind they are.
    await expect(refused).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED", message: expect.stringContaining("(found: SY, BA, a deny for S-1-5-21-…-1001, S-1-5-5-…, S-1-12-1-…)") });
    for (const identifying of ["1111111111", "2222222222", "3333333333", "4444444444", "14554954"]) {
      await expect(refused).rejects.not.toMatchObject({ message: expect.stringContaining(identifying) });
    }
  });
});

describe.skipIf(process.platform !== "win32")("private files on Windows, with the real icacls", () => {
  it("restricts a file to the current user and replaces it atomically, leaving no temporary files", async () => {
    const dir = temp();
    const file = path.join(dir, "secret.json");
    await writePrivateFile(file, "first");
    expect(await isCurrentUserOnly(file)).toBe(true);
    await writePrivateFile(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(await isCurrentUserOnly(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["secret.json"]);
    // An ordinary file in an ordinary folder keeps the folder's wider list, which is exactly what this guards against.
    const ordinary = path.join(dir, "ordinary.txt");
    writeFileSync(ordinary, "x");
    expect(await isCurrentUserOnly(ordinary)).toBe(false);
  }, 30_000);

  it("restricts a file made where its folder hands nothing down, which starts with the creating account's default entries (SYSTEM, and Administrators for an elevated process)", async () => {
    const dir = temp();
    const sid = await currentUserSid();
    // A folder whose one entry is not inherited: a new file there gets the process's default access list, as on a build server.
    const set = await nodeRunner(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [dir, "/inheritance:r", "/grant:r", `*${sid}:F`, "/Q"]);
    expect(set.code).toBe(0);
    const file = path.join(dir, "secret.json");
    await writePrivateFile(file, "s3cret");
    expect(readFileSync(file, "utf8")).toBe("s3cret");
    expect(await isCurrentUserOnly(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["secret.json"]);
  }, 30_000);

  it("makes a folder whose new files are born restricted, is idempotent, and refuses a folder it did not make that others can open", async () => {
    const parent = temp();
    const dir = path.join(parent, "secrets");
    await ensurePrivateDir(dir);
    await ensurePrivateDir(dir);
    expect(await isCurrentUserOnly(dir)).toBe(true);
    const born = path.join(dir, "new.txt");
    writeFileSync(born, "x");
    expect(await isCurrentUserOnly(born)).toBe(true);

    const open = path.join(parent, "already-there");
    mkdirSync(open);
    await expect(ensurePrivateDir(open)).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED" });
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("private files on POSIX", () => {
  it("creates the file with mode 0600 whatever the umask, replaces it, and checks folders are private and ours", async () => {
    const dir = temp();
    const file = path.join(dir, "secret.json");
    await writePrivateFile(file, "first");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await writePrivateFile(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["secret.json"]);

    const priv = path.join(dir, "private");
    await ensurePrivateDir(priv);
    expect(statSync(priv).mode & 0o777).toBe(0o700);
    const loose = path.join(dir, "loose");
    mkdirSync(loose, { mode: 0o755 });
    await expect(ensurePrivateDir(loose)).rejects.toMatchObject({ code: "FILE_PROTECTION_FAILED" });
  });
});

describe("nodeRunner", () => {
  it("passes input on stdin, collects binary output and the exit code, and never uses a shell", async () => {
    const echo = await nodeRunner(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdin: Buffer.from([0, 255, 10, 13, 65]) });
    expect(echo.code).toBe(0);
    expect([...echo.stdout]).toEqual([0, 255, 10, 13, 65]);

    const failing = await nodeRunner(process.execPath, ["-e", "console.error('bad'); process.exit(3)"]);
    expect(failing).toMatchObject({ code: 3, stderr: expect.stringContaining("bad"), timedOut: false });

    // A semicolon is just an argument: nothing interprets it.
    const literal = await nodeRunner(process.execPath, ["-p", "process.argv.slice(1).join('|')", "a;b", "$(whoami)", "x y"]);
    expect(literal.stdout.toString().trim()).toBe("a;b|$(whoami)|x y");
  });

  it("passes extra environment, times a child out, and reports a program that is not there", async () => {
    expect((await nodeRunner(process.execPath, ["-p", "process.env.VL_TEST"], { env: { VL_TEST: "hello" } })).stdout.toString().trim()).toBe("hello");
    const slow = await nodeRunner(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    const missing = await nodeRunner(path.join(os.tmpdir(), "no-such-program-vivah"), []);
    expect(missing.code).toBeNull();
    expect(missing.startError).toMatch(/ENOENT|not found/i);
    expect(existsSync(os.tmpdir())).toBe(true);
  });
});
