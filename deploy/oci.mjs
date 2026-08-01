#!/usr/bin/env node
// deploy/oci.mjs — zero-dep Oracle Cloud API client for deploying TLSBot.
//
// Auth: draft-cavage HTTP signatures (RSA-SHA256) with the API key from
// ~/.oci/config — the same auth the official SDK/CLI uses, minus the SDK.
//
//   node deploy/oci.mjs auth            sanity: list availability domains
//   node deploy/oci.mjs discover        VCNs, public subnets, instances
//   node deploy/oci.mjs launch          try A1 (1 OCPU/6GB) in every AD, fall
//                                       back to E2.1.Micro; waits for RUNNING;
//                                       prints the public IP
//   node deploy/oci.mjs ip <instanceId> print an instance's public IP
import { readFileSync } from "node:fs";
import { createHash, createSign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const cfgPath = join(homedir(), ".oci", "config");
const cfg = {};
for (const line of readFileSync(cfgPath, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  const eq = t.indexOf("=");
  if (eq > 0 && !t.startsWith("[") && !t.startsWith("#"))
    cfg[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}
const PRIVATE_KEY = readFileSync(cfg.key_file, "utf8");
const IAAS = `iaas.${cfg.region}.oraclecloud.com`;
const IDENTITY = `identity.${cfg.region}.oraclecloud.com`;
const API = "/20160918";

async function oci(method, host, path, body) {
  const url = new URL(`https://${host}${path}`);
  const date = new Date().toUTCString();
  const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  let signedHeaders = ["date", "(request-target)", "host"];
  const headers = { date, host: url.host };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["x-content-sha256"] = createHash("sha256")
      .update(payload)
      .digest("base64");
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
    signedHeaders = [
      "date",
      "(request-target)",
      "host",
      "x-content-sha256",
      "content-type",
      "content-length",
    ];
  }
  const signingString = signedHeaders
    .map((h) =>
      h === "(request-target)"
        ? `(request-target): ${target}`
        : `${h}: ${headers[h]}`,
    )
    .join("\n");
  const signature = createSign("RSA-SHA256")
    .update(signingString)
    .sign(PRIVATE_KEY, "base64");
  headers.authorization = `Signature version="1",keyId="${cfg.tenancy}/${cfg.user}/${cfg.fingerprint}",algorithm="rsa-sha256",headers="${signedHeaders.join(" ")}",signature="${signature}"`;
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(
      `OCI ${res.status} ${method} ${url.pathname}: ${text.slice(0, 300)}`,
    );
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = cfg.tenancy;

async function listADs() {
  return oci("GET", IDENTITY, `${API}/availabilityDomains/?compartmentId=${T}`);
}
async function listVcns() {
  return oci("GET", IAAS, `${API}/vcns?compartmentId=${T}`);
}
async function listSubnets(vcnId) {
  return oci("GET", IAAS, `${API}/subnets?compartmentId=${T}&vcnId=${vcnId}`);
}
async function listInstances() {
  return oci("GET", IAAS, `${API}/instances?compartmentId=${T}`);
}
async function latestImage(shape) {
  const imgs = await oci(
    "GET",
    IAAS,
    `${API}/images?compartmentId=${T}&operatingSystem=${encodeURIComponent("Canonical Ubuntu")}&shape=${encodeURIComponent(shape)}&sortBy=TIMECREATED&sortOrder=DESC&limit=10`,
  );
  return (
    imgs.find((i) => i.operatingSystemVersion?.startsWith("24.04")) || imgs[0]
  );
}

// Build the minimal public network: VCN -> internet gateway -> default route
// 0.0.0.0/0 via IG -> public subnet. The default security list already allows
// SSH in (22) and everything out, which is all this bot needs. Idempotent:
// reuses anything that already exists.
async function ensureNetwork() {
  let vcn = (await listVcns()).find((v) =>
    ["AVAILABLE", "PROVISIONING"].includes(v.lifecycleState),
  );
  if (!vcn) {
    vcn = await oci("POST", IAAS, `${API}/vcns`, {
      cidrBlock: "10.0.0.0/16",
      compartmentId: T,
      displayName: "tlsbot-vcn",
    });
    console.log("created VCN", vcn.id);
    while (vcn.lifecycleState !== "AVAILABLE") {
      await sleep(3000);
      vcn = await oci("GET", IAAS, `${API}/vcns/${vcn.id}`);
    }
  } else console.log("reusing VCN", vcn.displayName);

  const igs = await oci(
    "GET",
    IAAS,
    `${API}/internetGateways?compartmentId=${T}&vcnId=${vcn.id}`,
  );
  let ig = igs[0];
  if (!ig) {
    ig = await oci("POST", IAAS, `${API}/internetGateways`, {
      compartmentId: T,
      vcnId: vcn.id,
      isEnabled: true,
      displayName: "tlsbot-ig",
    });
    console.log("created internet gateway", ig.id);
  } else console.log("reusing internet gateway");

  const rt = await oci(
    "GET",
    IAAS,
    `${API}/routeTables/${vcn.defaultRouteTableId}`,
  );
  if (!rt.routeRules.some((r) => r.destination === "0.0.0.0/0")) {
    await oci("PUT", IAAS, `${API}/routeTables/${rt.id}`, {
      routeRules: [
        {
          destination: "0.0.0.0/0",
          destinationType: "CIDR_BLOCK",
          networkEntityId: ig.id,
        },
      ],
    });
    console.log("default route -> internet gateway installed");
  } else console.log("default route already present");

  let sub = (await listSubnets(vcn.id)).find((s) => !s.prohibitPublicIpOnVnic);
  if (!sub) {
    sub = await oci("POST", IAAS, `${API}/subnets`, {
      cidrBlock: "10.0.0.0/24",
      compartmentId: T,
      vcnId: vcn.id,
      displayName: "tlsbot-public",
      routeTableId: vcn.defaultRouteTableId,
      prohibitPublicIpOnVnic: false,
    });
    console.log("created public subnet", sub.id);
    while (sub.lifecycleState !== "AVAILABLE") {
      await sleep(3000);
      sub = await oci("GET", IAAS, `${API}/subnets/${sub.id}`);
    }
  } else console.log("reusing public subnet", sub.displayName);
  return { vcn, subnet: sub };
}

const cmd = process.argv[2];

if (cmd === "auth") {
  const ads = await listADs();
  console.log("auth OK — availability domains:");
  for (const ad of ads) console.log(" ", ad.name);
} else if (cmd === "discover") {
  const vcns = await listVcns();
  for (const v of vcns) {
    console.log(`VCN: ${v.displayName} (${v.lifecycleState}) ${v.id}`);
    for (const s of await listSubnets(v.id))
      console.log(
        `  subnet: ${s.displayName} public=${!s.prohibitPublicIpOnVnic} route=${s.routeTableId.slice(-8)} ${s.id}`,
      );
  }
  for (const i of await listInstances())
    console.log(
      `instance: ${i.displayName} shape=${i.shape} state=${i.lifecycleState} ad=${i.availabilityDomain} ${i.id}`,
    );
} else if (cmd === "launch") {
  const sshKey = readFileSync(
    join(homedir(), ".ssh", "tlsbot_oracle.pub"),
    "utf8",
  ).trim();
  const ads = (await listADs()).map((a) => a.name);
  const { vcn, subnet: pub } = await ensureNetwork();
  console.log(`using VCN ${vcn.displayName}, subnet ${pub.displayName}`);

  const attempts = [
    ...ads.map((ad) => ({
      ad,
      shape: "VM.Standard.A1.Flex",
      shapeConfig: { ocpus: 1, memoryInGBs: 6 },
    })),
    { ad: ads[0], shape: "VM.Standard.E2.1.Micro" },
  ];

  let instance = null;
  for (const a of attempts) {
    const image = await latestImage(a.shape);
    console.log(
      `trying ${a.shape} in ${a.ad} (image ${image.displayName}) ...`,
    );
    try {
      instance = await oci("POST", IAAS, `${API}/instances/`, {
        availabilityDomain: a.ad,
        compartmentId: T,
        displayName: "tlsbot",
        shape: a.shape,
        ...(a.shapeConfig ? { shapeConfig: a.shapeConfig } : {}),
        sourceDetails: { sourceType: "image", imageId: image.id },
        createVnicDetails: { subnetId: pub.id, assignPublicIp: true },
        metadata: { ssh_authorized_keys: sshKey },
      });
      console.log(`LAUNCHED ${a.shape} in ${a.ad}: ${instance.id}`);
      break;
    } catch (e) {
      if (e.status === 500 && /capacity/i.test(e.message)) {
        console.log("  out of capacity — next");
        continue;
      }
      // Free-tier jank: micro launches 404 "NotAuthorizedOrNotFound" in this
      // tenancy despite a granted 2-core limit in AD-1 (observed 2026-08-01,
      // three image builds, limits API confirms the grant). Opaque by design;
      // treat as "not launchable right now" and keep cycling — it may clear.
      if (e.status === 404) {
        console.log("  404 NotAuthorizedOrNotFound — next");
        continue;
      }
      if (e.status === 429) {
        console.log("  rate limited — waiting 30s");
        await sleep(30000);
        continue;
      }
      throw e;
    }
  }
  if (!instance) throw new Error("every attempt was out of capacity");

  process.stdout.write("waiting for RUNNING ");
  for (;;) {
    await sleep(10000);
    const i = await oci("GET", IAAS, `${API}/instances/${instance.id}`);
    process.stdout.write(".");
    if (i.lifecycleState === "RUNNING") break;
    if (["TERMINATED", "TERMINATING"].includes(i.lifecycleState))
      throw new Error(`instance went ${i.lifecycleState}`);
  }
  console.log(" RUNNING");

  const atts = await oci(
    "GET",
    IAAS,
    `${API}/vnicAttachments?compartmentId=${T}&instanceId=${instance.id}`,
  );
  const vnic = await oci("GET", IAAS, `${API}/vnics/${atts[0].vnicId}`);
  console.log("PUBLIC IP:", vnic.publicIp);
} else if (cmd === "ip") {
  const atts = await oci(
    "GET",
    IAAS,
    `${API}/vnicAttachments?compartmentId=${T}&instanceId=${process.argv[3]}`,
  );
  const vnic = await oci("GET", IAAS, `${API}/vnics/${atts[0].vnicId}`);
  console.log(vnic.publicIp);
} else {
  console.log("usage: oci.mjs auth|discover|launch|ip <instanceId>");
}
