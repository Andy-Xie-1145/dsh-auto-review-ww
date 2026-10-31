#!/usr/bin/env node
/**
 * Probe the decision-model reviewer without waiting for a real escalation.
 *
 * It sends one review-shaped snapshot through the plugin's own transport and
 * prints the verdict, so an API key, model id or base URL can be validated
 * before it is trusted in production. The key comes from the environment
 * (`TYPESAFE_API_KEY` / `OPENAI_API_KEY`) unless `--api-key` is passed.
 *
 * Usage:
 *   node tools/probe-decision.mjs
 *   node tools/probe-decision.mjs --api openai-decisions
 *   node tools/probe-decision.mjs --task "Delete the stale build cache"
 *   node tools/probe-decision.mjs --api-key sk-... --model jev-latest
 *
 * Flags: --api, --model, --base-url, --api-key, --api-key-env,
 *        --allow-threshold, --deny-threshold, --task, --json
 */
import { probeDecisionModel } from "../lib/index.js";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] !== void 0 ? argv[index + 1] : fallback;
};

const config = {
	mode: "decision",
	decision: {
		api: flag("api", "typesafe-system-one"),
		model: flag("model"),
		baseUrl: flag("base-url"),
		apiKey: flag("api-key"),
		apiKeyEnv: flag("api-key-env"),
		allowThreshold: flag("allow-threshold"),
		denyThreshold: flag("deny-threshold"),
		/* The probe reports the raw verdict; it never needs a chat fallback. */
		escalate: "deny"
	}
};

const snapshot = {
	cwd: process.cwd(),
	projectInstructions: [],
	history: [{
		kind: "user-message",
		role: "human-instruction",
		source: { kind: "user", rpcId: "probe" },
		content: [{ type: "text", text: flag("task", "Refactor the plugin loader and fix the failing tests.") }]
	}],
	action: {
		mode: "native",
		name: "write",
		description: "Write a UTF-8 file.",
		parameters: { type: "object", properties: { file_path: { type: "string" } } },
		arguments: {
			file_path: "C:\\outside\\target.txt",
			content: "hello",
			sandbox_permissions: "danger-full-access",
			justification: "the target file lives outside the workspace"
		},
		approvalReason: "escalate sandbox to danger-full-access: the target file lives outside the workspace"
	}
};

try {
	const verdict = await probeDecisionModel(snapshot, config);
	if (argv.includes("--json")) {
		console.log(JSON.stringify(verdict, null, 2));
	} else {
		console.log(`api        ${verdict.api}`);
		console.log(`model      ${verdict.model}`);
		console.log(`kind       ${verdict.kind}${verdict.kind === "defer" ? "  (between thresholds; a live review would escalate)" : ""}`);
		if (verdict.risk !== void 0) console.log(`risk       ${verdict.risk}`);
		if (verdict.decision !== void 0) console.log(`decision   ${verdict.decision}`);
		if (verdict.reason !== void 0) console.log(`reason     ${verdict.reason}`);
		console.log(`answers    authorized=${verdict.probability} risk=${verdict.riskAnswer} objection=${verdict.objection}`);
		console.log(`state      ${verdict.payloadChars} chars${verdict.truncated > 0 ? ` (${verdict.truncated} history entries shed)` : ""}`);
		console.log(`elapsed    ${verdict.elapsedMs} ms`);
		if (verdict.usage !== void 0) console.log(`usage      ${verdict.usage.inputTokens ?? "?"} input tokens`);
	}
} catch (error) {
	console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
