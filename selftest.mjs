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
	options.module.apply(ctx, options.config ?? {});
	return captured;
}

/** A fetch stand-in that records requests and answers with one canned body. */
function mockFetch(respond, captured) {
	return async (url, init) => {
		captured.requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
		const outcome = typeof respond === "function" ? respond(captured.requests.length) : respond;
		if (outcome instanceof Error) throw outcome;
		const status = outcome.status ?? 200;
		const body = outcome.body ?? outcome;
		return {
			ok: status >= 200 && status < 300,
			status,
			async json() {
				if (body instanceof Error) throw body;
				return body;
			},
			async text() {
				return JSON.stringify(body);
			}
		};
	};
}

/** The two decision protocols' canned success envelopes. */
const typesafeAnswers = (authorized, risk, objection, confidence = 0.9) => ({
	model: "jev-latest",
	answers: {
		authorized: { type: "noul", noul: authorized },
		risk: { type: "choice", choice: risk, confidence, probabilities: { low: 0.1, medium: 0.2, high: 0.7 } },
		objection: { type: "choice", choice: objection, confidence, probabilities: { none: 0.1, unauthorized: 0.2, scope: 0.1, destructive: 0.2, exfiltration: 0.2, unclear: 0.2 } }
	},
	usage: { input_tokens: 120, output_tokens: 6 }
});
const openaiAnswers = (authorized, risk, objection) => ({
	answers: [
		{ name: "authorized", type: "predicate", probability: authorized },
		{ name: "risk", type: "choice", choice: risk, confidence: 0.88, probabilities: { low: 0.1, medium: 0.2, high: 0.7 } },
		{ name: "objection", type: "choice", choice: objection, confidence: 0.91, probabilities: { none: 0.1, unauthorized: 0.2, scope: 0.1, destructive: 0.2, exfiltration: 0.2, unclear: 0.2 } }
	],
	usage: { input_tokens: 90, output_tokens: 5 }
});

