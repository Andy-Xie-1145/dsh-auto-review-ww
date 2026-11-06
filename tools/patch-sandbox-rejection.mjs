#!/usr/bin/env node
// DEPRECATED — kept only for --revert on hosts that still carry the patch.
//
// Since v1.2.0 the denial reason reaches the tool return through a supported
// host seam (a `tools/post-execute` listener inside the plugin itself), which
// needs no host file modification and survives every Harness upgrade or
// reinstall. Do not apply this patch anymore; if a host still has it, run
// `--revert` once and rely on the built-in mechanism.
//
// WHAT IT CHANGED — exactly one line inside the installed
//   @deepseek-ai/dsh-sandbox/lib/index.js
// The host composes an escalation rejection as a fixed template that says
// "the user rejected escalating this ...", which is wrong when an automatic
// reviewer denied the call, and the approval outcome protocol carries no
// reason field. The patched line first consults a global registry
// (Symbol.for("auto-review-ww.denials")) that dsh-auto-review-ww populates
// with the reviewer's actual verdict; when an entry exists the tool return
// becomes "the Auto Reviewer denied escalating this <subject> to <mode>:
// <reason>", otherwise the stock message is kept verbatim.
//
// USAGE
//   node tools/patch-sandbox-rejection.mjs            # patch (idempotent)
//   node tools/patch-sandbox-rejection.mjs --revert   # restore original line
//   node tools/patch-sandbox-rejection.mjs --file <path>
//                                                  # explicit sandbox file
//
// Re-run after every DeepSeek Harness upgrade. The patch only adds a registry
// lookup; when dsh-auto-review-ww is absent (or did not deny) behavior is
// byte-identical to stock.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SENTINEL = "/* auto-review-ww:denial-reason */";
const REGISTRY = 'globalThis[Symbol.for("auto-review-ww.denials")]';
const ORIGINAL = '\t\tcase "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);';
const PATCHED = '\t\tcase "rejected": { const __arw = ' + REGISTRY + '?.get(`${approval.agent?.session?.id ?? ""}:${approval.toolName ?? ""}`); throw new Error(__arw ? `the Auto Reviewer denied escalating this ${subject} to "${mode}": ${__arw} (it stays denied; address the stated reason or ask the human)` : `the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`); } ' + SENTINEL;

function locateSandboxFile(explicit) {
	if (explicit) return explicit;
	let npmRoot = "";
	try { npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch {}
	const candidates = [
		npmRoot && path.join(npmRoot, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-sandbox", "lib", "index.js"),
		process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-sandbox", "lib", "index.js")
	].filter(Boolean);
	for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
	throw new Error("could not locate the installed dsh-sandbox; pass --file <path to lib/index.js>");
}

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const fileFlag = args.indexOf("--file");
const file = locateSandboxFile(fileFlag !== -1 ? args[fileFlag + 1] : undefined);

const source = fs.readFileSync(file, "utf8");
const alreadyPatched = source.includes(SENTINEL);

if (revert) {
	if (!alreadyPatched) { console.log(`no auto-review-ww patch present in ${file}`); process.exit(0); }
	fs.writeFileSync(file, source.replace(PATCHED, ORIGINAL), "utf8");
	console.log(`reverted: ${file}`);
} else if (alreadyPatched) {
	console.log(`already patched: ${file}`);
} else {
	if (!source.includes(ORIGINAL)) throw new Error(`the expected stock "rejected" line was not found in ${file}; the installed dsh-sandbox differs from the supported 0.2.0-rc.2 build — refusing to patch blindly`);
	fs.writeFileSync(file, source.replace(ORIGINAL, PATCHED), "utf8");
	console.log(`patched: ${file}`);
	console.log("escalation rejections for sessions running dsh-auto-review-ww now read");
	console.log('  "the Auto Reviewer denied escalating this <subject> to <mode>: <reason>"');
	console.log("re-apply after every DeepSeek Harness upgrade; revert with --revert");
}
