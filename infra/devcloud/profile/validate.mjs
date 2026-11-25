#!/usr/bin/env node
// Checks every devcloud profile an agentq placement may trust, against schema.v1.json.
//
// The schema is the single source of truth and this validator is generic over it - a
// hand-written check per field would be a second copy of the rules, and the copy is what
// drifts. Two things the schema cannot express are checked here as well, because both
// fail late and expensively otherwise:
//
//   1. A lane may only ask for a toolchain the image bakery declares. A profile that
//      names a family nobody bakes looks fine until a job lands on a VM that cannot
//      build, which costs a provisioning round to discover.
//   2. `dedicated: true`, or `concurrency: 1`, needs a `why`. Both are claims about
//      interference, and a reader six months from now has no way to tell a deliberate
//      one from a copy-paste.
//
// Usage:
//   node validate.mjs                 # every repo under E:\gh that has a profile
//   node validate.mjs --root E:\gh    # a different parent directory
//   node validate.mjs --live          # additionally ask GCE which families exist
//   node validate.mjs --selftest      # prove the checks catch what they claim to
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "schema.v1.json"), "utf8"));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// The toolchains the bakery knows: its build.json is the list, so a rebake is the only
// way a new one appears.
function declaredToolchains() {
    const build = JSON.parse(fs.readFileSync(path.join(here, "..", "images", "build.json"), "utf8"));
    const names = new Set();
    for (const step of build.steps || []) {
        const args = step.args || [];
        const at = args.indexOf("--toolchain");
        if (at >= 0 && args[at + 1]) names.add(args[at + 1]);
    }
    return names;
}

