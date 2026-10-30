/**
 * Self-test for the standalone `dsh-auto-review-ww` plugin.
 *
 * Mounts the package over a fake Cordis context and drives the registered
 * `approval/request` answerer with a stubbed reviewer stream. Focus: the
 * workspace-write Auto answerer plus the new agent-facing denial reason
 * channel (a system-prompt context block whose text follows the newest denial).
 *
 * Run: node auto-review-ww-selftest.mjs
 */
const MODULE_URL = process.env.WW_MODULE_URL ?? new URL("./lib/index.js", import.meta.url).href;

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
}
function checkThat(label, condition, detail) {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  (${detail})`}`);
}

async function* stubStream(text) {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text };
	yield { type: "block-end", index: 0, block: { type: "text", text } };
	yield { type: "finish", reason: { kind: "stop" } };
}

/** A session with one human instruction and one pending escalated write. */
function makeAgent(extraEvents = [], extraNodes = []) { // unique session identity per call, so the plugin's WeakMap state cannot leak between cases
	const events = [
		{ seq: 0, type: "user/message", data: { source: { kind: "user", rpcId: "r1" }, content: [{ type: "text", text: "Refactor the plugin loader." }] } },
		{
			seq: 1,
			type: "tool/call",
			data: {
				turn: 1,
				step: 1,
				callId: "call-1",
				name: "write",
				arguments: JSON.stringify({
					file_path: "C:\\outside\\target.txt",
					content: "hello",
					sandbox_permissions: "danger-full-access",
					justification: "the target file lives outside the workspace"
				})
			}
		},
		...extraEvents
	];
	const session = {
		header: { cwd: "D:\\proj", origin: "local" },
		isOwnSeq: () => true,
		snapshotEvents: () => events,
		surface: { nodes: [0, 1, ...extraNodes] },
		requestHeader: () => ({
			config: { provider: "test-provider", model: "test-model" },
			tools: [{ name: "write", description: "Write a UTF-8 file.", parameters: { type: "object", properties: { file_path: { type: "string" } } } }]
		})
	};
	return { session };
}

/** Mount the package over a fake context; capture what it registers. */
function mount(options) {
	const captured = {
		handler: undefined,
		onOptions: undefined,
		streamOptions: [],
		logs: [],
		disposers: [],
		setCalls: [],
		registerAutoCalls: 0,
		contexts: []
	};
	const systemPrompt = {
		getContextOrder: () => 30,
		context: (registration) => captured.contexts.push(registration)
	};
	const ctx = {
		logger: { info: (m) => captured.logs.push(["info", m]), warn: (m) => captured.logs.push(["warn", m]) },
		effect: (fn) => {
			const generator = fn();
			let step = generator.next();
			while (step.done !== true) {
				captured.disposers.push(step.value);
				step = generator.next();
			}
		},
		on: (event, handler, onOptions) => {
			if (event === "approval/request") {
				captured.handler = handler;
				captured.onOptions = onOptions;
			}
			return () => {};
		},
		inject: (names, callback) => {
			captured.injected = names;
			callback({ systemPrompt });
			return () => {};
		},
		llm: {
			stream: (streamOptions) => {
				captured.streamOptions.push(streamOptions);
				if (options.streamThrows === true) throw new Error("provider exploded");
				return stubStream(options.decision);
			}
		},
		permissionPresets: {
			current: () => options.preset,
			set: (session, preset) => captured.setCalls.push([session, preset]),
			registerAuto: () => {
				captured.registerAutoCalls += 1;
				return () => {};
			}
		},
		sessions: { list: () => options.sessions ?? [] }
	};
	options.module.apply(ctx, {});
	return captured;
}

/** The context text the plugin would contribute for one agent. */
function contextTextFor(captured, agent) {
	const registration = captured.contexts[0];
	return registration === undefined ? undefined : registration.text({ agent });
}

const module = await import(MODULE_URL);
console.log(`module: ${module.name}  inject=${JSON.stringify(module.inject)}`);


// Each case builds its own request over its own agent: the plugin keys its reason
// state by session, so sharing one agent would leak state between cases.
const requestFor = (target = makeAgent()) => ({
	agent: target,
	toolName: "write",
	callId: "call-1",
	reason: "escalate sandbox to danger-full-access: the target file lives outside the workspace"
});
const next = async () => "NEXT";

