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
//#region lib/decision.js
/**
 * Decision-model reviewer.
 *
 * A decision model (TypeSafe's System One models, OpenAI's Decisions models) does
 * not generate text: it reads one state — here the same JSON the chat reviewer
 * receives — and answers typed questions with calibrated probabilities. That
 * makes it one to two orders of magnitude cheaper per review than a reasoning
 * chat model, so this reviewer runs it first and escalates to the chat reviewer
 * only when the decision is uncertain or the service fails.
 *
 * Two wire protocols are supported, because they are genuinely different:
 * - `typesafe-system-one` posts `{ model, state, questions }` to `/systemone`,
 *   where a yes/no question is `type: "noul"` and answers carry `noul`, `choice`
 *   with `probabilities`/`confidence`, or `score`.
 * - `openai-decisions` posts `{ model, input, questions }` to `/decisions`, where
 *   `input` is the JSON state as text and a yes/no question is `type: "predicate"`
 *   (which has no `criteria` field, so the meanings are folded into the
 *   instructions). Answers come back as an array keyed by `name`.
 *
 * The reviewer asks three questions so the cheap model produces everything the
 * decision protocol needs: whether the call is authorized, its risk class, and —
 * when it must not run — which objection applies. The objection becomes the
 * agent-facing reason, which is the one thing a classifier cannot phrase itself.
 *
 * Safety invariants are preserved from the chat reviewer: `high` risk is never
 * authorized, a `medium`/`high` denial is the only denial shape, and an unsure
 * verdict never allows a call — it escalates or fails closed.
 */
