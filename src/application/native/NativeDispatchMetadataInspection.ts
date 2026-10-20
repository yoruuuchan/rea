import { z } from "zod";
import { addressedValueSchema } from "../../domain/native/nativeInventory.js";
import {
  nativeDispatchMetadataResultSchema,
  inspectNativeDispatchMetadata,
} from "../../domain/native/objcSwiftMetadata.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { err, ok } from "../../domain/result.js";
import type { AnalysisOperationPort } from "../AnalysisProvider.js";
import type { EnhancedResult } from "../EnhancedToolTypes.js";

/** Source operations for this workflow, shared with capability discovery. */
export const NATIVE_DISPATCH_METADATA_SOURCES = {
  binary: "inspect_native_dispatch_metadata",
  symbols: "list_names",
} as const;

/** Prefer validated binary metadata, otherwise preserve the bound provider's symbol-only coverage. */
export const inspectNativeDispatch = async (
  analysis: AnalysisOperationPort,
  maxRecords: number,
  signal?: AbortSignal,
  objcClassImportAddresses?: readonly string[],
  objcClassImportAddressesComplete?: boolean,
): EnhancedResult => {
  const input = {
    max_records: maxRecords,
    ...(objcClassImportAddresses === undefined
      ? {}
      : {
          objc_class_import_addresses: [...objcClassImportAddresses],
          objc_class_import_addresses_complete:
            objcClassImportAddressesComplete ?? true,
        }),
  };
  const binaryMetadata = await analysis.execute(
    NATIVE_DISPATCH_METADATA_SOURCES.binary,
    input,
    signal === undefined ? {} : { signal },
  );
  if (binaryMetadata.ok)
    return ok(
      jsonValueSchema.parse(
        nativeDispatchMetadataResultSchema.parse(binaryMetadata.value.result),
      ),
    );
  if (binaryMetadata.error._tag !== "AnalysisCapabilityUnavailableError")
    return err(binaryMetadata.error);
  const execution = await analysis.execute(
    NATIVE_DISPATCH_METADATA_SOURCES.symbols,
    {},
    signal === undefined ? {} : { signal },
  );
  if (!execution.ok) return err(execution.error);
  const names = z
    .array(
      z.union([
        addressedValueSchema.strict(),
        addressedValueSchema
          .omit({ value: true })
          .extend({ name: z.string() })
          .strict(),
      ]),
    )
    .safeParse(execution.value.result);
  if (!names.success)
    return err(
      new AnalysisOutputError(
        NATIVE_DISPATCH_METADATA_SOURCES.symbols,
        "provider returned an invalid inventory",
      ),
    );
  const result = inspectNativeDispatchMetadata(
    names.data.map((entry) => ({
      address: entry.address,
      name: "value" in entry ? entry.value : entry.name,
    })),
    maxRecords,
  );
  if (objcClassImportAddresses !== undefined) {
    result.objc_class_import_bindings = [];
    result.objc_class_import_binding_coverage = {
      facet: "objc_class_import_bindings",
      status: "unsupported",
      reason: "Native Mach-O pointer binding inspection is unavailable.",
      examined: 0,
      decoded: 0,
    };
  }
  return ok(
    jsonValueSchema.parse(
      nativeDispatchMetadataResultSchema.parse({
        target_sha256: execution.value.subject?.sha256 ?? null,
        target_architecture: execution.value.subject?.architecture ?? null,
        provider: execution.value.provider,
        analysis_profile_digest:
          execution.value.analysisProfile?.digest ?? null,
        result,
      }),
    ),
  );
};