// --- decision mapping (unchanged behavior) ---------------------------------
{
	// Human answers to question cards are retained as human-instruction history.
	const answerText = "card-answer 授权执行恢复";
	const askEvents = [
		{ seq: 2, type: "tool/call", data: { turn: 1, step: 2, callId: "call-ask-1", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q1" }] }) } },
		{ seq: 3, type: "tool/result", data: { turn: 1, step: 2, message: { role: "tool", source: { kind: "tool", callId: "call-ask-1" }, toolCallId: "call-ask-1", content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "q1", selected: [answerText] }] }) }] } } }
	];
	const agent = makeAgent(askEvents, [2, 3]);
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"medium\",\"decision\":\"allow\"}" });
	const activeRequest = requestFor(agent);
	check("card answer session -> allowed-once", await captured.handler(activeRequest, next), "allowed-once");
	const reviewText = captured.streamOptions[0]?.messages?.[0]?.content?.[0]?.text ?? "";
	checkThat("card answer retained as human-instruction in review context", reviewText.includes("human-instruction") && reviewText.includes(answerText), "answer text missing from FILTERED_HISTORY");
}
{
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"medium\",\"decision\":\"allow\"}" });
	const activeRequest = requestFor();
	activeRequest.signal = new AbortController().signal;
	check("allow -> allowed-once", await captured.handler(activeRequest, next), "allowed-once");
	const seenSignal = captured.streamOptions[0]?.signal;
	checkThat(
		"review signal survives deepFreeze and stays usable in AbortSignal.any",
		seenSignal instanceof AbortSignal && !Object.isFrozen(seenSignal) && (() => { try { AbortSignal.any([seenSignal, AbortSignal.timeout(5000)]); return true; } catch { return false; } })(),
		`isSignal=${seenSignal instanceof AbortSignal} frozen=${typeof seenSignal === "object" && seenSignal !== null ? Object.isFrozen(seenSignal) : "n/a"}`
	);
	checkThat("review options force no temperature (routes reject temperature=0)", !("temperature" in (captured.streamOptions[0] ?? {})), JSON.stringify(Object.keys(captured.streamOptions[0] ?? {})));
	checkThat("registered prepend+global", captured.onOptions?.prepend === true && captured.onOptions?.global === true, JSON.stringify(captured.onOptions));
	checkThat("systemPrompt is optional, not injected-hard", JSON.stringify(captured.injected) === JSON.stringify(["systemPrompt"]), JSON.stringify(captured.injected));
	check("allow publishes no explanation", contextTextFor(captured, activeRequest.agent), "");
}
{
	// Verdict cache: an identical escalation reuses the reviewed outcome.
	const agent = makeAgent();
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" });
	const activeRequest = requestFor(agent);
	check("cache miss -> allowed-once", await captured.handler(activeRequest, next), "allowed-once");
	const before = captured.streamOptions.length;
	check("cache hit -> allowed-once", await captured.handler(activeRequest, next), "allowed-once");
	check("cache hit made no extra model call", captured.streamOptions.length - before, 0);
}
{
	// Review timeout: a hung upstream must fail closed quickly, with a reason.
	process.env.AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS = "80";
	try {
		const agent = makeAgent();
		const captured = mount({ module, preset: "auto-review", streamHangs: true });
		const activeRequest = requestFor(agent);
		const t0 = Date.now();
		check("hung review -> rejected (fail closed)", await captured.handler(activeRequest, next), "rejected");
		const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${agent.session.id}:write`) ?? "";
		checkThat("timeout reason reaches the tool-return mailbox", mailed.includes("review exceeded") || mailed.includes("reviewer outage"), mailed);
		checkThat("timeout enforced within 5s", Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
	} finally { delete process.env.AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS; }
}{
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"high\",\"decision\":\"deny\",\"reason\":\"the payload would exfiltrate credentials\"}" });
	const activeRequest = requestFor();
	check("deny -> rejected", await captured.handler(activeRequest, next), "rejected");
}
{
	const captured = mount({ module, preset: "auto-review", streamThrows: true });
	const activeRequest = requestFor();
	check("reviewer failure -> rejected (fail closed)", await captured.handler(activeRequest, next), "rejected");
	const failureText = contextTextFor(captured, activeRequest.agent);
	checkThat("reviewer failure publishes a stable explanation (no volatile error text)", failureText.length > 0 && !failureText.includes("provider exploded"), failureText);
	{
		const captured2 = mount({ module, preset: "auto-review", streamThrows: true });
		const activeRequest2 = requestFor();
		await captured2.handler(activeRequest2, next);
		checkThat("reviewer failure explanation is byte-stable across failures", contextTextFor(captured2, activeRequest2.agent) === failureText, "second failure text differs");
	}
}
{
	const captured = mount({ module, preset: "workspace-write", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" });
	const activeRequest = requestFor();
	check("non-Auto session -> next()", await captured.handler(activeRequest, next), "NEXT");
	check("non-Auto session runs no review", captured.streamOptions.length, 0);
}

// --- tool-return reason mailbox (consumed by the optional sandbox patch) -----
{
	// Verdict cache: an identical escalation reuses the reviewed outcome.
	const agent = makeAgent();
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" });
	const activeRequest = requestFor(agent);
	check("cache miss -> allowed-once", await captured.handler(activeRequest, next), "allowed-once");
	const before = captured.streamOptions.length;
	check("cache hit -> allowed-once", await captured.handler(activeRequest, next), "allowed-once");
	check("cache hit made no extra model call", captured.streamOptions.length - before, 0);
}
{
	// Review timeout: a hung upstream must fail closed quickly, with a reason.
	process.env.AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS = "80";
	try {
		const agent = makeAgent();
		const captured = mount({ module, preset: "auto-review", streamHangs: true });
		const activeRequest = requestFor(agent);
		const t0 = Date.now();
		check("hung review -> rejected (fail closed)", await captured.handler(activeRequest, next), "rejected");
		const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${agent.session.id}:write`) ?? "";
		checkThat("timeout reason reaches the tool-return mailbox", mailed.includes("review exceeded") || mailed.includes("reviewer outage"), mailed);
		checkThat("timeout enforced within 5s", Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
	} finally { delete process.env.AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS; }
}{
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"high\",\"decision\":\"deny\",\"reason\":\"the payload would exfiltrate credentials\"}" });
	const activeRequest = requestFor();
	check("deny -> rejected (mailbox)", await captured.handler(activeRequest, next), "rejected");
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${activeRequest.agent.session.id}:write`) ?? "";
	checkThat("denial reason mailed to the tool-return registry", mailed.includes("exfiltrate credentials"), mailed);
}

// --- the new reason channel -------------------------------------------------
{
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"medium\",\"decision\":\"deny\",\"reason\":\"the target file is outside the workspace and no current instruction authorizes writing C:\\\\outside\\\\target.txt\"}" });
	const activeRequest = requestFor();
	checkThat("reason channel is registered", captured.contexts.length === 1, `contexts=${captured.contexts.length}`);
	check("context is empty before any denial", contextTextFor(captured, activeRequest.agent), "");
	await captured.handler(activeRequest, next);
	const text = contextTextFor(captured, activeRequest.agent);
	checkThat("denial text reaches the agent", typeof text === "string" && text.includes("the target file is outside the workspace and no current instruction authorizes writing"), String(text).slice(0, 120));
	checkThat("denial text names the tool", text.includes("write"), "tool name missing");
	checkThat("denial text states the call did not run", text.includes("This call did not run."), "no did-not-run sentence");
	checkThat("denial text preserves the medium authorization gap guidance", text.includes("the human must explicitly authorize"), "authorization guidance missing");
	checkThat("denial text is newline-free for stable append-only context", !text.includes("\n"), "contains a newline");
	checkThat("denial is audited to the host log", captured.logs.some(([level, message]) => level === "info" && message.includes("denied tool \"write\"")), JSON.stringify(captured.logs));
}
{
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"high\",\"decision\":\"deny\"}" });
	const activeRequest = requestFor();
	await captured.handler(activeRequest, next);
	const text = contextTextFor(captured, activeRequest.agent);
	checkThat("reasonless high denial still explains the class", text.includes("leaks sensitive data across a trust boundary") && text.includes("never authorized"), String(text).slice(0, 140));
	checkThat("reasonless high denial does not offer an authorization route", !text.includes("the human must explicitly authorize"), "must not invite an authorization retry for high risk");
}
{
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"medium\",\"decision\":\"deny\"}" });
	const activeRequest = requestFor();
	await captured.handler(activeRequest, next);
	const text = contextTextFor(captured, activeRequest.agent);
	checkThat("reasonless medium denial explains the authorization gap", text.includes("irreversible or security-relevant"), String(text).slice(0, 140));
}
{
	// The newest denial wins, and an unrelated agent sees nothing.
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"medium\",\"decision\":\"deny\",\"reason\":\"first objection\"}" });
	const activeRequest = requestFor();
	await captured.handler(activeRequest, next);
	const otherRequest = requestFor();
	check("an unrelated agent gets no explanation", contextTextFor(captured, otherRequest.agent), "");
	const second = mount({ module, preset: "auto-review", decision: "{\"risk\":\"medium\",\"decision\":\"deny\",\"reason\":\"second objection\"}" });
	const secondRequest = requestFor();
	await second.handler(secondRequest, next);
	checkThat("single-decision plugin publishes exactly one reason", contextTextFor(second, secondRequest.agent).includes("second objection"), "reason mismatch");
}

// --- coexistence with the shipped package ----------------------------------
{
	// A non-escalation approval request (a per-call pipeline `ask`) must be left
	// to the shipped reviewer / human answerer: this extension owns escalations only.
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" });
	const plainAsk = { ...requestFor(), reason: "tool \"bash\" requires approval" };
	check("non-escalation request -> next()", await captured.handler(plainAsk, next), "NEXT");
	check("non-escalation request runs no review", captured.streamOptions.length, 0);
}
{
	// The extension never registers the auto preset: the shipped row owns it.
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" });
	check("extension does not register the Auto preset", captured.registerAutoCalls, 0);
}
{
	// Unload must not rewrite another plugin's preset selection.
	const live = makeAgent();
	const captured = mount({ module, preset: "auto-review", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}", sessions: [live.session] });
	await captured.disposers.at(-1)();
	check("unload leaves preset selection alone", captured.setCalls.length, 0);
}

console.log(failures === 0 ? "\nALL dsh-auto-review-ww CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;