// Just enough JSON Schema for this document: type, required, const, enum, minItems,
// minProperties, minLength, additionalProperties (false | schema). Unknown keywords are
// ignored on purpose - the validator is not a general implementation, and pretending it
// were would make the schema look more portable than it is.
function check(node, value, at, errors) {
    if (node.const !== undefined && value !== node.const) errors.push(`${at}: must be ${JSON.stringify(node.const)}`);
    if (node.enum && !node.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${node.enum.join(", ")}`);
    if (node.type) {
        const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
        // "integer" is its own JSON Schema type; typeof says "number" for both 2 and 2.5.
        const ok = node.type === "integer" ? Number.isInteger(value) : actual === node.type;
        if (!ok) {
            errors.push(`${at}: expected ${node.type}, got ${actual}`);
            return;
        }
    }
    if (typeof value === "string" && node.minLength && value.length < node.minLength) {
        errors.push(`${at}: shorter than ${node.minLength}`);
    }
    if (typeof value === "number" && node.minimum !== undefined && value < node.minimum) {
        errors.push(`${at}: below ${node.minimum}`);
    }
    if (Array.isArray(value)) {
        if (node.minItems && value.length < node.minItems) errors.push(`${at}: needs at least ${node.minItems}`);
        if (node.items) value.forEach((item, i) => check(node.items, item, `${at}[${i}]`, errors));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (node.minProperties && keys.length < node.minProperties) errors.push(`${at}: needs at least ${node.minProperties} entries`);
        for (const key of node.required || []) {
            if (!(key in value)) errors.push(`${at}: missing "${key}"`);
        }
        const props = node.properties || {};
        for (const key of keys) {
            const sub = props[key];
            if (sub) check(sub, value[key], `${at}.${key}`, errors);
            else if (node.additionalProperties === false) errors.push(`${at}: "${key}" is not part of schema v1`);
            else if (node.additionalProperties && typeof node.additionalProperties === "object") {
                check(node.additionalProperties, value[key], `${at}.${key}`, errors);
            }
        }
    }
}

function checkProfile(profile, repoDir, known, errors) {
    check(schema, profile, "profile", errors);
    if (profile.repo && profile.repo !== path.basename(repoDir)) {
        errors.push(`profile.repo is "${profile.repo}" but the checkout is "${path.basename(repoDir)}"`);
    }
    for (const [lane, spec] of Object.entries(profile.lanes || {})) {
        for (const t of spec.toolchains || []) {
            if (!known.has(t)) {
                errors.push(`lanes.${lane}: toolchain "${t}" is not declared in images/build.json (known: ${[...known].sort().join(", ")})`);
            }
        }
        if ((spec.dedicated || spec.concurrency === 1) && !spec.why) {
            errors.push(`lanes.${lane}: dedicated/concurrency 1 needs a "why" - a claim about interference nobody can re-check later is noise`);
        }
    }
}

function profilesUnder(root) {
    const found = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const file = path.join(dir, ".devcloud", "profile.json");
        if (fs.existsSync(file)) found.push({ dir, file });
    }
    return found;
}

function liveFamilies() {
    try {
        const out = execFileSync("gcloud", ["compute", "images", "list", "--project", "codai-training", "--no-standard-images", "--filter", "family~^devcloud-ci-", "--format", "json"], { encoding: "utf8", timeout: 60000 });
        const fams = new Set(JSON.parse(out).map((i) => String(i.family).replace(/^devcloud-ci-/, "")));
        return fams;
    } catch {
        return null;
    }
}

function main() {
    const root = value("root", "E:\\gh");
    const known = declaredToolchains();
    const live = flag("live") ? liveFamilies() : null;
    const repos = profilesUnder(root);
    let bad = 0;
    if (!repos.length) {
        console.log(`no .devcloud/profile.json under ${root}`);
    }
    for (const { dir, file } of repos) {
        const errors = [];
        let profile = null;
        try {
            profile = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
            errors.push(`not valid JSON: ${e.message}`);
        }
        if (profile) checkProfile(profile, dir, known, errors);
        const name = path.basename(dir);
        if (errors.length) {
            bad++;
            console.log(`FAIL ${name}`);
            for (const e of errors) console.log(`     ${e}`);
            continue;
        }
        console.log(`OK   ${name}  (${Object.keys(profile.lanes).length} lanes, keep ${profile.keep?.length ?? 0}, secrets ${profile.secrets?.length ?? 0})`);
        for (const [lane, spec] of Object.entries(profile.lanes)) {
            const baked = live ? (spec.toolchains.every((t) => live.has(t)) ? "baked" : "NOT BAKED") : "-";
            console.log(`     ${lane.padEnd(9)} ${spec.machine.padEnd(17)} x${spec.concurrency} ${String(spec.timeoutMin ?? "?").padStart(3)}min ${spec.dedicated ? "dedicated" : "shareable"}  ${baked}  [${spec.toolchains.join(" ")}]`);
        }
    }
    if (live) {
        const missing = [...known].filter((t) => !live.has(t));
        console.log(`families in GCE: ${[...live].sort().join(", ") || "none"}`);
        if (missing.length) console.log(`declared but not baked: ${missing.sort().join(", ")}`);
    }
    process.exit(bad ? 1 : 0);
}

function selftest() {
    const known = declaredToolchains();
    const good = { v: 1, repo: "demo", lanes: { ts: { toolchains: ["node24"], machine: "c4d-standard-8", concurrency: 2 } }, keep: [], secrets: [] };
    const cases = [
        ["a profile the schema accepts", good, false],
        ["an unknown toolchain", { ...good, lanes: { ts: { toolchains: ["nope"], machine: "c4d-standard-8", concurrency: 2 } } }, true],
        ["a missing v", { repo: "demo", lanes: good.lanes }, true],
        ["concurrency 1 with no why", { ...good, lanes: { ts: { toolchains: ["node24"], machine: "c4d-standard-8", concurrency: 1 } } }, true],
        ["dedicated with a why", { ...good, lanes: { ts: { toolchains: ["node24"], machine: "c4d-standard-8", concurrency: 1, dedicated: true, why: "because" } } }, false],
        ["a key from a future version", { ...good, extra: true }, true],
        ["a repo that does not match its directory", { ...good, repo: "somewhere-else" }, true],
        ["a lane with no machine", { ...good, lanes: { ts: { toolchains: ["node24"] } } }, true],
        ["a secret value where a name belongs", { ...good, secrets: [{ name: "x" }] }, true],
    ];
    let failed = 0;
    for (const [name, profile, shouldFail] of cases) {
        const errors = [];
        checkProfile(profile, path.join("C:\\fake", "demo"), known, errors);
        const caught = errors.length > 0;
        if (caught !== shouldFail) {
            failed++;
            console.log(`FAIL selftest: ${name} - expected ${shouldFail ? "failure" : "acceptance"}, got the opposite`);
        } else {
            console.log(`ok   ${name}${caught ? ` -> ${errors[0]}` : ""}`);
        }
    }
    console.log(failed ? `SELFTEST FAILED (${failed})` : "SELFTEST OK");
    process.exit(failed ? 1 : 0);
}

if (flag("selftest")) selftest();
else main();