import { describe, expect, it } from 'vitest'
import type { MeterReadings } from '../api'
import { harmonicNominalMismatch } from './harmonicDiagnosis'

function readings(configured: number, measured: number, valid = true) {
  return {
    frequency: { valid, hz: measured },
    timing: { nominal_frequency_hz: configured },
  } as MeterReadings
}

describe('harmonic nominal-frequency diagnosis', () => {
  it('diagnoses both supported nominal swaps', () => {
    expect(harmonicNominalMismatch(readings(60, 49.998))).toEqual({
      configuredHz: 60, measuredHz: 49.998, recommendedHz: 50,
    })
    expect(harmonicNominalMismatch(readings(50, 60.001))).toEqual({
      configuredHz: 50, measuredHz: 60.001, recommendedHz: 60,
    })
  })

  it('does not recommend a change for matching, ambiguous, or invalid readings', () => {
    expect(harmonicNominalMismatch(readings(60, 59.99))).toBeUndefined()
    expect(harmonicNominalMismatch(readings(60, 54))).toBeUndefined()
    expect(harmonicNominalMismatch(readings(60, 50, false))).toBeUndefined()
    expect(harmonicNominalMismatch(readings(55, 50))).toBeUndefined()
  })
})