/** Mount with the decision reviewer enabled over a recording fetch. */
function mountDecision(options, respond) {
	const requests = [];
	return {
		requests,
		captured: mount({
			module,
			...options,
			config: {
				mode: options.mode ?? "decision",
				decision: {
					api: options.api ?? "typesafe-system-one",
					apiKey: options.apiKey ?? "test-key",
					model: options.model,
					baseUrl: options.baseUrl,
					allowThreshold: options.allowThreshold,
					denyThreshold: options.denyThreshold,
					confirmDenials: options.confirmDenials,
					escalateOnTruncation: options.escalateOnTruncation,
					escalate: options.escalate,
					maxStateChars: options.maxStateChars,
					timeoutMs: options.timeoutMs,
					fetch: mockFetch(respond, { requests })
				}
			}
		})
	};
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

// --- decision-model reviewer (TypeSafe System One / OpenAI Decisions) --------
{
	// TypeSafe wire format: `{ model, state, questions }` to /v1/systemone, with a
	// `noul` yes/no question, and a high-confidence allow decided without a chat call.
	const { captured, requests } = mountDecision(
		{ preset: "auto-review", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.95, "low", "none")
	);
	const request = requestFor();
	check("decision (TypeSafe): confident allow -> allowed-once", await captured.handler(request, next), "allowed-once");
	check("decision (TypeSafe): exactly one HTTP request", requests.length, 1);
	check("decision (TypeSafe): posts to the systemone endpoint", requests[0].url, "https://api.typesafe.ai/v1/systemone");
	check("decision (TypeSafe): bearer authorization", requests[0].headers.authorization, "Bearer test-key");
	check("decision (TypeSafe): model from config", requests[0].body.model, "jev-latest");
	check("decision (TypeSafe): yes/no question uses noul", requests[0].body.questions.authorized.type, "noul");
	check("decision (TypeSafe): risk question is a choice", requests[0].body.questions.risk.type, "choice");
	check("decision (TypeSafe): state carries the pending action", requests[0].body.state.pending_action.name, "write");
	checkThat("decision (TypeSafe): state carries the task history", Array.isArray(requests[0].body.state.history) && requests[0].body.state.history.some((entry) => JSON.stringify(entry).includes("Refactor the plugin loader")), JSON.stringify(requests[0].body.state.history).slice(0, 200));
	check("decision (TypeSafe): no chat model call", captured.streamOptions.length, 0);
}
{
	// OpenAI Decisions wire format: `{ model, input, questions }` to /v1/decisions,
	// `questions` as an array, yes/no as `predicate`, state as JSON text. Denial
	// confirmation is off here so the classifier's own reason is what travels.
	const { captured, requests } = mountDecision(
		{ preset: "auto-review", api: "openai-decisions", confirmDenials: false, decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		openaiAnswers(0.04, "medium", "scope")
	);
	const request = requestFor();
	check("decision (OpenAI): confident deny -> rejected", await captured.handler(request, next), "rejected");
	check("decision (OpenAI): posts to the decisions endpoint", requests[0].url, "https://api.openai.com/v1/decisions");
	check("decision (OpenAI): questions are an array", Array.isArray(requests[0].body.questions), true);
	check("decision (OpenAI): yes/no question is a predicate", requests[0].body.questions[0].type, "predicate");
	checkThat("decision (OpenAI): predicate folds the meanings into instructions", String(requests[0].body.questions[0].instructions).includes("True means:"), String(requests[0].body.questions[0].instructions).slice(0, 60));
	checkThat("decision (OpenAI): state is sent as JSON text", typeof requests[0].body.input === "string" && JSON.parse(requests[0].body.input).pending_action.name === "write", typeof requests[0].body.input);
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision (OpenAI): the objection becomes the denial reason", mailed.includes("wider than this task authorizes") && mailed.includes("authorization probability at 4%"), mailed);
	check("decision (OpenAI): confirmation off makes no chat call", captured.streamOptions.length, 0);
}
{
	// Decision mode is bought for its cost: by default no path reaches the chat
	// model. Deny, uncertainty and service failure are all decided locally.
	const denied = mountDecision({ preset: "auto-review" }, typesafeAnswers(0.05, "medium", "unauthorized"));
	check("decision: default confident deny -> rejected", await denied.captured.handler(requestFor(), next), "rejected");
	check("decision: default confident deny makes zero chat calls", denied.captured.streamOptions.length, 0);
	const uncertain = mountDecision({ preset: "auto-review" }, typesafeAnswers(0.55, "medium", "none"));
	const uncertainRequest = requestFor();
	check("decision: default uncertain verdict fails closed", await uncertain.captured.handler(uncertainRequest, next), "rejected");
	check("decision: default uncertain verdict makes zero chat calls", uncertain.captured.streamOptions.length, 0);
	const uncertainMailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${uncertainRequest.agent.session.id}:write`) ?? "";
	checkThat("decision: default uncertain denial explains the confidence gap", uncertainMailed.includes("not confident enough"), uncertainMailed);
	const outage = mountDecision({ preset: "auto-review" }, { status: 500, body: {} });
	check("decision: default service error fails closed", await outage.captured.handler(requestFor(), next), "rejected");
	check("decision: default service error makes zero chat calls", outage.captured.streamOptions.length, 0);
}
{
	// Flaw 2 (no prose reason) is an opt-in: only confirmDenials=true pays a chat
	// review for the reason.
	const { captured } = mountDecision(
		{ preset: "auto-review", confirmDenials: true, decision: "{\"risk\":\"medium\",\"decision\":\"deny\",\"reason\":\"the chat reviewer found the target outside the workspace and no instruction authorizes that path\"}" },
		typesafeAnswers(0.08, "medium", "unauthorized")
	);
	const request = requestFor();
	check("decision: medium denial is confirmed -> rejected", await captured.handler(request, next), "rejected");
	check("decision: confirmation made exactly one chat call", captured.streamOptions.length, 1);
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision: the confirmed denial carries the chat reviewer's reason", mailed.includes("the chat reviewer found the target outside the workspace"), mailed);
}
{
	// The stronger reviewer may override a wrong cheap denial.
	const { captured } = mountDecision(
		{ preset: "auto-review", confirmDenials: true, decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.08, "medium", "scope")
	);
	check("decision: chat reviewer overrides a wrong cheap denial", await captured.handler(requestFor(), next), "allowed-once");
	check("decision: the override was a chat call", captured.streamOptions.length, 1);
}
{
	// If confirmation fails, the cheap denial stands (fail closed) with its reason.
	const { captured } = mountDecision(
		{ preset: "auto-review", confirmDenials: true, streamThrows: true, decision: "{\"risk\":\"medium\",\"decision\":\"deny\"}" },
		typesafeAnswers(0.08, "medium", "scope")
	);
	const request = requestFor();
	check("decision: failed confirmation keeps the denial", await captured.handler(request, next), "rejected");
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision: failed confirmation keeps the classifier reason", mailed.includes("wider than this task authorizes"), mailed);
}
{
	// A hard-risk class denies even when the authorization probability is high.
	const { captured } = mountDecision({ preset: "auto-review" }, typesafeAnswers(0.99, "high", "exfiltration"));
	const request = requestFor();
	check("decision: high risk denies despite a high authorization probability", await captured.handler(request, next), "rejected");
	check("decision: a high-risk denial is final (no confirmation call)", captured.streamOptions.length, 0);
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision: high-risk denial explains the hard prohibition", mailed.includes("no session authorization can cover"), mailed);
	const text = contextTextFor(captured, request.agent);
	checkThat("decision: high-risk denial does not invite an authorization retry", !text.includes("the human must explicitly authorize"), text);
}
{
	// Regression: truncation escalation must not reopen a high-risk denial. The
	// chat stub answers allow, so a reordering bug shows up as a wrong allow.
	const extra = [];
	const extraNodes = [];
	for (let index = 2; index < 202; index += 1) {
		extra.push({ seq: index, type: "user/message", data: { source: { kind: "user", rpcId: `h${index}` }, content: [{ type: "text", text: "y".repeat(400) }] } });
		extraNodes.push(index);
	}
	const { captured } = mountDecision(
		{ preset: "auto-review", maxStateChars: 5000, escalateOnTruncation: true, decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.99, "high", "exfiltration")
	);
	const request = requestFor(makeAgent(extra, extraNodes));
	check("decision: truncated high-risk denial still rejects", await captured.handler(request, next), "rejected");
	check("decision: truncated high-risk denial makes no chat call", captured.streamOptions.length, 0);
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision: truncated high-risk denial keeps the hard-prohibition reason", mailed.includes("no session authorization can cover"), mailed);
}
{
	// Flaw 1 (less context) is an opt-in: escalateOnTruncation=true hands a
	// shed-history verdict to the full-context reviewer.
	const { captured, requests } = mountDecision(
		{ preset: "auto-review", escalate: "chat", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.55, "medium", "none")
	);
	check("decision: uncertain verdict escalates to the chat reviewer", await captured.handler(requestFor(), next), "allowed-once");
	check("decision: escalation made the chat model call", captured.streamOptions.length, 1);
	check("decision: escalation did not retry the decision API", requests.length, 1);
}
{
	// `escalate: deny` turns uncertainty into a fail-closed denial.
	const { captured } = mountDecision(
		{ preset: "auto-review", escalate: "deny", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.55, "medium", "none")
	);
	const request = requestFor();
	check("decision: uncertain with escalate=deny -> rejected", await captured.handler(request, next), "rejected");
	check("decision: uncertain with escalate=deny made no chat call", captured.streamOptions.length, 0);
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision: uncertain denial explains the confidence gap", mailed.includes("not confident enough"), mailed);
}
{
	// escalate: chat turns a decision-service failure into a chat review.
	const { captured, requests } = mountDecision(
		{ preset: "auto-review", escalate: "chat", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		{ status: 503, body: { error: "upstream unavailable" } }
	);
	check("decision: service error falls back to the chat reviewer", await captured.handler(requestFor(), next), "allowed-once");
	check("decision: service error escalated to one chat call", captured.streamOptions.length, 1);
	checkThat("decision: service error is logged", captured.logs.some(([level, message]) => level === "warn" && message.includes("decision reviewer") && message.includes("503")), JSON.stringify(captured.logs));
	check("decision: failed request was attempted once", requests.length, 1);
}
{
	// `escalate: deny` turns a service failure into the documented outage path.
	const { captured } = mountDecision(
		{ preset: "auto-review", escalate: "deny", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		{ status: 500, body: { error: "boom" } }
	);
	const request = requestFor();
	check("decision: service error with escalate=deny -> rejected", await captured.handler(request, next), "rejected");
	const mailed = globalThis[Symbol.for("auto-review-ww.denials")]?.get(`${request.agent.session.id}:write`) ?? "";
	checkThat("decision: outage reason reaches the tool-return mailbox", mailed.includes("reviewer outage"), mailed);
}
{
	// A malformed answer envelope is a failure, not a verdict.
	const { captured } = mountDecision(
		{ preset: "auto-review", escalate: "chat", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		{ answers: { authorized: { type: "noul", noul: 0.9 } } }
	);
	check("decision: malformed answers fall back to the chat reviewer", await captured.handler(requestFor(), next), "allowed-once");
	check("decision: malformed answers made the chat call", captured.streamOptions.length, 1);
}
{
	// Mode auto without an API key keeps the chat reviewer and never calls out.
	let called = 0;
	const { captured } = mountDecision({ preset: "auto-review", mode: "auto", apiKey: "", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" }, () => {
		called += 1;
		return typesafeAnswers(0.95, "low", "none");
	});
	check("decision: mode auto without a key -> chat allow", await captured.handler(requestFor(), next), "allowed-once");
	check("decision: mode auto without a key made no HTTP request", called, 0);
	check("decision: mode auto without a key made the chat call", captured.streamOptions.length, 1);
}
{
	// An invalid api id is reported at mount and degrades to the chat reviewer.
	const captured = mount({ module, preset: "auto-review", config: { mode: "decision", decision: { api: "nope", apiKey: "k" } }, decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" });
	checkThat("decision: unknown api id is reported", captured.logs.some(([level, message]) => level === "warn" && message.includes("is not one of")), JSON.stringify(captured.logs));
	check("decision: unknown api id keeps the chat reviewer", await captured.handler(requestFor(), next), "allowed-once");
}
{
	// Long history is shed from the oldest end to fit the state budget.
	const extra = [];
	const extraNodes = [];
	for (let index = 2; index < 202; index += 1) {
		extra.push({ seq: index, type: "user/message", data: { source: { kind: "user", rpcId: `r${index}` }, content: [{ type: "text", text: "x".repeat(400) }] } });
		extraNodes.push(index);
	}
	const agent = makeAgent(extra, extraNodes);
	const { captured, requests } = mountDecision(
		{ preset: "auto-review", maxStateChars: 5000, escalateOnTruncation: true, decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.96, "low", "none")
	);
	check("decision: truncated state escalates to the chat reviewer", await captured.handler(requestFor(agent), next), "allowed-once");
	check("decision: truncation escalation made the chat call", captured.streamOptions.length, 1);
	const state = requests[0].body.state;
	checkThat("decision: state fits the character budget", JSON.stringify(state).length <= 5000, `chars=${JSON.stringify(state).length}`);
	checkThat("decision: oldest history was shed", state.history.length < 100, `history=${state.history.length}`);
	checkThat("decision: the pending action survives truncation", state.pending_action.name === "write", JSON.stringify(state.pending_action?.name));
	const newest = state.history.at(-1);
	checkThat("decision: the newest evidence survives truncation", JSON.stringify(newest).includes("xxxxxxxx"), JSON.stringify(newest).slice(0, 80));
	const forced = mountDecision(
		{ preset: "auto-review", maxStateChars: 5000, escalateOnTruncation: false, decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" },
		typesafeAnswers(0.96, "low", "none")
	);
	check("decision: escalateOnTruncation=false keeps the decision verdict", await forced.captured.handler(requestFor(makeAgent(extra, extraNodes)), next), "allowed-once");
	check("decision: escalateOnTruncation=false makes no chat call", forced.captured.streamOptions.length, 0);
}
{
	// Every decision review is audited with its probability and escalation source.
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const logPath = path.join(os.tmpdir(), `auto-review-ww-decision-${process.pid}-${Date.now()}.log`);
	process.env.AUTO_REVIEW_WW_LOG_FILE = logPath;
	try {
		const { captured } = mountDecision({ preset: "auto-review", escalate: "chat", decision: "{\"risk\":\"low\",\"decision\":\"allow\"}" }, typesafeAnswers(0.55, "medium", "none"));
		await captured.handler(requestFor(), next);
		const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const review = lines.find((line) => line.kind === "review");
		check("decision audit: the escalated review is logged", review?.mode, "chat");
		check("decision audit: the escalation source is logged", review?.escalatedFrom, "decision-uncertain");
		check("decision audit: the decision probability is logged", review?.decisionProbability, 0.55);
		checkThat("decision audit: the deferral is logged", lines.some((line) => line.kind === "decision-defer" && line.probability === 0.55), JSON.stringify(lines.map((line) => line.kind)));
	} finally {
		delete process.env.AUTO_REVIEW_WW_LOG_FILE;
		try { fs.rmSync(logPath, { force: true }); } catch {}
	}
}

{
	// Tooling entry point: the same transport, usable outside an approval flow.
	const requests = [];
	const verdict = await module.probeDecisionModel({
		cwd: "D:\\proj",
		projectInstructions: [],
		history: [],
		action: { mode: "native", name: "write", arguments: { file_path: "C:\\outside\\target.txt" } }
	}, {
		mode: "decision",
		decision: { api: "typesafe-system-one", apiKey: "test-key", fetch: mockFetch(typesafeAnswers(0.97, "low", "none"), { requests }) }
	});
	check("probe: returns the decision verdict", verdict.kind, "allow");
	check("probe: reports the calibrated probability", verdict.probability, 0.97);
	check("probe: went through the same endpoint", requests[0].url, "https://api.typesafe.ai/v1/systemone");
	let probeFailed = false;
	try {
		await module.probeDecisionModel({ cwd: "x", projectInstructions: [], history: [], action: {} }, { mode: "decision", decision: { api: "typesafe-system-one", apiKey: "" } });
	} catch {
		probeFailed = true;
	}
	check("probe: an unconfigured probe fails loudly", probeFailed, true);
}

console.log(failures === 0 ? "\nALL dsh-auto-review-ww CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;








