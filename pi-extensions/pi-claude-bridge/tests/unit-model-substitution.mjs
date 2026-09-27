import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sameBridgeModel, updateTurnOutputModel, noteModelSubstitution } from "../src/assistant-stream.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { setSharedSession, sharedSession } from "../src/bridge-state.ts";

const model = {
	api: "claude-bridge",
	provider: "pi-claude",
	id: "claude-opus-5-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("reported-model guard", () => {
	beforeEach(() => {
		resetStack();
		setSharedSession(null);
	});

	it("treats snapshot and context-window variants as the same model", () => {
		assert.ok(sameBridgeModel("claude-opus-5-5", "claude-opus-5-5[1m]"));
		assert.ok(sameBridgeModel("claude-opus-5-5", "claude-opus-5-5-20260922"));
		assert.ok(!sameBridgeModel("claude-opus-5-5", "claude-opus-5"));
		assert.ok(!sameBridgeModel("claude-fable-5-1", "claude-opus-5-5"));
	});

	it("keeps the requested id on the pi turn when Claude Code answers with another model, and restarts the Claude session next prompt", () => {
		const c = ctx();
		c.resetTurnState(model);
		setSharedSession({ sessionId: "s1", cursor: 3 });
		updateTurnOutputModel("claude-opus-5-5[1m]");
		assert.equal(c.turnOutput.model, "claude-opus-5-5", "variant of the requested model is not a substitution");
		assert.equal(sharedSession.needsRebuild, undefined);
		updateTurnOutputModel("claude-opus-5");
		assert.equal(c.turnOutput.model, "claude-opus-5-5", "the substituted id never reaches the pi session");
		assert.equal(sharedSession.needsRebuild, true);
		assert.equal(sharedSession.forceRotate, true);
		assert.equal(sharedSession.rebuildReason, "model-substitution");
		assert.equal(c.modelSubstitutionNoted, true);
	});

	it("ignores synthetic frames and notes a substitution once per turn", () => {
		const c = ctx();
		c.resetTurnState(model);
		updateTurnOutputModel("<synthetic>");
		assert.equal(c.turnOutput.model, "claude-opus-5-5");
		assert.equal(c.modelSubstitutionNoted, false);
		noteModelSubstitution("claude-fable-5-1", "claude-opus-5", "model_refusal_fallback");
		noteModelSubstitution("claude-fable-5-1", "claude-opus-5", "assistant");
		assert.equal(c.modelSubstitutionNoted, true);
		c.resetTurnState(model);
		assert.equal(c.modelSubstitutionNoted, false, "a new pi turn may report again");
	});
});
