import { resolveAsarHeaderAdmission } from "../artifacts/AsarHeader.js";
import type { ElectronObservationPort } from "../application/javascript/ElectronObservationPort.js";
import { CdpElectronProvider } from "../browser/CdpElectronProvider.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createElectronObservationProvider = (
  environment: Readonly<Record<string, string | undefined>>,
): ElectronObservationPort =>
  new CdpElectronProvider(resolveAsarHeaderAdmission(environment));
