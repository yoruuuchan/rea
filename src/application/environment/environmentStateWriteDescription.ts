import type {
  StateWritePlan,
  WriteBody,
} from "../../domain/analysisView/environmentStateWriteRules.js";
import { describeList, quotedName } from "./environmentTools.js";

/** Captured member names, quoted and sampled as response fields are; the plan in the state Evidence holds every one. */
const members = (names: readonly string[]): string =>
  describeList(names, names.length, quotedName, "state Evidence");

/** The body members a served write accepts, as a description clause. */
const bodyClause = (
  body: WriteBody,
  effect: StateWritePlan["effect"],
): string => {
  const parts: string[] = [];
  if (body.accepted.length > 0)
    parts.push(`body members ${members(body.accepted)}`);
  if (body.fixed.length > 0)
    parts.push(
      `${members(body.fixed.map(({ member }) => member))} only with the value the capture sent`,
    );
  if (body.required.length > 0)
    parts.push(`required: ${members(body.required)}`);
  else if (effect === "update") parts.push("send at least one");
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
};

/** What a served write tool does to the state, for its description; undefined for a tool the state does not serve. */
export const describeWrite = (
  plan: StateWritePlan | undefined,
): string | undefined => {
  if (plan?.served !== true) return undefined;
  const body = plan.body === null ? "" : bodyClause(plan.body, plan.effect);
  switch (plan.effect) {
    case "create":
      return `creates an entity of ${plan.target ?? ""} in the served environment state${body}, modelled on the recorded calls`;
    case "update":
      return `changes the entity the path names in the served environment state${body}, modelled on the recorded calls`;
    case "delete":
      return "removes the entity the path names from the served environment state, modelled on the recorded calls";
    case "document":
      return `changes a document of the served environment state${body}, modelled on the recorded calls`;
    case "none":
      return undefined;
  }
};