/** The two decision-model protocols this plugin speaks. */
const DECISION_APIS = {
	"typesafe-system-one": {
		label: "System One API",
		defaultBaseUrl: "https://api.typesafe.ai/v1/",
		defaultModel: "jev-latest",
		defaultApiKeyEnv: "TYPESAFE_API_KEY",
		path: "systemone",
		/* Jev: 64k per request, 32k per question. 90k JSON chars is about 27k tokens. */
		defaultMaxStateChars: 9e4
	},
	"openai-decisions": {
		label: "OpenAI Decisions API",
		defaultBaseUrl: "https://api.openai.com/v1/",
		defaultModel: "gpt-6-luna",
		defaultApiKeyEnv: "OPENAI_API_KEY",
		path: "decisions",
		/* GPT-6 Luna: a 922k-token context, so the chat-scale state fits untrimmed. */
		defaultMaxStateChars: 6e5
	}
};
/** Reviewer modes accepted by the `reviewer.mode` setting. */
const REVIEWER_MODES = ["auto", "chat", "decision"];
/** Escalation policies for an uncertain or failed decision review. */
const ESCALATION_POLICIES = ["chat", "deny"];
/** The state shape the decision model reads, described once for both protocols. */
const DECISION_STATE_HINT = "The state has four members: cwd (the working directory), project_instructions (the project's standing constraints), history (role-labelled evidence: human-instruction, direct-parent-instruction, constraint, checkpoint, and fact texts, plus tool calls and results), and pending_action (the tool call the sandbox will not run as requested, with its approval reason).";
/** Yes/no question: is this call work the session's human commissioned? */
const AUTHORIZED_INSTRUCTIONS = `${DECISION_STATE_HINT} Answer true only when running pending_action right now, exactly at its stated target and scope, is work this session's human commissioned and would approve: it fits the task in progress, its effects match the instructions that authorize the task, and nothing in history forbids it. Answer false when no visible instruction authorizes this exact action, when its target or scope is wider than the task, when it would destroy or leak something the session does not justify, or when its real effects cannot be determined from the state.`;
/** The two meanings of the authorization predicate. */
const AUTHORIZED_CRITERIA = {
	true: "The session's active instructions and task plainly authorize this exact action, target and scope, and its effects are proportionate to the commissioned work.",
	false: "The action is unauthorized, exceeds the task's scope, is disproportionate to the task, or its real effects are unknowable, so it must not run automatically."
};
/** Choice question: how much can go wrong if this call runs? */
const RISK_INSTRUCTIONS = "Classify how much damage the pending action could do if it is wrong, given its actual effects rather than its stated intent.";
/** The risk classes, shared by both protocols. */
const RISK_CRITERIA = {
	low: "Reversible, local project work: ordinary file edits, builds, tests, reads, searches. A mistake is recoverable inside the workspace.",
	medium: "Harder to undo or reaching outside the workspace, but a proportionate step of the task in progress: installing a dependency, pushing to the task's own branch, a non-destructive external write. Recoverable with care.",
	high: "Destructive or irreversible (deleting user data, force-pushing shared history, dropping a database, mass deletion) or it moves sensitive data across a trust boundary. No session authorization can cover this class."
};
/** Choice question: why must the call not run? */
const OBJECTION_INSTRUCTIONS = "If the pending action must not run, choose the strongest objection. Choose none when it should run now.";
/** The objection categories, whose texts become the agent-facing denial reason. */
const OBJECTION_CRITERIA = {
	none: "The action should run now; there is no objection.",
	unauthorized: "No visible instruction authorizes this exact action, target and scope.",
	scope: "The action belongs to the task but its target, path or scope is wider than the task authorizes.",
	destructive: "The action is destructive or irreversible at a blast radius the task does not justify.",
	exfiltration: "The action would move sensitive data (credentials, private files, secrets) outside the machine or across a trust boundary.",
	unclear: "The real effects of the action cannot be determined from the state, so it fails closed."
};
/** Human-readable denial reasons keyed by objection, for the agent-facing text. */
const OBJECTION_TEXT = {
	unauthorized: "no visible instruction in this session authorizes this exact action, target and scope",
	scope: "the requested target, path or scope is wider than this task authorizes",
	destructive: "the action is destructive or irreversible at a blast radius this task does not justify",
	exfiltration: "the action would move sensitive data across a trust boundary, which is never authorized automatically",
	unclear: "the action's real effects cannot be determined from the session, so it fails closed",
	high: "the action is destructive or moves data across a trust boundary, and no session authorization can cover it"
};
/** Read one non-empty string from an environment bag. */
function envString(env, name) {
	const value = env[name];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/** Coerce a number setting, clamping to a documented range and falling back on garbage. */
function numberSetting(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
	return parsed;
}
/** Coerce a boolean setting from a config boolean or an environment string. */
function booleanSetting(value, fallback) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
		if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
	}
	return fallback;
}
/** One string setting; the environment wins so operations can override the row config. */
function stringSetting(configValue, envValue, fallback) {
	if (typeof envValue === "string" && envValue.length > 0) return envValue;
	if (typeof configValue === "string" && configValue.length > 0) return configValue;
	return fallback;
}
/**
 * Normalize the reviewer settings from the plugin row config and the environment.
 *
 * The environment wins for the operational knobs so an outage can be handled
 * without editing the profile, while the row config carries the intended setup.
 * Everything is validated here: an unusable setup degrades to the chat reviewer
 * (or, when `mode` explicitly asks for the decision reviewer, is reported as a
 * configuration problem) rather than failing a review at runtime.
 *
 * @param config - the plugin row config, or `undefined`.
 * @param env - the process environment.
 * @returns the normalized settings and any configuration problem.
 */
