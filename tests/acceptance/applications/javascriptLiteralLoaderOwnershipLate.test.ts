import { cliTest } from "../../support/cli/cliFixture.js";
import {
  assertCompetingLoaderOwnership,
  competingLoaderGroups,
} from "./javascriptLiteralLoaderOwnership.js";

const loaders = competingLoaderGroups[2];

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    loaders.map((loader) => ({ surface, loader })),
  ),
)(
  "preserves competing loader ownership for $loader through $surface",
  async ({ surface, loader }, { cli }) => {
    await assertCompetingLoaderOwnership(surface, loader, cli);
  },
);
