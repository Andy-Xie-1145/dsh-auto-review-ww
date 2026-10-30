//#region inlined host helpers
/**
* Deep-freeze one value, as `@deepseek-ai/dsh-util-values` does, so a reviewed
* snapshot cannot be mutated by a later consumer.
* @param value - the value to freeze in place.
* @returns the same value.
*/
function deepFreeze(value) {
	/* AbortSignal instances stay extensible: the llm runtime composes them with
	 * AbortSignal.any(), which attaches Symbol(kDependantSignals) to every input
	 * — freezing one makes the composed stream fail with "object is not
	 * extensible" before any provider request. */
	if (value !== null && typeof value === "object" && !(value instanceof AbortSignal) && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}
/**
* Assemble streamed chunks into blocks, mirroring the host's `BlockAssembler`
* contract for the shapes a reviewer stream can carry (text, reasoning, and the
* terminal `finish`). The reviewer protocol accepts only reasoning blocks
* followed by one text block, so tool-call assembly is not needed here.
*/
class BlockAssembler {
	partials = /* @__PURE__ */ new Map();
	order = [];
	push(chunk) {
		switch (chunk.type) {
			case "block-start":
				if (!this.partials.has(chunk.index)) {
					this.order.push(chunk.index);
					this.partials.set(chunk.index, {
						blockType: chunk.blockType,
						text: ""
					});
				}
				return;
			case "text-delta":
			case "reasoning-delta": {
				const partial = this.ensure(chunk.index, chunk.type === "text-delta" ? "text" : "reasoning");
				if (partial.block !== void 0) return;
				partial.text += chunk.text;
				return;
			}
			case "block-end": {
				const partial = this.ensure(chunk.index, chunk.block.type);
				if (partial.block !== void 0) return;
				partial.block = chunk.block;
				return;
			}
			case "usage":
			case "finish":
			case "tool-call-delta": return;
			default: return;
		}
	}
	ensure(index, blockType) {
		let partial = this.partials.get(index);
		if (partial === void 0) {
			partial = {
				blockType,
				text: ""
			};
			this.partials.set(index, partial);
			this.order.push(index);
		}
		return partial;
	}
	blocks() {
		return this.order.map((index) => {
			const partial = this.partials.get(index);
			return partial.block ?? {
				type: partial.blockType,
				text: partial.text
			};
		});
	}
}
/** The permission preset this extension owns, declared in cordis.patch.yml. */
const AUTO_PRESET = "auto-review";
//#endregion
//#region lib/types/index.js
/**
* Workspace-write Auto review — a drop-in replacement for the shipped
* `experimental-auto-review` row, installed from the profile so a `dsh` upgrade
* cannot overwrite it.
*
* Auto confines every call to the `workspace-write` sandbox, so ordinary
* project work runs without asking anyone. Only an operation the confinement
* will not run as requested — a sandbox escalation carried by
* `sandbox_permissions`, or any other call the tools pipeline routes through
* the approval seam — reaches this answerer, which decides it with the current
* agent's provider and model instead of a human. A granted request executes
* once; a rejected one never executes, and its reviewer reason is published to
* the agent through this plugin's own system-prompt context so the model can
* adapt instead of retrying blind. Reviewer failures fail closed.
*
* @module dsh-auto-review-ww
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "auto-review-ww";
/** Complete host services required before Auto may be advertised. */
const inject = [
	"approval",
	"llm",
	"permissionPresets",
	"sessions"
];
/**
* Optional registries the reason channel uses when the composition provides
* them. They are declared here rather than in {@link inject} so a deployment
* without a system prompt still gets the reviewer and the denial logging.
*/
const optionalInject = ["systemPrompt"];
/** Fixed policy sent as the first of the review request's five sections. */
const REVIEW_POLICY = `REVIEW_POLICY
You are the final operator-delegate for exactly one pending tool call that the workspace-write sandbox will not run as requested. Your single question is: should this call run now, given everything visible in this session? You are making a substantive judgment about whether the action should happen — not checking boxes on a risk form. When you deny, your reason is shown to the agent that requested the call, so write it as one useful sentence: name the actual objection and, when you can, what would make the action acceptable.

Return exactly one JSON object and no other text. An allow object has exactly two members, risk and decision, and never has reason. The only valid shapes are:
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"deny"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny"}
{"risk":"high","decision":"deny","reason":"..."}
Never return low with deny, high with allow, or a reason with allow.

Judge the pending action by its actual effects and its fit with this session:
- What was the human commissioning in this session? Is the pending action a step they would expect, accept, or have asked for? Human messages define the task and its restrictions; they are evidence of intent, not a formality to be ticked. An action the session's task plainly needs does not require a separate blessing, and an authorized action that should not run is still denied.
- What does the call actually change outside the workspace? Weigh reversibility, blast radius, and timing against the commissioned work. Wider effects are acceptable when they are understood and proportionate to the task; the same effects are denied when they exceed what the task justifies.
- Does the claimed purpose match the command's real effects? A mismatch denies.
- Retained history roles describe evidentiary weight only: "human-instruction" and "direct-parent-instruction" texts carry the human's and parent's intent, "constraint" texts bound the action, "checkpoint" texts restore earlier context, "fact" texts establish what already happened. They inform the judgment; none of them mechanically forces or forbids the call.
Fail closed when the actual effects are unknowable or the pending action is unrelated to anything in the session. Otherwise decide as the operator's delegate would, with their interest in both getting the work done and not breaking things.

For any allow, end with exactly the applicable two-member object and nothing else. In particular, when a medium action is allowed, the complete text must be exactly {"risk":"medium","decision":"allow"}. Do not add reason, explanation, labels, Markdown, or surrounding prose. Stop immediately after the closing brace.`;
/** Return JSON text for one immutable logged value. */
function json(value) {
	const rendered = JSON.stringify(value, null, 2);
	/* v8 ignore next -- accepted Session facts and frozen review snapshots are lossless JSON by contract. */
	if (rendered === void 0) throw new Error("auto-review-ww: a required value is not JSON-serializable");
	return rendered;
}
/** Recreate the agent-loop's parse of one native call's logged raw arguments. */
function parseLoggedArguments(raw) {
	if (raw === "") return {};
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
/** Whether one logged JSON value is an object record rather than null or an array. */
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validate the schema fields that must be present in a logged tool schema. */
function loggedSchema(value, expectedName, mode) {
	if (typeof value.description !== "string" || !isRecord(value.parameters)) throw new Error(`auto-review-ww: the pending ${mode} tool schema is incomplete`);
	return {
		name: expectedName,
		description: value.description,
		parameters: value.parameters
	};
}
/** Read live abort state across awaits without relying on stale narrowing. */
function isAborted(signal) {
	return signal.aborted;
}
/** Whether this visible message is a durable shipped-Web human instruction. */
function isHumanInstruction(source) {
	return source.kind === "user" && typeof source.rpcId === "string";
}
/** Whether this visible context is the current project-instruction source. */
function isProjectInstruction(source) {
	return source.kind === "agent-instructions";
}
/** Whether this source is a compaction checkpoint. */
function isCheckpoint(source) {
	return source.kind === "compact-checkpoint";
}
/** Whether this message was durably attributed to the child's direct parent. */
function isDirectParentInstruction(source, parentSession) {
	return parentSession !== void 0 && source.kind === "agent-message" && source.senderSessionId === parentSession;
}
/** Find the visible-role identity of the in-process child's creation prompt. */
function directParentInitialPromptSeq(agent, events) {
	const { session } = agent;
	if (session.header.origin !== "subagent" || session.header.parentSession === void 0) return void 0;
	let passedCreationBoundary = false;
	for (const event of events) {
		if (!session.isOwnSeq(event.seq)) continue;
		if (event.type === "subagent/descriptor") {
			passedCreationBoundary = true;
			continue;
		}
		if (passedCreationBoundary && event.type === "user/message" && event.data.source.kind === "user" && !isHumanInstruction(event.data.source)) return event.seq;
	}
}
/** Assign one retained text block its fixed instruction, constraint, summary, or fact role. */
function textRole(source, seq, initialPromptSeq, parentSession) {
	if (isHumanInstruction(source)) return "human-instruction";
	if (seq === initialPromptSeq || isDirectParentInstruction(source, parentSession)) return "direct-parent-instruction";
	if (isCheckpoint(source)) return "checkpoint";
	return "fact";
}
/** Partition one visible user-role message into role-labelled retained blocks. */
function filteredUserEntries(seq, source, content, initialPromptSeq, parentSession) {
	return content.map((block) => ({
		kind: "user-message",
		role: block.type === "text" ? textRole(source, seq, initialPromptSeq, parentSession) : "fact",
		source,
		content: [block]
	}));
}
/** Resolve the latest request header's schema for one tool name. */
function toolSchemaOf(headerTools, toolName) {
	const schemas = (Array.isArray(headerTools) ? headerTools : []).filter((schema) => isRecord(schema) && schema["name"] === toolName);
	if (schemas.length !== 1) return void 0;
	return loggedSchema(schemas[0], toolName, "native");
}
/**
* Rebuild the pending action from the logged call the approval request names.
* The request itself carries only the tool name, an optional call id, and the
* reason; the arguments and the tool schema come from the session log and the
* latest request header, so the reviewer sees what the call will actually do.
* @param events - the retained session log.
* @param headerTools - the latest request header's tool schemas.
* @param request - the approval request being answered.
* @returns the pending action object.
*/
function pendingAction(events, headerTools, request) {
	let logged;
	const callId = typeof request.callId === "string" ? request.callId : void 0;
	if (callId !== void 0) for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "tool/call" && event.data.callId === callId) {
			logged = {
				mode: "native",
				name: event.data.name,
				arguments: parseLoggedArguments(event.data.arguments)
			};
			break;
		}
		if (event.type === "tool/ptc-dispatch-start" && (event.data.subCallId === callId || event.data.callId === callId)) {
			logged = {
				mode: "ptc-inner",
				name: event.data.name,
				arguments: event.data.arguments
			};
			break;
		}
	}
	const toolName = logged?.name ?? request.toolName;
	const schema = toolSchemaOf(headerTools, toolName);
	return {
		mode: logged?.mode ?? "native",
		name: toolName,
		...schema === void 0 ? {} : {
			description: schema.description,
			parameters: schema.parameters
		},
		...logged === void 0 ? {} : { arguments: logged.arguments },
		...typeof request.reason === "string" && request.reason.length > 0 ? { approvalReason: request.reason } : {}
	};
}
/**
* Retain the sourced project constraints and the visible action history, with
* the pending action itself excluded so it is never also cited as a fact.
* @param nodes - the current surface's retained sequence numbers.
* @param events - the retained session log.
* @param request - the approval request being answered.
* @param agent - agent whose session owns the surface.
* @returns the constraint and history sections.
*/
function retainedContext(nodes, events, request, agent) {
	const initialPromptSeq = directParentInitialPromptSeq(agent, events);
	const pendingCallId = typeof request.callId === "string" ? request.callId : void 0;
	const projectInstructions = [];
	const history = [];
	const visibleCallIds = /* @__PURE__ */ new Set();
	/* Map call ids to tool names so result events can be attributed. Human
	 * answers to question cards arrive as tool results, and they carry the
	 * human's decisions just like typed messages do. The tool itself is not
	 * touched — this reads only what the session log already records, matched
	 * by name pattern so a renamed registration keeps working. */
	const callNames = /* @__PURE__ */ new Map();
	for (const event of events) {
		if (event.type === "tool/call" && typeof event.data.callId === "string") callNames.set(event.data.callId, event.data.name);
		else if (event.type === "tool/ptc-dispatch-start" && typeof event.data.subCallId === "string") callNames.set(event.data.subCallId, event.data.name);
	}
	const isHumanAnswerTool = (name) => typeof name === "string" && /question/i.test(name);
	for (const seq of nodes) {
		const event = events[seq];
		if (event.type === "user/message") {
			if (event.data.source.kind === "tool") continue;
			if (isProjectInstruction(event.data.source)) {
				const content = event.data.content;
				if (content.length > 0) projectInstructions.push({
					kind: "user-message",
					role: "constraint",
					source: event.data.source,
					content
				});
			} else history.push(...filteredUserEntries(event.seq, event.data.source, event.data.content, initialPromptSeq, agent.session.header.parentSession));
			continue;
		}
		if (event.type === "tool/result") {
			const toolCallId = event.data?.message?.toolCallId;
			const name = typeof toolCallId === "string" ? callNames.get(toolCallId) : void 0;
			if (isHumanAnswerTool(name)) history.push({
				kind: "tool-result",
				role: "human-instruction",
				name,
				content: event.data.message.content
			});
			continue;
		}
		if (event.type !== "assistant/message") continue;
		for (const block of event.data.message.content) {
			if (block.type !== "tool-call") continue;
			visibleCallIds.add(block.id);
			if (pendingCallId !== void 0 && block.id === pendingCallId) continue;
			history.push({
				kind: "tool-call",
				role: "fact",
				mode: "native",
				name: block.name,
				arguments: block.arguments
			});
		}
	}
	for (const event of events) {
		if (event.type !== "tool/ptc-dispatch-start") continue;
		if (!visibleCallIds.has(event.data.parentCallId)) continue;
		if (pendingCallId !== void 0 && event.data.subCallId === pendingCallId) continue;
		history.push({
			kind: "tool-call",
			role: "fact",
			mode: "ptc-inner",
			name: event.data.name,
			arguments: json(event.data.arguments)
		});
	}
	return {
		projectInstructions,
		history
	};
}
/**
* Freeze the five reviewer sections from one session and pending approval.
* @param agent - agent whose durable surface and request header authorize the call.
* @param request - the approval request awaiting a decision.
* @returns the exact route and four data sections paired with {@link REVIEW_POLICY}.
*/
function snapshotAutoReview(agent, request) {
	const { session } = agent;
	const events = session.snapshotEvents();
	const nodes = [...session.surface.nodes];
	const header = session.requestHeader();
	if (header === void 0 || header.config.provider.length === 0 || header.config.model.length === 0) throw new Error("auto-review-ww: no complete request-header route is available");
	const cwd = session.header.cwd;
	if (cwd === void 0 || cwd.length === 0) throw new Error("auto-review-ww: the session has no working directory");
	const { projectInstructions, history } = retainedContext(nodes, events, request, agent);
	return deepFreeze({
		provider: header.config.provider,
		model: header.config.model,
		cwd,
		projectInstructions,
		history,
		action: pendingAction(events, header.tools, request)
	});
}
/** Render the four data sections paired with the fixed policy section. */
function reviewUserText(snapshot) {
	return [
		"ENVIRONMENT",
		json({ cwd: snapshot.cwd }),
		"PROJECT_INSTRUCTIONS",
		json(snapshot.projectInstructions),
		"FILTERED_HISTORY",
		json(snapshot.history),
		"PENDING_ACTION",
		json(snapshot.action)
	].join("\n\n");
}
/** Count members in the raw top-level JSON object. */
function topLevelMemberCount(text) {
	const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, "");
	let depth = 0;
	let count = 0;
	for (const char of syntax) switch (char) {
		case "{":
		case "[":
			depth += 1;
			break;
		case "}":
		case "]":
			depth -= 1;
			break;
		case ":": if (depth === 1) count += 1;
	}
	return count;
}
/** Parse the closed risk/decision protocol and its fixed safety combinations. */
function parseDecision(text) {
	const value = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("auto-review-ww: reviewer output must be one JSON object");
	const record = value;
	const keys = Object.keys(record);
	if (topLevelMemberCount(text) !== keys.length) throw new Error("auto-review-ww: reviewer output repeats a JSON member");
	const risk = record["risk"];
	const decision = record["decision"];
	if (keys.length === 2 && decision === "allow" && (risk === "low" || risk === "medium")) return {
		risk,
		decision
	};
	if (keys.length === 2 && decision === "deny" && (risk === "medium" || risk === "high")) return {
		risk,
		decision
	};
	if (decision === "deny" && (risk === "medium" || risk === "high") && keys.length === 3 && Object.hasOwn(record, "reason") && typeof record["reason"] === "string") return {
		risk,
		decision,
		reason: record["reason"]
	};
	throw new Error("auto-review-ww: reviewer output does not match the risk/decision protocol");
}
/** Consume zero or more reasoning blocks, one JSON text block, and one terminal stop. */
async function readDecision(stream) {
	const assembler = new BlockAssembler();
	let finished = false;
	for await (const chunk of stream) {
		if (finished) throw new Error("auto-review-ww: reviewer emitted data after its terminal finish");
		assembler.push(chunk);
		if (chunk.type === "finish") {
			finished = true;
			if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
				const { code, message } = chunk.reason.failure;
				throw new Error(`auto-review-ww: reviewer ended with ${chunk.reason.kind} ${code}: ${message}`);
			}
			if (chunk.reason.kind !== "stop") throw new Error(`auto-review-ww: reviewer ended with ${chunk.reason.kind}`);
		}
	}
	if (!finished) throw new Error("auto-review-ww: reviewer emitted no terminal finish");
	const blocks = assembler.blocks();
	const final = blocks.at(-1);
	if (final?.type !== "text" || blocks.slice(0, -1).some((block) => block.type !== "reasoning")) throw new Error("auto-review-ww: reviewer must emit zero or more reasoning blocks followed by exactly one text block");
	const reasoningText = blocks.filter((block) => block.type === "reasoning").map((block) => block.text ?? "").join("\n").slice(0, 600);
	return { ...parseDecision(final.text), rawText: final.text, reasoningText };
}
/** Review one frozen pending approval with the fixed policy and current LLM route. */
async function classifyRisk(ctx, agent, request, signal) {
	const snapshot = snapshotAutoReview(agent, request);
	const userText = reviewUserText(snapshot);
	const options = deepFreeze({
		provider: snapshot.provider,
		model: snapshot.model,
		system: REVIEW_POLICY,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: userText
			}]
		}],
		/* No forced temperature: some provider routes with an openai-responses
		 * wire channel reject temperature=0 with an opaque upstream failure, and
		 * the reviewer must ride whatever route the session runs. Provider
		 * defaults are fine for this classification. */
		signal
	});
	const outcome = await readDecision(ctx.llm.stream(options));
	return { ...outcome, provider: snapshot.provider, model: snapshot.model, payloadChars: userText.length };
}
/** Current agent-facing explanation per session (the newest denial wins). */
const explanations = /* @__PURE__ */ new WeakMap();
/** Verdict reuse window: an identical escalation inside the window reuses the
 * reviewed outcome instead of paying for another model call. */
