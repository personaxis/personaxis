/**
 * What the turn collector keeps besides the answer: the agent's reasoning and how full
 * its context window is. Compaction reads the second, and the first is kept so that it
 * is never mistaken for the answer. Neither getter was read by any test in this package.
 */

import { describe, expect, it } from "vitest";

import { AcpTurnCollector } from "./provider.js";

describe("AcpTurnCollector, beyond the answer", () => {
	it("keeps the reasoning apart from the answer", () => {
		const collector = new AcpTurnCollector();
		collector.begin();
		collector.sessionUpdate({ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } });
		collector.sessionUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
		expect(collector.thoughts).toBe("thinking");
	});

	it("reports the context window only once the agent has said how full it is", () => {
		const collector = new AcpTurnCollector();
		collector.begin();
		expect(collector.context).toEqual({});
		collector.sessionUpdate({ update: { sessionUpdate: "usage_update", used: 1200, size: 8000 } });
		expect(collector.context).toEqual({ used: 1200, size: 8000 });
	});
});
