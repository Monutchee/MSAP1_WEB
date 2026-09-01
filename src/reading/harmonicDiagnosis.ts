import type { MeterReadings } from '../api'

export interface HarmonicNominalMismatch {
  configuredHz: 50 | 60
  measuredHz: number
  recommendedHz: 50 | 60
}

/**
 * Diagnoses only the unambiguous supported-nominal swap. It does not infer a
 * configuration from arbitrary or invalid frequency data.
 */
export function harmonicNominalMismatch(
  readings: MeterReadings | undefined,
): HarmonicNominalMismatch | undefined {
  const configured = readings?.timing?.nominal_frequency_hz
  const measured = readings?.frequency.hz
  if ((configured !== 50 && configured !== 60) ||
      !readings?.frequency.valid || measured === undefined || !Number.isFinite(measured)) {
    return undefined
  }
  const alternate: 50 | 60 = configured === 50 ? 60 : 50
  if (Math.abs(measured - alternate) > 2 || Math.abs(measured - configured) < 5) {
    return undefined
  }
  return { configuredHz: configured, measuredHz: measured, recommendedHz: alternate }
}

export function harmonicMismatchMessage(
  mismatch: HarmonicNominalMismatch,
  canConfigure: boolean,
) {
  const action = canConfigure
    ? `select ${mismatch.recommendedHz} Hz under Configuration → Meter.`
    : `ask an administrator to select ${mismatch.recommendedHz} Hz under Configuration → Meter.`
  return `Configured nominal is ${mismatch.configuredHz} Hz; measured grid is ` +
    `${mismatch.measuredHz.toFixed(3)} Hz. Harmonic windows are intentionally rejected—${action}`
}