function verdictTtlMs() {
	const v = Number(process.env.AUTO_REVIEW_WW_VERDICT_TTL_MS);
	return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
}
/** Hard cap on a single review: a slow upstream must not block the turn. */
function reviewTimeoutMs() {
	const v = Number(process.env.AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 120 * 1000;
}
/** Stable cache key: one session, one tool, one escalation shape. */
function verdictKeyFor(agent, request) {
	const crypto = process.getBuiltinModule("node:crypto");
	const digest = crypto.createHash("sha256").update(`${agent.session.id}\u0000${request.toolName}\u0000${request.reason}`).digest("hex").slice(0, 32);
	return `${agent.session.id}:${digest}`;
}
function readVerdict(cache, key) {
	const entry = cache.get(key);
	if (entry === void 0) return void 0;
	if (Date.now() - entry.at > verdictTtlMs()) {
		cache.delete(key);
		return void 0;
	}
	return entry;
}
function rememberVerdict(cache, key, outcome, reasonText) {
	cache.set(key, { outcome, reasonText, at: Date.now() });
	if (cache.size > 64) cache.delete(cache.keys().next().value);
}
/**
* Cross-package denial mailbox, read by the optional sandbox patch
* (tools/patch-sandbox-rejection.mjs). The host composes the escalation
* rejection message inside `@deepseek-ai/dsh-sandbox`, whose fixed template
* says "the user rejected" — wrong when an automatic reviewer denied — and the
* approval outcome protocol carries no reason field. This registry bridges the
* gap: keyed by `<session id>:<tool name>`, it lets the patched sandbox line
* substitute the reviewer's actual verdict. Unpatched hosts simply never read
* it; entries are capped so nothing accumulates.
*/
const DENIAL_REGISTRY = Symbol.for("auto-review-ww.denials");
function publishToolReturnReason(agent, request, text) {
	try {
		const registry = globalThis[DENIAL_REGISTRY] ??= new Map();
		registry.set(`${agent.session.id}:${request.toolName}`, text);
		if (registry.size > 32) registry.delete(registry.keys().next().value);
	} catch {}
}
/**
* Whether one approval request is an escalation this extension owns.
*
* The sandbox's `approveEscalation` names the widening in the audited reason it
* sends (`escalate sandbox to <mode>: <justification>`), so that prefix is the
* one reliable signal that the request comes from a call the confinement
* refused. Every other request — a per-call pipeline `ask`, a question from a
* tool that needs a human — is left to `next()` so the shipped reviewer and the
* human answerer keep their existing responsibilities.
* @param request - the pending approval request.
* @returns whether this extension should decide it.
*/
function isEscalation(request) {
	return typeof request.reason === "string" && request.reason.startsWith("escalate sandbox to ");
}
/**
* Publish one denial explanation to the requesting agent, so the model that
* asked for the escalation learns why it was refused instead of guessing.
*
* The text is kept as complete sentences with no literal newlines: an
* append-only context block whose text never changes adds nothing to the next
* request, so a session that never gets denied pays no tokens and no cache
* invalidation for this channel.
*
* @param agent - the agent whose next request carries the explanation.
* @param text - the explanation sentence.
* @param risk - the reviewed risk class, which decides the closing guidance.
*/
function publishExplanation(agent, text, risk) {
	explanations.set(agent.session, {
		text,
		risk
	});
}
/**
* Compose the agent-facing explanation for one reviewer denial.
*
* A reviewer omit `reason` when the risk class alone is the objection, so the
* explanation falls back to a phrased statement of the class — the agent still
* learns whether it hit an authorization gap (`medium`) or a hard prohibition
* (`high`), which is what tells it whether to ask the human or stop entirely.
*
* @param request - the approval request that was denied.
* @param decision - the parsed reviewer decision.
* @returns the explanation text.
*/
function denialExplanation(request, decision) {
	const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
	if (reason.length > 0) return `An automatic review denied the escalation requested by ${request.toolName}: ${reason}`;
	return decision.risk === "high" ? `An automatic review denied the escalation requested by ${request.toolName}: the action leaks sensitive data across a trust boundary, which is never authorized.` : `An automatic review denied the escalation requested by ${request.toolName}: the action is irreversible or security-relevant and the active instructions do not authorize its exact target and scope.`;
}
/**
* The explanation text for one agent, formatted for the model. Kept
* newline-free so repeated denials that say the same thing produce the same
* text and the append-only context block stays byte-identical.
*
* The closing sentence depends on the risk class: a `medium` denial is an
* authorization gap the human can close by explicitly authorizing this exact
* action, while a `high` denial is a hard prohibition that no authorization can
* open. Telling the agent to seek authorization for a `high` denial would send it
* into a retry that can only fail again.
* @param agent - the agent whose request is being assembled.
* @returns the context text, or `""` when this agent has no explanation.
*/
function explanationText(agent) {
	const published = explanations.get(agent.session);
	if (published === undefined) return "";
	const route = published.risk === "high" ? " This class of action is never authorized, so do not retry it or seek authorization for it." : " To obtain a refused permission, the human must explicitly authorize this exact action, target and scope in a message.";
	return `${published.text} This call did not run.${route}`;
}
/**
* Install the Auto review preset's reviewer and its reason channel.
*
* This package owns the whole feature: `cordis.patch.yml` disables the shipped
* `auto-review` row, declares this package's `auto-review` permission preset
* (workspace-write + ask) in the `permission` row config, and inserts this row.
* Declaring the preset as ordinary row config is what removes the need to touch
* the shipped package's private `AUTO_PRESET_SPEC` constant.
*
* The preset itself needs no admission gate: it is plain configuration, so the
* picker option survives even if this plugin fails to activate (the session then
* simply falls back to the human answerer). What this plugin adds is decided per
* request:
* - it answers escalations of its own preset with the workspace-write contract,
*   and
* - it publishes every refusal reason to the agent: both reviewed denials and
*   the case where the reviewer itself fails before reaching a decision, whose
*   message is otherwise invisible to the model that asked for the escalation.
* A request that is not an escalation — a per-call pipeline `ask`, a question
* that needs a human, or a request from another preset — is delegated with
* `next()`.
*/
function apply(ctx) {
	const permissionPresets = ctx.permissionPresets;
	let accepting = true;
	const active = /* @__PURE__ */ new Set();
	const lifecycle = new AbortController();
	const verdictCache = /* @__PURE__ */ new Map();
	ctx.effect(function* () {
		yield ctx.on("approval/request", async (request, next) => {
			const agent = request.agent;
			if (agent === void 0 || agent === null) return next();
			if (!accepting || lifecycle.signal.aborted) return "cancelled";
			if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();
			if (!isEscalation(request)) return next();
			const cacheKey = verdictKeyFor(agent, request);
			const cached = readVerdict(verdictCache, cacheKey);
			if (cached !== void 0) {
				ctx.logger?.info?.(`[auto-review-ww] verdict cache hit for tool "${request.toolName}": ${cached.outcome}`);
				if (cached.outcome === "rejected") {
					publishToolReturnReason(agent, request, cached.reasonText);
					return "rejected";
				}
				return "allowed-once";
			}
			const completed = Promise.withResolvers();
			active.add(completed.promise);
			try {
				const signal = request.signal === void 0 ? lifecycle.signal : AbortSignal.any([request.signal, lifecycle.signal]);
				const reviewSignal = reviewTimeoutMs() > 0 ? AbortSignal.any([signal, AbortSignal.timeout(reviewTimeoutMs())]) : signal;
				let cancelReviewTimer = () => {};
				const review = await Promise.race([
					classifyRisk(ctx, agent, request, reviewSignal).then((decision) => ({
						ok: true,
						decision
					}), (error) => ({
						ok: false,
						error
					})),
					reviewTimeoutMs() > 0 ? new Promise((resolve) => {
						const timer = setTimeout(() => resolve({
							ok: false,
							error: new Error(`review exceeded ${reviewTimeoutMs()}ms and was aborted; the operator can raise AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS`)
						}), reviewTimeoutMs());
						cancelReviewTimer = () => clearTimeout(timer);
					}) : null
				].filter(Boolean));
				cancelReviewTimer();
				if (isAborted(lifecycle.signal)) return "cancelled";
				if (!review.ok) {
					const message = review.error instanceof Error ? review.error.message : String(review.error);
					ctx.logger?.warn?.(`[auto-review-ww] reviewer failed for tool "${request.toolName}"; the request fails closed: ${message}`);
					/* Optional field debugging: set AUTO_REVIEW_WW_DEBUG_LOG to an
					 * appendable file path to capture the exact upstream failure. */
					const debugLogPath = process.env.AUTO_REVIEW_WW_DEBUG_LOG;
					if (debugLogPath) try {
						const debugLine = `${new Date().toISOString()} tool=${request.toolName} message=${message} reqSignalProvided=${request.signal !== void 0} reqSignalAborted=${request.signal?.aborted ?? "n/a"} mergedSignalAborted=${signal?.aborted ?? "n/a"}`;
						process.getBuiltinModule("node:fs").appendFileSync(debugLogPath, debugLine + "\n");
					} catch {}
					const outageText = "The automatic reviewer itself failed before it could review this escalation, so the request was refused without a risk judgment; this is a reviewer outage, not a risk verdict, so ask the human to run or approve the action.";
					publishExplanation(agent, outageText, "medium");
					publishToolReturnReason(agent, request, `reviewer outage (${message}); the request was refused without a risk judgment`);
					return "rejected";
				}
				const d = review.decision;
				ctx.logger?.info?.(`[auto-review-ww] reviewer route ${d.provider}/${d.model} payload=${d.payloadChars}ch; raw output for "${request.toolName}": ${d.rawText.slice(0, 240)}${d.reasoningText ? ` | reasoning: ${d.reasoningText.slice(0, 240)}` : ""}`);
				if (d.decision === "allow") {
					rememberVerdict(verdictCache, cacheKey, "allowed-once", "");
					return "allowed-once";
				}
				ctx.logger?.info?.(`[auto-review-ww] denied tool "${request.toolName}" at ${d.risk} risk${d.reason === void 0 ? "" : `: ${d.reason}`}`);
				const denialText = denialExplanation(request, d);
				publishExplanation(agent, denialText, d.risk);
				publishToolReturnReason(agent, request, d.reason === void 0 ? denialText : d.reason);
				rememberVerdict(verdictCache, cacheKey, "rejected", denialText);
				return "rejected";
			} finally {
				active.delete(completed.promise);
				completed.resolve();
			}
		}, { global: true, prepend: true });
		ctx.inject(optionalInject, (scope) => {
			scope.systemPrompt.context({
				name: "auto-review:denial",
				order: scope.systemPrompt.getContextOrder("APPROVAL_POLICY") + 1,
				text: (context) => context.agent === void 0 ? "" : explanationText(context.agent)
			});
		});
		yield async () => {
			accepting = false;
			lifecycle.abort(/* @__PURE__ */ new Error("auto-review-ww extension disposed"));
			await Promise.allSettled([...active]);
		};
	}, "auto-review-ww lifecycle");
}
//#endregion
export { apply, inject, name };

