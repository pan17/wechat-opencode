/**
 * wechat-opencode — public API
 */

export { WeChatOpencodeBridge } from "./bridge.js";
export type {
	AgentCommandConfig,
	AgentPreset,
	ResolvedAgentConfig,
	WeChatOpencodeConfig,
} from "./config.js";
export {
	BUILT_IN_AGENTS,
	defaultConfig,
	listBuiltInAgents,
	parseAgentCommand,
	resolveAgentSelection,
} from "./config.js";
