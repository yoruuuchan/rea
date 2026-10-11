import { z } from "zod";

/** Explicit coverage state for a provider's observed caller/callee set. */
export const relationshipCoverageSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }),
  z.strictObject({
    status: z.literal("partial"),
    limitations: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);

export type RelationshipCoverage = z.infer<typeof relationshipCoverageSchema>;
