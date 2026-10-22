import { ByteEntropyService } from "../application/binaryDiagnostics/ByteEntropyService.js";
import { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../native/pwntools/PwntoolsRecordedCrashProvider.js";
import { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { PwntoolsLayoutProvider } from "../native/pwntools/PwntoolsLayoutProvider.js";
import { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import { PeResourcesProvider } from "../native/pe/PeResourcesProvider.js";
import { ElfNotesService } from "../application/binaryDiagnostics/ElfNotesService.js";
import { ElfNotesProvider } from "../native/elf/ElfNotesProvider.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

/** Portable PE inspection with no engine, installation or target acquisition. */
export const createPeResourcesService = (): PeResourcesService =>
  new PeResourcesService(new PeResourcesProvider());

/** Portable ELF note-table inspection with no engine or package catalog. */
export const createElfNotesService = (): ElfNotesService =>
  new ElfNotesService(new ElfNotesProvider());

/** Compose the offline adapter without import-time I/O or dependency acquisition. */
export const createBinaryLayoutService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): BinaryLayoutService =>
  new BinaryLayoutService(new PwntoolsLayoutProvider(environment));

/** Compose recorded-core inspection without acquiring a debugger or toolchain. */
export const createRecordedCrashService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RecordedCrashService =>
  new RecordedCrashService(new PwntoolsRecordedCrashProvider(environment));

/** Provider-free local byte analysis. */
export const createByteEntropyService = (
  resources?: ArtifactResourceScope,
): ByteEntropyService => new ByteEntropyService(undefined, resources);
