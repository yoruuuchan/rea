import { expect, it } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";
import {
  assertCompetingLoaderOwnership,
  competingLoaderGroups,
  competingLoaderNames,
} from "./javascriptLiteralLoaderOwnership.js";

const loaders = competingLoaderGroups[0];

it("partitions every competing loader across the three ownership files", () => {
  const assigned = competingLoaderGroups.flat();
  expect(assigned).toEqual(competingLoaderNames);
  expect(new Set(assigned).size).toBe(competingLoaderNames.length);
  for (const group of competingLoaderGroups)
    expect(group.length).toBeGreaterThan(0);
});

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
