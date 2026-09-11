// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const FABLE_MODEL_ID = "claude-fable-5-1";
export const FABLE_5_MODEL_ID = "claude-fable-5";
// Opus 4.8 remains the preferred implementation model. It is NOT a Fable
// fallback: a Fable request never changes model, on any path (no SDK
// `fallbackModel`, no router substitution). Fable is the reason for the
// subscription; when its allowance is spent the session waits for the reset.
export const OPUS_4_8_MODEL_ID = "claude-opus-4-8";
export const OPUS_5_MODEL_ID = "claude-opus-5";
export const SONNET_5_MODEL_ID = "claude-sonnet-5";

export const MODEL_IDS_IN_ORDER = [
	FABLE_MODEL_ID,
	FABLE_5_MODEL_ID,
	OPUS_4_8_MODEL_ID,
	OPUS_5_MODEL_ID,
	"claude-opus-4-7",
	"claude-opus-4-6",
	SONNET_5_MODEL_ID,
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
];

type BridgeModelMetadata = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const CLAUDE_FIVE_LEVEL_EFFORT_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const CLAUDE_FIVE_LEVEL_MODEL_IDS = new Set([
	FABLE_MODEL_ID,
	FABLE_5_MODEL_ID,
	OPUS_4_8_MODEL_ID,
	OPUS_5_MODEL_ID,
]);

const FALLBACK_MODELS: Record<string, BridgeModelMetadata> = {
	[FABLE_MODEL_ID]: {
		id: FABLE_MODEL_ID,
		name: "Claude Fable 5.1",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FIVE_LEVEL_EFFORT_MAP,
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_5_MODEL_ID]: {
		id: FABLE_5_MODEL_ID,
		name: "Claude Fable 5",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FIVE_LEVEL_EFFORT_MAP,
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[OPUS_4_8_MODEL_ID]: {
		id: OPUS_4_8_MODEL_ID,
		name: "Claude Opus 4.8",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FIVE_LEVEL_EFFORT_MAP,
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[OPUS_5_MODEL_ID]: {
		id: OPUS_5_MODEL_ID,
		name: "Claude Opus 5",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FIVE_LEVEL_EFFORT_MAP,
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[SONNET_5_MODEL_ID]: {
		id: SONNET_5_MODEL_ID,
		name: "Claude Sonnet 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
};

// Human label for model-change notices (Claude Code's own model_refusal_fallback
// event); the raw id is the last-resort label so an unmapped id still reads.
export function modelDisplayName(modelId: string): string {
	return FALLBACK_MODELS[modelId]?.name ?? modelId;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep MODEL_IDS_IN_ORDER ordering, and fill bridge-owned future IDs when pi-ai
// has not shipped metadata for them yet. Unknown missing IDs are still dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id) ?? FALLBACK_MODELS[id])
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning,
			input,
			contextWindow,
			maxTokens,
			thinkingLevelMap: CLAUDE_FIVE_LEVEL_MODEL_IDS.has(id)
				? CLAUDE_FIVE_LEVEL_EFFORT_MAP
				: thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	const match = models.find((m) => m.id === lower || m.id.includes(lower));
	return match ? match.id : input;
}