function reviewerSettings(config, env) {
	const raw = isRecord(config) ? config : {};
	const requestedMode = stringSetting(raw["mode"], envString(env, "AUTO_REVIEW_WW_MODE"), "auto");
	const mode = REVIEWER_MODES.includes(requestedMode) ? requestedMode : "auto";
	const decisionRaw = isRecord(raw["decision"]) ? raw["decision"] : {};
	const apiId = stringSetting(decisionRaw["api"], envString(env, "AUTO_REVIEW_WW_DECISION_API"), "typesafe-system-one");
	const api = DECISION_APIS[apiId];
	const decision = {
		apiId,
		label: api?.label ?? apiId,
		path: api?.path ?? "systemone",
		baseUrl: "",
		model: "",
		apiKeyEnv: "",
		apiKey: "",
		allowThreshold: 0.85,
		denyThreshold: 0.2,
		escalate: "chat",
		timeoutMs: 20e3,
		maxStateChars: 9e4,
		confirmDenials: true,
		escalateOnTruncation: true,
		fetch: decisionRaw["fetch"],
		problem: void 0
	};
	if (api === void 0) decision.problem = `reviewer.decision.api "${apiId}" is not one of ${Object.keys(DECISION_APIS).join(", ")}`;
	else {
		const baseUrl = stringSetting(decisionRaw["baseUrl"], envString(env, "AUTO_REVIEW_WW_DECISION_BASE_URL"), api.defaultBaseUrl);
		decision.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		decision.model = stringSetting(decisionRaw["model"], envString(env, "AUTO_REVIEW_WW_DECISION_MODEL"), api.defaultModel);
		decision.apiKeyEnv = stringSetting(decisionRaw["apiKeyEnv"], void 0, api.defaultApiKeyEnv);
		decision.apiKey = stringSetting(decisionRaw["apiKey"], void 0, "") || envString(env, "AUTO_REVIEW_WW_DECISION_API_KEY") || envString(env, decision.apiKeyEnv) || envString(env, api.defaultApiKeyEnv) || "";
		decision.allowThreshold = numberSetting(envString(env, "AUTO_REVIEW_WW_DECISION_ALLOW_THRESHOLD") ?? decisionRaw["allowThreshold"], 0.85, 0.5, 1);
		decision.denyThreshold = numberSetting(envString(env, "AUTO_REVIEW_WW_DECISION_DENY_THRESHOLD") ?? decisionRaw["denyThreshold"], 0.2, 0, 0.5);
		const escalate = stringSetting(decisionRaw["escalate"], envString(env, "AUTO_REVIEW_WW_DECISION_ESCALATE"), "chat");
		decision.escalate = ESCALATION_POLICIES.includes(escalate) ? escalate : "chat";
		decision.timeoutMs = numberSetting(envString(env, "AUTO_REVIEW_WW_DECISION_TIMEOUT_MS") ?? decisionRaw["timeoutMs"], 20e3, 1e3, 12e4);
		decision.maxStateChars = numberSetting(envString(env, "AUTO_REVIEW_WW_DECISION_MAX_STATE_CHARS") ?? decisionRaw["maxStateChars"], api.defaultMaxStateChars, 2e3, 2e6);
		decision.confirmDenials = booleanSetting(envString(env, "AUTO_REVIEW_WW_DECISION_CONFIRM_DENIALS") ?? decisionRaw["confirmDenials"], true);
		decision.escalateOnTruncation = booleanSetting(envString(env, "AUTO_REVIEW_WW_DECISION_ESCALATE_ON_TRUNCATION") ?? decisionRaw["escalateOnTruncation"], true);
		try {
			new URL(decision.path, decision.baseUrl);
		} catch {
			decision.problem = `reviewer.decision.baseUrl "${decision.baseUrl}" is not a valid URL`;
		}
	}
	const enabled = mode !== "chat" && decision.problem === void 0 && decision.apiKey.length > 0;
	const problem = mode === "chat" ? void 0 : decision.problem ?? (mode === "decision" && decision.apiKey.length === 0 ? `reviewer.mode is "decision" but no API key is available (set ${decision.apiKeyEnv} or reviewer.decision.apiKey)` : void 0);
	return {
		mode,
		decision: {
			...decision,
			enabled
		},
		problem: enabled ? void 0 : problem
	};
}
/** The typed questions one decision request asks, in the protocol's own shape. */
function decisionQuestions(apiId) {
	const choices = (criteria) => Object.entries(criteria).map(([value, description]) => ({
		value,
		description
	}));
	if (apiId === "openai-decisions") return [
		{
			type: "predicate",
			name: "authorized",
			instructions: `${AUTHORIZED_INSTRUCTIONS}\n\nTrue means: ${AUTHORIZED_CRITERIA.true}\nFalse means: ${AUTHORIZED_CRITERIA.false}`
		},
		{
			type: "choice",
			name: "risk",
			instructions: RISK_INSTRUCTIONS,
			choices: choices(RISK_CRITERIA)
		},
		{
			type: "choice",
			name: "objection",
			instructions: OBJECTION_INSTRUCTIONS,
			choices: choices(OBJECTION_CRITERIA)
		}
	];
	return {
		authorized: {
			type: "noul",
			instructions: AUTHORIZED_INSTRUCTIONS,
			criteria: AUTHORIZED_CRITERIA
		},
		risk: {
			type: "choice",
			instructions: RISK_INSTRUCTIONS,
			criteria: RISK_CRITERIA
		},
		objection: {
			type: "choice",
			instructions: OBJECTION_INSTRUCTIONS,
			criteria: OBJECTION_CRITERIA
		}
	};
}
/**
 * Build the decision state, shedding the oldest history until it fits the budget.
 *
 * Decision models have a smaller context than chat models (Jev: 64k per request,
 * 32k per question), and the retained history can be arbitrarily long, so the
 * newest evidence is kept and the drop is reported to the audit log. The pending
 * action and the project instructions are never dropped.
 * @param snapshot - the frozen review snapshot.
 * @param maxChars - the serialized-state budget in characters.
 * @returns the state, its serialized size, and how many history entries were dropped.
 */
