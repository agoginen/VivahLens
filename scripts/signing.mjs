#!/usr/bin/env node
// Release tooling for the signed documents the app trusts: the release manifest (one per channel) and the remote config.
// The signing key never leaves the machine that runs `sign`; the server only stores what is published (plan §7j).
//
//   node scripts/signing.mjs keygen  --out signing.pem [--kid k1]
//   node scripts/signing.mjs sign    --kind manifest|config --key signing.pem --kid k1 --in manifest.json [--out manifest.json.sig]
//   node scripts/signing.mjs verify  --kind manifest|config --keys '{"k1":"<base64>"}' --in manifest.json [--sig manifest.json.sig] [--channel stable]
//   node scripts/signing.mjs publish --server https://api.example --name updates-stable|config --in manifest.json [--sig manifest.json.sig]
//                                    (the admin key is read from VIVAH_ADMIN_KEY)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { parseArgs } from "node:util";
import { CONFIG_DOMAIN, MANIFEST_DOMAIN, rawPublicKey, signDocument, verifyManifest, verifyRemoteConfig, writePrivateFile } from "@vivahlens/core";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    kid: { type: "string", default: "k1" },
    kind: { type: "string" },
    key: { type: "string" },
    in: { type: "string" },
    sig: { type: "string" },
    keys: { type: "string" },
    channel: { type: "string" },
    server: { type: "string" },
    name: { type: "string" },
  },
});

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
const need = (name) => values[name] ?? fail(`--${name} is required`);
const domainOf = (kind) => ({ manifest: MANIFEST_DOMAIN, config: CONFIG_DOMAIN })[kind] ?? fail("--kind must be manifest or config");
const readKeys = (setting) => JSON.parse(setting.trim().startsWith("{") ? setting : readFileSync(setting, "utf8"));

const [command] = positionals;
switch (command) {
  case "keygen": {
    const out = need("out");
    if (existsSync(out)) fail(`${out} already exists; it is not overwritten`);
    const { privateKey } = generateKeyPairSync("ed25519");
    await writePrivateFile(out, privateKey.export({ type: "pkcs8", format: "pem" }));
    console.log(`Wrote the private key to ${out}. Keep it off any server, and back it up: without it no update can be signed.`);
    console.log(`Public key, for the app (VIVAH_UPDATE_KEYS or the embedded list): ${JSON.stringify({ [values.kid]: rawPublicKey(privateKey) })}`);
    break;
  }
  case "sign": {
    const domain = domainOf(need("kind"));
    const bytes = readFileSync(need("in"));
    const signature = signDocument(bytes, { privateKey: readFileSync(need("key"), "utf8"), kid: values.kid, domain });
    const out = values.out ?? `${values.in}.sig`;
    writeFileSync(out, JSON.stringify(signature));
    console.log(`Signed ${values.in} (${bytes.length} bytes) with key "${values.kid}" -> ${out}`);
    break;
  }
  case "verify": {
    const kind = need("kind");
    const domain = domainOf(kind);
    const bytes = readFileSync(need("in"));
    const signature = JSON.parse(readFileSync(values.sig ?? `${values.in}.sig`, "utf8"));
    const pinned = readKeys(need("keys"));
    try {
      if (kind === "manifest") {
        const { manifest } = verifyManifest({ bytes, signature, pinned, expectedChannel: values.channel ?? fail("--channel is required to verify a manifest") });
        console.log(`OK: ${manifest.channel} manifest, sequence ${manifest.sequence}, ${manifest.releases.length} release(s), expires ${manifest.expiresAt}`);
      } else {
        const { config } = verifyRemoteConfig({ bytes, signature, pinned });
        console.log(`OK: remote config, sequence ${config.sequence}, expires ${config.expiresAt}`);
      }
    } catch (err) {
      fail(`NOT VALID: ${err.message}`);
    }
    void domain;
    break;
  }
  case "publish": {
    const adminKey = process.env.VIVAH_ADMIN_KEY ?? fail("set VIVAH_ADMIN_KEY to the server's admin key");
    const bytes = readFileSync(need("in"));
    const signature = JSON.parse(readFileSync(values.sig ?? `${values.in}.sig`, "utf8"));
    const res = await fetch(new URL(`/admin/v1/documents/${need("name")}`, need("server")), {
      method: "PUT",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ bytesBase64: bytes.toString("base64"), signature }),
    });
    if (res.status !== 204) fail(`the server answered ${res.status}: ${await res.text()}`);
    console.log(`Published ${values.in} as "${values.name}".`);
    break;
  }
  default:
    fail("use one of: keygen, sign, verify, publish (see the comment at the top of this file)");
}
