import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import {
  replayEnvironmentTool,
  type ReplayArguments,
  type ReplayResult,
} from "./environmentReplay.js";
import type {
  EnvironmentManifestTool,
  EnvironmentSource,
} from "./environmentSource.js";
import { answerFromState } from "./environmentStateAnswer.js";
import type { EnvironmentStateStore } from "./environmentStateStore.js";
import { answerWrite } from "./environmentStateWriteAnswer.js";

/** How a served environment answers one tool call. */
export type EnvironmentToolAnswer = (
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
) => Result<ReplayResult, AnalysisError>;

/** The answer a served environment gives: replay without a state store; with one, a served write applies to the live state and a read answers from it. */
export const environmentToolAnswer = (
  source: EnvironmentSource,
  store: EnvironmentStateStore | undefined,
): EnvironmentToolAnswer =>
  store === undefined
    ? (tool, args) => replayEnvironmentTool(source, tool, args)
    : (tool, args) => {
        const plan = store.state.writes.get(tool.name);
        return plan?.served === true
          ? answerWrite({ source, store }, { tool, plan, args })
          : answerFromState({ source, store }, tool, args);
      };