function decisionState(snapshot, maxChars) {
	const fixed = {
		cwd: snapshot.cwd,
		project_instructions: snapshot.projectInstructions,
		pending_action: snapshot.action
	};
	let history = snapshot.history;
	let truncated = 0;
	let serialized = "";
	for (;;) {
		serialized = JSON.stringify({
			...fixed,
			history
		});
		if (serialized.length <= maxChars || history.length <= 1) break;
		const drop = Math.max(1, Math.ceil(history.length * 0.2));
		history = history.slice(drop);
		truncated += drop;
	}
	return {
		state: JSON.parse(serialized),
		stateChars: serialized.length,
		truncated
	};
}
/**
 * Post one decision request and return the parsed response body.
 *
 * A fresh per-attempt timeout bounds a hung upstream, the caller's abort signal
 * still wins, and every failure is rewritten as one actionable message: the
 * caller escalates or fails closed on it, and the operator reads it in the log.
 * @param settings - the enabled decision settings.
 * @param state - the decision state.
 * @param signal - the review abort signal.
 * @returns the parsed response body.
 */
async function postDecision(settings, state, signal) {
	const url = new URL(settings.path, settings.baseUrl);
	const payload = settings.apiId === "openai-decisions" ? {
		model: settings.model,
		input: JSON.stringify(state),
		questions: decisionQuestions(settings.apiId)
	} : {
		model: settings.model,
		state,
		questions: decisionQuestions(settings.apiId)
	};
	const timeout = AbortSignal.timeout(settings.timeoutMs);
	const composed = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
	const fetchImpl = settings.fetch ?? globalThis.fetch;
	let response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${settings.apiKey}`,
				"content-type": "application/json"
			},
			body: JSON.stringify(payload),
			signal: composed
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${settings.label} request failed: ${message}`);
	}
	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).slice(0, 300);
		} catch {}
		throw new Error(`${settings.label} returned ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(`${settings.label} returned a response that is not JSON`);
	}
}
/** Read one required finite number from a decision answer. */
function answerNumber(label, value, field) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} returned no usable ${field}`);
	return value;
}
/** Read one required choice from a decision answer. */
function answerChoice(label, value, field, allowed) {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} returned no usable ${field}`);
	return value;
}
/** Normalize the two answer envelopes into one verdict triple. */
function parseDecisionAnswers(settings, body) {
	if (!isRecord(body)) throw new Error(`${settings.label} returned an unexpected response`);
	const label = settings.label;
	const risks = Object.keys(RISK_CRITERIA);
	const objections = Object.keys(OBJECTION_CRITERIA);
	let authorized;
	let risk;
	let objection;
	let confidence;
	if (settings.apiId === "openai-decisions") {
		const list = body["answers"];
		if (!Array.isArray(list)) throw new Error(`${label} returned no answers`);
		const byName = /* @__PURE__ */ new Map();
		for (const answer of list) if (isRecord(answer) && typeof answer["name"] === "string") byName.set(answer["name"], answer);
		const predicate = byName.get("authorized");
		if (!isRecord(predicate) || predicate["type"] !== "predicate") throw new Error(`${label} returned no authorization answer`);
		authorized = answerNumber(label, predicate["probability"], "authorization probability");
		const riskAnswer = byName.get("risk");
		if (!isRecord(riskAnswer)) throw new Error(`${label} returned no risk answer`);
		risk = answerChoice(label, riskAnswer["choice"], "risk choice", risks);
		const objectionAnswer = byName.get("objection");
		if (!isRecord(objectionAnswer)) throw new Error(`${label} returned no objection answer`);
		objection = answerChoice(label, objectionAnswer["choice"], "objection choice", objections);
	} else {
		const answers = body["answers"];
		if (!isRecord(answers)) throw new Error(`${label} returned no answers`);
		const authorizedAnswer = answers["authorized"];
		if (!isRecord(authorizedAnswer) || authorizedAnswer["type"] !== "noul") throw new Error(`${label} returned no authorization answer`);
		authorized = answerNumber(label, authorizedAnswer["noul"], "authorization probability");
		const riskAnswer = answers["risk"];
		if (!isRecord(riskAnswer)) throw new Error(`${label} returned no risk answer`);
		risk = answerChoice(label, riskAnswer["choice"], "risk choice", risks);
		const objectionAnswer = answers["objection"];
		if (!isRecord(objectionAnswer)) throw new Error(`${label} returned no objection answer`);
		objection = answerChoice(label, objectionAnswer["choice"], "objection choice", objections);
		confidence = typeof riskAnswer["confidence"] === "number" ? riskAnswer["confidence"] : void 0;
	}
	if (authorized < 0 || authorized > 1) throw new Error(`${label} returned an authorization probability outside 0..1`);
	return {
		authorized,
		risk,
		objection,
		confidence
	};
}
/** Compose the one agent-facing sentence for a decision-model denial. */
function decisionReason(objection, probability) {
	const detail = OBJECTION_TEXT[objection] ?? OBJECTION_TEXT.unclear;
	return `${detail} (the decision model put the authorization probability at ${Math.round(probability * 100)}%)`;
}
/**
 * Review one frozen snapshot with the decision model.
 *
 * Returns a decided verdict, or a `defer` result when the calibrated probability
 * lands between the deny and allow thresholds — the caller then escalates to the
 * chat reviewer, which can read the full history and phrase a substantive
 * judgment. An unsure decision never allows the call.
 * @param snapshot - the frozen review snapshot.
 * @param settings - the enabled decision settings.
 * @param signal - the review abort signal.
 * @returns the verdict with its evidence for the audit log.
 */
async function decisionReview(snapshot, settings, signal) {
	const state = decisionState(snapshot, settings.maxStateChars);
	const startedAt = Date.now();
	const body = await postDecision(settings, state.state, signal);
	const answers = parseDecisionAnswers(settings, body);
	const usage = isRecord(body["usage"]) ? body["usage"] : void 0;
	const evidence = {
		mode: "decision",
		api: settings.apiId,
		provider: settings.apiId,
		model: settings.model,
		payloadChars: state.stateChars,
		probability: answers.authorized,
		objection: answers.objection,
		riskAnswer: answers.risk,
		confidence: answers.confidence,
		truncated: state.truncated,
		usage: usage === void 0 ? void 0 : {
			inputTokens: usage["input_tokens"],
			outputTokens: usage["output_tokens"]
		},
		rawText: JSON.stringify({
			answers,
			usage: usage ?? null,
			truncated: state.truncated
		}),
		reasoningText: "",
		elapsedMs: Date.now() - startedAt
	};
	if (answers.risk === "high") return {
		kind: "deny",
		risk: "high",
		decision: "deny",
		reason: decisionReason("high", answers.authorized),
		...evidence
	};
	if (answers.authorized >= settings.allowThreshold && answers.objection === "none") return {
		kind: "allow",
		risk: answers.risk === "low" ? "low" : "medium",
		decision: "allow",
		...evidence
	};
	if (answers.authorized <= settings.denyThreshold) return {
		kind: "deny",
		risk: "medium",
		decision: "deny",
		reason: decisionReason(answers.objection, answers.authorized),
		...evidence
	};
	return {
		kind: "defer",
		...evidence
	};
}
/**
 * Review one snapshot with the decision model outside any approval flow.
 *
 * This is the tooling entry point behind `tools/probe-decision.mjs`: it answers
 * "is my API key, model and base URL working, and what would the reviewer say
 * about this call?" without waiting for a real escalation. It uses exactly the
 * same transport, questions, budget and thresholds as a live review.
 * @param snapshot - a review-shaped snapshot (cwd, projectInstructions, history, action).
 * @param config - the plugin row config (mode/decision), or `undefined` for the environment.
 * @returns the decision verdict with its evidence.
 */
async function probeDecisionModel(snapshot, config) {
	const settings = reviewerSettings(config, process.env);
	if (!settings.decision.enabled) throw new Error(settings.problem ?? `the decision reviewer is not configured: set ${settings.decision.apiKeyEnv} or reviewer.decision.apiKey`);
	return decisionReview(snapshot, settings.decision, void 0);
}
/** Review one frozen snapshot with the session's own chat model and fixed policy. */
async function chatReview(ctx, snapshot, userText, signal) {
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
	return {
		...outcome,
		mode: "chat",
		api: "chat",
		provider: snapshot.provider,
		model: snapshot.model,
		payloadChars: userText.length
	};
}
/**
 * Review one pending approval: the decision model first when it is enabled, the
 * chat reviewer when it is not, and the chat reviewer again whenever the cheap
 * verdict cannot be trusted.
 *
 * Two decision-model limits are handled here rather than in the prompt. A
 * classifier has less context, so a verdict produced after shedding history is
 * discarded in favour of the full-context reviewer (`escalateOnTruncation`). And
 * a classifier cannot argue a denial, so a medium denial is confirmed by the chat
 * reviewer (`confirmDenials`), which also lets the stronger reviewer override a
 * wrong cheap denial — while a high-risk denial stays final. A calibrated
 * probability between the deny and allow thresholds always escalates, and with
 * `escalate: deny` every uncertain or failed decision fails closed instead.
 * @param ctx - the plugin context (for `ctx.llm` and `ctx.logger`).
 * @param agent - the agent whose session asked for the escalation.
 * @param request - the pending approval request.
 * @param signal - the composed review abort signal.
 * @param settings - the normalized reviewer settings.
 * @returns the reviewed decision with its evidence.
 */
async function classifyRisk(ctx, agent, request, signal, settings) {
	const snapshot = snapshotAutoReview(agent, request);
	const userText = reviewUserText(snapshot);
	if (settings.decision.enabled) {
		let verdict;
		try {
			verdict = await decisionReview(snapshot, settings.decision, signal);
		} catch (error) {
			if (isAborted(signal)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			reviewerLog({ kind: "decision-failure", session: agent.session.id, tool: request.toolName, api: settings.decision.apiId, model: settings.decision.model, escalate: settings.decision.escalate, message });
			ctx.logger?.warn?.(`[auto-review-ww] decision reviewer ${settings.decision.apiId}/${settings.decision.model} failed: ${message}; ${settings.decision.escalate === "deny" ? "the request fails closed" : "escalating to the chat reviewer"}`);
			if (settings.decision.escalate === "deny") throw error;
			return {
				...await chatReview(ctx, snapshot, userText, signal),
				escalatedFrom: "decision-failure",
				decisionError: message
			};
		}
		/* With `escalate: deny` there is no chat fallback, so only an undecided
		 * (deferred) verdict becomes a denial; decided verdicts stand. */
		if (settings.decision.escalate === "deny") {
			if (verdict.kind !== "defer") return verdict;
			const { kind: _deferredKind, ...evidence } = verdict;
			return {
				kind: "deny",
				risk: "medium",
				decision: "deny",
				reason: `the decision reviewer was not confident enough to authorize this action (authorization probability ${Math.round(verdict.probability * 100)}%) and this session is set to fail closed on uncertainty`,
				...evidence
			};
		}
		/* A high-risk denial is final: no session authorization can cover that
		 * class, so nothing downstream may reopen it — not the denial
		 * confirmation, and not the truncation re-review either. */
		if (verdict.kind === "deny" && verdict.risk === "high") return verdict;
		/* The state shed history to fit the decision model's context: the cheap
		 * model judged on partial evidence, so hand the call to the reviewer that
		 * reads all of it instead of trusting a verdict it could not fully ground. */
		if (settings.decision.escalateOnTruncation && verdict.truncated > 0) {
			reviewerLog({ kind: "decision-truncated", session: agent.session.id, tool: request.toolName, probability: verdict.probability, truncatedHistoryEntries: verdict.truncated });
			return {
				...await chatReview(ctx, snapshot, userText, signal),
				escalatedFrom: "decision-truncated",
				decisionProbability: verdict.probability,
				truncated: verdict.truncated
			};
		}
		if (verdict.kind === "allow") return verdict;
		/* A classifier cannot phrase a reason, so a medium denial is confirmed by
		 * the chat reviewer: the agent receives a real objection, and the stronger
		 * reviewer can override a cheap denial it disagrees with. */
		if (verdict.kind === "deny" && verdict.risk !== "high") {
			if (!settings.decision.confirmDenials) return verdict;
			try {
				const confirmed = await chatReview(ctx, snapshot, userText, signal);
				reviewerLog({ kind: "decision-confirm", session: agent.session.id, tool: request.toolName, probability: verdict.probability, objection: verdict.objection, chatDecision: `${confirmed.risk}/${confirmed.decision}` });
				return {
					...confirmed,
					escalatedFrom: "decision-confirm",
					decisionProbability: verdict.probability,
					truncated: verdict.truncated
				};
			} catch (error) {
				if (isAborted(signal)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				reviewerLog({ kind: "decision-confirm-failure", session: agent.session.id, tool: request.toolName, message });
				ctx.logger?.warn?.(`[auto-review-ww] denial confirmation failed (${message}); keeping the decision-model denial`);
				return verdict;
			}
		}
		if (verdict.kind === "deny") return verdict;
		reviewerLog({ kind: "decision-defer", session: agent.session.id, tool: request.toolName, probability: verdict.probability, riskAnswer: verdict.riskAnswer, objection: verdict.objection });
		return {
			...await chatReview(ctx, snapshot, userText, signal),
			escalatedFrom: "decision-uncertain",
			decisionProbability: verdict.probability,
			truncated: verdict.truncated
		};
	}
	return chatReview(ctx, snapshot, userText, signal);
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
* Append one JSONL evidence line to the reviewer log. The web deployment has no
* reachable console, so this file is the audit trail: route, payload size, the
* model's verbatim output and reasoning, decisions, cache hits and failures.
* Default location is `reviewer.log` next to the installed code; override with
* AUTO_REVIEW_WW_LOG_FILE. The file is truncated at 5 MB so it cannot grow
* without bound.
*/
function reviewerLog(entry) {
	try {
		const nodeFs = process.getBuiltinModule("node:fs");
		const nodeUrl = process.getBuiltinModule("node:url");
		const logPath = process.env.AUTO_REVIEW_WW_LOG_FILE ?? nodeUrl.fileURLToPath(new URL("../reviewer.log", import.meta.url));
		try { if (nodeFs.statSync(logPath).size > 5 * 1024 * 1024) nodeFs.truncateSync(logPath, 0); } catch {}
		nodeFs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
	} catch {}
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
function apply(ctx, config) {
	const permissionPresets = ctx.permissionPresets;
	const settings = reviewerSettings(config, process.env);
	if (settings.problem !== void 0) ctx.logger?.warn?.(`[auto-review-ww] ${settings.problem}; every review uses the chat reviewer`);
	else if (settings.decision.enabled) ctx.logger?.info?.(`[auto-review-ww] decision reviewer enabled: ${settings.decision.apiId}/${settings.decision.model} (mode ${settings.mode}, allow>${settings.decision.allowThreshold}, deny<${settings.decision.denyThreshold}, uncertain->${settings.decision.escalate})`);
	else ctx.logger?.info?.("[auto-review-ww] reviewer mode: chat (set reviewer.decision.apiKey or TYPESAFE_API_KEY/OPENAI_API_KEY to enable the decision reviewer)");
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
				reviewerLog({ kind: "verdict-cache-hit", session: agent.session.id, tool: request.toolName, outcome: cached.outcome });
				if (cached.outcome === "rejected") {
					publishToolReturnReason(agent, request, cached.reasonText);
					return "rejected";
				}
				return "allowed-once";
			}
			const completed = Promise.withResolvers();
			active.add(completed.promise);
			const startedAt = Date.now();
			try {
				const signal = request.signal === void 0 ? lifecycle.signal : AbortSignal.any([request.signal, lifecycle.signal]);
				const reviewSignal = reviewTimeoutMs() > 0 ? AbortSignal.any([signal, AbortSignal.timeout(reviewTimeoutMs())]) : signal;
				let cancelReviewTimer = () => {};
				const review = await Promise.race([
					classifyRisk(ctx, agent, request, reviewSignal, settings).then((decision) => ({
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
					reviewerLog({ kind: "reviewer-failure", session: agent.session.id, tool: request.toolName, message, signalAborted: signal?.aborted ?? null });
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
				reviewerLog({
					kind: "review",
					session: agent.session.id,
					tool: request.toolName,
					mode: d.mode,
					api: d.api,
					route: `${d.provider}/${d.model}`,
					payloadChars: d.payloadChars,
					probability: d.probability ?? null,
					decisionProbability: d.decisionProbability ?? null,
					objection: d.objection ?? null,
					truncatedHistoryEntries: d.truncated ?? 0,
					escalatedFrom: d.escalatedFrom ?? null,
					usage: d.usage ?? null,
					decision: `${d.risk}/${d.decision}`,
					reason: d.reason ?? null,
					raw: d.rawText,
					reasoning: (d.reasoningText || "").slice(0, 1000),
					elapsedMs: Date.now() - startedAt
				});
				ctx.logger?.info?.(`[auto-review-ww] reviewer (${d.mode}) route ${d.provider}/${d.model} payload=${d.payloadChars}ch${d.escalatedFrom === void 0 ? "" : ` escalated=${d.escalatedFrom}`}${d.probability === void 0 ? "" : ` p=${d.probability.toFixed(3)}`}; raw output for "${request.toolName}": ${d.rawText.slice(0, 240)}${d.reasoningText ? ` | reasoning: ${d.reasoningText.slice(0, 240)}` : ""}`);
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
export { apply, inject, name, probeDecisionModel };

