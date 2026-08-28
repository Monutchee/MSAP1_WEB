import { describe, expect, it } from 'vitest'
import type { MeterReadingAttribute, MeterReadings } from '../api'
import {
  basicReadingRecord, buildStableChartScale, chartMagnitude, effectiveQuality,
  formatReading, formatUtc, normalizeForPrecision, operatingMode, pqResultant,
  growStableChartScale, selectCommittedRecord, updateCompleteRecordCache, visibleQuality,
  type ReadingRecord,
} from './readingModel'

function reading(
  key: string,
  value: number,
  quality: MeterReadingAttribute['quality'] = 'valid',
  sequence = 41,
  unit = 'W',
): MeterReadingAttribute {
  return { key, value, unit, quality, source_sequence: sequence, valid: quality === 'valid' }
}

function basic(attributes: MeterReadingAttribute[], overrides: Partial<MeterReadings> = {}): MeterReadings {
  return {
    sequence: 41,
    configuration_generation: 7,
    sample_rate_hz: 32_000,
    block_sample_count: 3_200,
    status: 0,
    capture_frames: 0,
    header_errors: 0,
    fifo_overflows: 0,
    emit_drops: 0,
    result_drops: 0,
    frequency: {
      enabled: true, valid: true, reference_valid: true, out_of_range: false,
      timed_out: false, arithmetic_error: false, hz: 50, millihz: 50_000,
      period_q16_samples: 0, measurement_sequence: 41, mode: 0,
      reference_channel: 0, cycles_used: 10,
    },
    channels: [],
    attributes,
    record_complete: true,
    timing: {
      block_sequence: 41, first_sample_index: 0, sample_count: 3_200,
      cycle_count: 10, nominal_frequency_hz: 50, cycle_locked: true,
      free_run_fallback: false, time_quality: 'synchronized',
      utc_start_nanoseconds: Date.UTC(2026, 7, 28, 12, 3, 20, 200) * 1_000_000,
      utc_uncertainty_nanoseconds: 250_000,
    },
    ...overrides,
  }
}

function record(sequence: number, generation: number, complete: boolean): ReadingRecord {
  return {
    interval: 'basic', attributes: [reading('power.active.total', 10, 'valid', sequence)],
    channels: [], sequence, configurationGeneration: generation,
    timeQuality: 'synchronized', utcStartNanoseconds: undefined,
    utcUncertaintyNanoseconds: undefined, recordComplete: complete,
    arithmeticError: false, flags: [],
  }
}

describe('reading record adapter', () => {
  it('commits only complete records whose source sequences agree', () => {
    const coherent = basicReadingRecord(basic([
      reading('power.active.total', 1084.97),
      reading('power.reactive.total', -62.52, 'valid', 41, 'var'),
    ]))
    expect(coherent?.recordComplete).toBe(true)
    expect(coherent?.utcStartNanoseconds).toBeDefined()
    expect(coherent?.timeQuality).toBe('synchronized')

    const mixed = basicReadingRecord(basic([
      reading('power.active.total', 1084.97),
      reading('power.reactive.total', -62.52, 'valid', 40, 'var'),
    ]))
    expect(mixed?.recordComplete).toBe(false)
  })

  it('retains a brief incomplete sibling update and invalidates on generation change', () => {
    const complete = record(41, 7, true)
    const cache = updateCompleteRecordCache({}, 'basic', complete, 7)
    expect(selectCommittedRecord(cache, 'basic', record(42, 7, false), 7)?.sequence).toBe(41)
    expect(selectCommittedRecord(cache, 'basic', record(1, 8, false), 8)).toBeUndefined()
    expect(updateCompleteRecordCache(cache, 'basic', record(1, 8, false), 8)).toEqual({})
  })

  it('keeps interval caches independent and replaces a selected interval atomically', () => {
    const basicRecord = record(41, 7, true)
    const aggregateRecord = { ...record(8, 7, true), interval: 'aggregate' as const }
    let cache = updateCompleteRecordCache({}, 'basic', basicRecord, 7)
    cache = updateCompleteRecordCache(cache, 'aggregate', aggregateRecord, 7)
    expect(selectCommittedRecord(cache, 'basic', undefined, 7)?.sequence).toBe(41)
    expect(selectCommittedRecord(cache, 'aggregate', undefined, 7)?.sequence).toBe(8)
  })
})

describe('reading quality and formatting', () => {
  it('preserves exact quality and separates unavailable from invalid values', () => {
    expect(formatReading(undefined, 2)).toBe('—')
    expect(formatReading(reading('x', 10, 'unavailable'), 2)).toBe('—')
    for (const quality of ['invalid', 'out_of_range', 'timed_out', 'arithmetic_error'] as const) {
      const value = reading('x', 10, quality)
      expect(effectiveQuality(value)).toBe(quality)
      expect(formatReading(value, 2)).toBe('Invalid')
    }
    expect(formatReading(reading('x', Number.NaN), 2)).toBe('Invalid')
    expect(formatReading(reading('x', Number.POSITIVE_INFINITY), 2)).toBe('Invalid')
    expect(visibleQuality([reading('x', 1), reading('y', 0, 'unavailable')])).toBe('partial')
  })

  it('normalizes values that round to negative zero', () => {
    expect(normalizeForPrecision(-0.004, 2)).toBe(0)
    expect(formatReading(reading('power.reactive.b', -0.004, 'valid', 41, 'var'), 2))
      .toBe('0.00 var')
  })

  it('renders degree readings with the degree symbol', () => {
    expect(formatReading(reading(
      'phase.angle.voltage.b', 239.999, 'valid', 41, 'deg',
    ), 3)).toBe('239.999°')
  })

  it('formats measurement UTC only when supplied', () => {
    expect(formatUtc(Date.UTC(2026, 7, 28, 12, 3, 20, 200) * 1_000_000))
      .toBe('2026-08-28 12:03:20.200 UTC')
    expect(formatUtc(undefined)).toBe('UTC unavailable')
  })
})

describe('signed P-Q behavior and engineering scale', () => {
  const p = (value: number) => reading('power.active.total', value)
  const q = (value: number) => reading('power.reactive.total', value, 'valid', 41, 'var')

  it('names all four quadrants and both zero-axis cases', () => {
    expect(operatingMode(p(10), q(5))).toBe('Import · Inductive/lagging')
    expect(operatingMode(p(-10), q(5))).toBe('Export · Inductive/lagging')
    expect(operatingMode(p(10), q(-5))).toBe('Import · Capacitive/leading')
    expect(operatingMode(p(-10), q(-5))).toBe('Export · Capacitive/leading')
    expect(operatingMode(p(10), q(0))).toBe('Import · Reactive power near zero')
    expect(operatingMode(p(0), q(5))).toBe('No active transfer · Inductive/lagging')
    expect(operatingMode(p(0), q(0))).toBe('No power flow')
  })

  it('uses a symmetric 1/2/5 scale with headroom and keeps S independent', () => {
    expect(buildStableChartScale(1084.97, -62.52, 1091.06)).toBe(2000)
    expect(buildStableChartScale(80, 0, 0)).toBe(100)
    expect(growStableChartScale(87, 0, 0)).toBe(200)
    expect(chartMagnitude(3, 4, 8)).toBe(8)
    expect(pqResultant(3, 4)).toBe(5)
  })
})
