import {
  HarmonicPeriod, HarmonicSpectrum, MeterAggregateResult, MeterReadingAttribute,
  MeterReadingQuality, MeterReadings, MeterTenMinuteResult,
} from '../api'

export type ReadingInterval = 'basic' | 'aggregate' | 'min10' | 'hour2'
export type PowerScope = 'a' | 'b' | 'c' | 'total'
export type PowerMetric = 'active' | 'reactive' | 'apparent' | 'factor' | 'displacement'

export interface IntervalChannel {
  index: number
  unit: string
  valid: boolean
  rms: number
}

export interface ReadingRecord {
  interval: ReadingInterval
  attributes: MeterReadingAttribute[]
  channels: IntervalChannel[]
  sequence: number
  configurationGeneration: number
  firstSampleIndex: number | undefined
  sampleCount: number | undefined
  timeQuality: 'unsynchronized' | 'synchronized' | 'holdover' | undefined
  utcStartNanoseconds: number | undefined
  utcUncertaintyNanoseconds: number | undefined
  recordComplete: boolean
  timeAligned?: boolean
  boundaryValid?: boolean
  contaminated?: boolean
  arithmeticError: boolean
  flags: string[]
}

export type CompleteRecordCache = Partial<Record<ReadingInterval, ReadingRecord>>
export type IntervalPresentationState = 'waiting' | 'priming' | 'ready' | 'rejected'
export type HarmonicPresentationState =
  | 'waiting' | 'priming' | 'ready' | 'rejected' | 'invalid'
export type HarmonicSpectrumCache = Partial<Record<HarmonicPeriod, HarmonicSpectrum>>

export const READING_INTERVAL_LABELS: Record<ReadingInterval, string> = {
  basic: '10/12-cycle finalized',
  aggregate: '150/180-cycle aggregate',
  min10: '10-minute finalized',
  hour2: '2-hour finalized',
}

export const READING_HARMONIC_PERIODS: Record<ReadingInterval, HarmonicPeriod> = {
  basic: 'basic',
  aggregate: 'cycles_150_180',
  min10: 'minutes_10',
  hour2: 'hours_2',
}

export function harmonicPeriodForReadingInterval(interval: ReadingInterval) {
  return READING_HARMONIC_PERIODS[interval]
}

export const POWER_SCOPES: PowerScope[] = ['a', 'b', 'c', 'total']

export const POWER_SCOPE_LABELS: Record<PowerScope, string> = {
  a: 'Phase A',
  b: 'Phase B',
  c: 'Phase C',
  total: 'Total',
}

export const POWER_METRICS: Array<{
  id: PowerMetric
  label: string
  shortLabel: string
  unit: string
  digits: number
}> = [
  { id: 'active', label: 'Active power', shortLabel: 'P', unit: 'W', digits: 2 },
  { id: 'reactive', label: 'Fundamental reactive power', shortLabel: 'Q₁', unit: 'var', digits: 2 },
  { id: 'apparent', label: 'Apparent power', shortLabel: 'S', unit: 'VA', digits: 2 },
  { id: 'factor', label: 'True power factor', shortLabel: 'PF', unit: '', digits: 4 },
  { id: 'displacement', label: 'Displacement power factor', shortLabel: 'DPF', unit: '', digits: 4 },
]

const POWER_KEY_STEMS: Record<PowerMetric, string> = {
  active: 'power.active',
  reactive: 'power.reactive',
  apparent: 'power.apparent',
  factor: 'power.factor',
  displacement: 'power.factor.displacement',
}

export const FRIENDLY_ATTRIBUTE_NAMES: Record<string, string> = {
  'voltage.ll.ab.rms': 'Line voltage Vab',
  'voltage.ll.bc.rms': 'Line voltage Vbc',
  'voltage.ll.ca.rms': 'Line voltage Vca',
  'unbalance.voltage': 'Voltage unbalance',
  'unbalance.current': 'Current unbalance',
  'unbalance.voltage.zero': 'Voltage zero-sequence ratio',
  'unbalance.current.zero': 'Current zero-sequence ratio',
  'sequence.voltage.zero.rms': 'Zero-sequence voltage V₀',
  'sequence.voltage.positive.rms': 'Positive-sequence voltage V₁',
  'sequence.voltage.negative.rms': 'Negative-sequence voltage V₂',
  'sequence.current.zero.rms': 'Zero-sequence current I₀',
  'sequence.current.positive.rms': 'Positive-sequence current I₁',
  'sequence.current.negative.rms': 'Negative-sequence current I₂',
  'phase.angle.voltage.a': 'Voltage A phase angle',
  'phase.angle.voltage.b': 'Voltage B phase angle',
  'phase.angle.voltage.c': 'Voltage C phase angle',
  'phase.angle.current.a': 'Current A phase angle',
  'phase.angle.current.b': 'Current B phase angle',
  'phase.angle.current.c': 'Current C phase angle',
}

for (const scope of POWER_SCOPES) {
  const scopeLabel = POWER_SCOPE_LABELS[scope]
  for (const metric of POWER_METRICS) {
    FRIENDLY_ATTRIBUTE_NAMES[`${POWER_KEY_STEMS[metric.id]}.${scope}`] =
      `${scopeLabel} ${metric.label.toLowerCase()}`
  }
}

function sourcesMatch(sequence: number, attributes: MeterReadingAttribute[]) {
  return attributes.length > 0 && attributes.every((attribute) =>
    attribute.source_sequence === sequence)
}

function buildRecord(
  interval: ReadingInterval,
  source: {
    sequence: number
    configuration_generation: number
    attributes: MeterReadingAttribute[]
    channels: IntervalChannel[]
    record_complete: boolean
    first_sample_index?: number
    sample_count?: number
  },
  context: Omit<ReadingRecord,
    'interval' | 'sequence' | 'configurationGeneration' | 'firstSampleIndex' | 'sampleCount' |
    'attributes' | 'channels' | 'recordComplete'>,
): ReadingRecord {
  return {
    interval,
    sequence: source.sequence,
    configurationGeneration: source.configuration_generation,
    firstSampleIndex: source.first_sample_index,
    sampleCount: source.sample_count,
    attributes: source.attributes,
    channels: source.channels,
    recordComplete: source.record_complete && sourcesMatch(source.sequence, source.attributes),
    ...context,
  }
}

export function basicReadingRecord(readings: MeterReadings | undefined): ReadingRecord | undefined {
  if (!readings) return undefined
  const flags: string[] = []
  if (readings.timing?.free_run_fallback) flags.push('Free-run fallback')
  if (readings.timing && !readings.timing.cycle_locked) flags.push('Cycle unlocked')
  return buildRecord('basic', {
    sequence: readings.sequence,
    configuration_generation: readings.configuration_generation,
    attributes: readings.attributes ?? [],
    channels: readings.channels,
    record_complete: readings.record_complete,
    first_sample_index: readings.timing?.first_sample_index,
    sample_count: readings.timing?.sample_count,
  }, {
    timeQuality: readings.timing?.time_quality,
    utcStartNanoseconds: readings.timing?.utc_start_nanoseconds,
    utcUncertaintyNanoseconds: readings.timing?.utc_uncertainty_nanoseconds,
    contaminated: false,
    arithmeticError: (readings.attributes ?? []).some((attribute) =>
      attribute.quality === 'arithmetic_error'),
    flags,
  })
}

export function aggregateReadingRecord(
  interval: Exclude<ReadingInterval, 'basic'>,
  result: MeterAggregateResult | MeterTenMinuteResult | undefined,
): ReadingRecord | undefined {
  if (!result) return undefined
  const flags: string[] = []
  if (result.arithmetic_error) flags.push('Arithmetic error')
  if ('contaminated' in result && result.contaminated) flags.push('Contaminated interval')
  if ('boundary_valid' in result && !result.boundary_valid) flags.push('Boundary invalid')
  if ('time_aligned' in result && !result.time_aligned) flags.push('Time alignment unavailable')
  return buildRecord(interval, result, {
    timeQuality: result.time_quality,
    utcStartNanoseconds: result.utc_start_nanoseconds,
    utcUncertaintyNanoseconds: result.utc_uncertainty_nanoseconds,
    timeAligned: 'time_aligned' in result ? result.time_aligned : undefined,
    boundaryValid: 'boundary_valid' in result ? result.boundary_valid : undefined,
    contaminated: 'contaminated' in result ? result.contaminated : false,
    arithmeticError: result.arithmetic_error,
    flags,
  })
}

function generationMatches(generation: number, activeGeneration: number | undefined) {
  return activeGeneration === undefined || generation === activeGeneration
}

/** Uint32 serial arithmetic; a backwards jump indicates a new producer epoch. */
function sequenceRegressed(candidate: number, cached: number) {
  const delta = (candidate - cached) >>> 0
  return delta !== 0 && delta >= 0x80000000
}

export function isUsableReadingRecord(record: ReadingRecord | undefined) {
  if (!record?.recordComplete) return false
  if (record.interval !== 'min10' && record.interval !== 'hour2') return true
  return record.timeAligned === true && record.boundaryValid === true &&
    record.contaminated !== true
}

export function updateCompleteRecordCache(
  current: CompleteRecordCache,
  interval: ReadingInterval,
  candidate: ReadingRecord | undefined,
  activeGeneration: number | undefined,
) {
  const next: CompleteRecordCache = {}
  for (const cacheInterval of ['basic', 'aggregate', 'min10', 'hour2'] as ReadingInterval[]) {
    const cached = current[cacheInterval]
    if (cached && generationMatches(cached.configurationGeneration, activeGeneration))
      next[cacheInterval] = cached
  }
  if (candidate && generationMatches(candidate.configurationGeneration, activeGeneration)) {
    const cached = next[interval]
    if (cached && sequenceRegressed(candidate.sequence, cached.sequence)) {
      for (const cacheInterval of Object.keys(next) as ReadingInterval[])
        delete next[cacheInterval]
    }
    if (isUsableReadingRecord(candidate)) next[interval] = candidate
  }
  return next
}

export function selectCommittedRecord(
  cache: CompleteRecordCache,
  interval: ReadingInterval,
  candidate: ReadingRecord | undefined,
  activeGeneration: number | undefined,
) {
  const matchingCandidate = candidate &&
    generationMatches(candidate.configurationGeneration, activeGeneration)
      ? candidate : undefined
  const cached = cache[interval]
  if (matchingCandidate && cached &&
      matchingCandidate.configurationGeneration === cached.configurationGeneration &&
      sequenceRegressed(matchingCandidate.sequence, cached.sequence)) return isUsableReadingRecord(
    matchingCandidate) ? matchingCandidate : undefined
  if (isUsableReadingRecord(matchingCandidate)) return matchingCandidate
  return cached && generationMatches(cached.configurationGeneration, activeGeneration)
    ? cached : undefined
}

export function intervalPresentationState(
  candidate: ReadingRecord | undefined,
  committed: ReadingRecord | undefined,
  activeGeneration: number | undefined,
): IntervalPresentationState {
  const matchingCandidate = candidate &&
    generationMatches(candidate.configurationGeneration, activeGeneration)
      ? candidate : undefined
  if (isUsableReadingRecord(matchingCandidate)) return 'ready'
  if (matchingCandidate?.recordComplete &&
      (matchingCandidate.interval === 'min10' || matchingCandidate.interval === 'hour2'))
    return committed ? 'rejected' : 'priming'
  return committed ? 'ready' : 'waiting'
}

function harmonicIsLong(period: HarmonicPeriod) {
  return period === 'minutes_10' || period === 'hours_2'
}

export function isUsableHarmonicSpectrum(spectrum: HarmonicSpectrum | undefined) {
  if (!spectrum?.available || !spectrum.interval_valid) return false
  return !harmonicIsLong(spectrum.period) ||
    (spectrum.time_aligned && !spectrum.contaminated)
}

/**
 * Return a harmonic family only when its physical interval is exactly the
 * committed scalar record. This prevents a newer family from being rendered
 * beside cached power values during independent endpoint polling.
 */
export function matchingHarmonicSpectrum(
  record: ReadingRecord | undefined,
  spectrum: HarmonicSpectrum | undefined,
) {
  if (!record || !spectrum?.available || record.firstSampleIndex === undefined ||
      record.sampleCount === undefined) return undefined
  return spectrum.period === harmonicPeriodForReadingInterval(record.interval) &&
    spectrum.configuration_generation === record.configurationGeneration &&
    spectrum.first_sample === record.firstSampleIndex &&
    spectrum.sample_count === record.sampleCount
    ? spectrum : undefined
}

export function updateHarmonicSpectrumCache(
  current: HarmonicSpectrumCache,
  period: HarmonicPeriod,
  candidate: HarmonicSpectrum | undefined,
  activeGeneration: number | undefined,
) {
  const next: HarmonicSpectrumCache = {}
  for (const cachePeriod of ['basic', 'cycles_150_180', 'minutes_10', 'hours_2'] as HarmonicPeriod[]) {
    const cached = current[cachePeriod]
    if (cached && generationMatches(cached.configuration_generation, activeGeneration))
      next[cachePeriod] = cached
  }
  if (candidate && generationMatches(candidate.configuration_generation, activeGeneration)) {
    const cached = next[period]
    if (cached && sequenceRegressed(candidate.sequence, cached.sequence)) {
      for (const cachePeriod of Object.keys(next) as HarmonicPeriod[])
        delete next[cachePeriod]
    }
    if (isUsableHarmonicSpectrum(candidate)) next[period] = candidate
  }
  return next
}

export function selectHarmonicSpectrum(
  cache: HarmonicSpectrumCache,
  period: HarmonicPeriod,
  candidate: HarmonicSpectrum | undefined,
  activeGeneration: number | undefined,
) {
  const matchingCandidate = candidate &&
    generationMatches(candidate.configuration_generation, activeGeneration)
      ? candidate : undefined
  const cached = cache[period]
  if (matchingCandidate && cached &&
      matchingCandidate.configuration_generation === cached.configuration_generation &&
      sequenceRegressed(matchingCandidate.sequence, cached.sequence))
    return isUsableHarmonicSpectrum(matchingCandidate) ? matchingCandidate : undefined
  if (isUsableHarmonicSpectrum(matchingCandidate)) return matchingCandidate
  return cached && generationMatches(cached.configuration_generation, activeGeneration)
    ? cached : undefined
}

export function harmonicPresentationState(
  candidate: HarmonicSpectrum | undefined,
  committed: HarmonicSpectrum | undefined,
  activeGeneration: number | undefined,
): HarmonicPresentationState {
  const matchingCandidate = candidate &&
    generationMatches(candidate.configuration_generation, activeGeneration)
      ? candidate : undefined
  if (isUsableHarmonicSpectrum(matchingCandidate)) return 'ready'
  if (matchingCandidate?.available) {
    if (harmonicIsLong(matchingCandidate.period) &&
        (!matchingCandidate.time_aligned || matchingCandidate.contaminated))
      return committed ? 'rejected' : 'priming'
    if (!matchingCandidate.interval_valid) return 'invalid'
  }
  return committed ? 'ready' : 'waiting'
}

export function attribute(record: ReadingRecord | undefined, key: string) {
  return record?.attributes.find((candidate) => candidate.key === key)
}

export function powerAttribute(
  record: ReadingRecord | undefined,
  metric: PowerMetric,
  scope: PowerScope,
) {
  return attribute(record, `${POWER_KEY_STEMS[metric]}.${scope}`)
}

export function effectiveQuality(reading: MeterReadingAttribute | undefined): MeterReadingQuality {
  if (!reading) return 'unavailable'
  if (!Number.isFinite(reading.value) && reading.quality === 'valid') return 'invalid'
  return reading.quality
}

export function isValidReading(reading: MeterReadingAttribute | undefined): reading is MeterReadingAttribute {
  return effectiveQuality(reading) === 'valid'
}

export function normalizeForPrecision(value: number, digits: number) {
  if (!Number.isFinite(value)) return value
  const threshold = 0.5 / 10 ** digits
  return Math.abs(value) < threshold ? 0 : value
}

export function formatReading(
  reading: MeterReadingAttribute | undefined,
  digits: number,
  includeUnit = true,
) {
  const quality = effectiveQuality(reading)
  if (quality === 'unavailable') return '—'
  if (quality !== 'valid' || !reading) return 'Invalid'
  const value = normalizeForPrecision(reading.value, digits).toFixed(digits)
  if (includeUnit && reading.unit === 'deg') return `${value}°`
  return includeUnit && reading.unit && reading.unit !== 'PF'
    ? `${value} ${reading.unit}`
    : value
}

export function formatUtc(nanoseconds: number | undefined) {
  if (nanoseconds === undefined || !Number.isFinite(nanoseconds)) return 'UTC unavailable'
  const date = new Date(nanoseconds / 1_000_000)
  if (!Number.isFinite(date.getTime())) return 'UTC unavailable'
  return `${date.toISOString().replace('T', ' ').replace('Z', '')} UTC`
}

export type VisibleQuality = 'valid' | 'partial' | 'invalid'

export function visibleQuality(readings: Array<MeterReadingAttribute | undefined>): VisibleQuality {
  const qualities = readings.map(effectiveQuality)
  if (qualities.some((quality) => quality !== 'valid' && quality !== 'unavailable')) return 'invalid'
  if (qualities.some((quality) => quality === 'unavailable')) return 'partial'
  return 'valid'
}

export function operatingMode(
  active: MeterReadingAttribute | undefined,
  reactive: MeterReadingAttribute | undefined,
) {
  if (!isValidReading(active) || !isValidReading(reactive)) return 'Operating mode unavailable'
  const p = normalizeForPrecision(active.value, 2)
  const q = normalizeForPrecision(reactive.value, 2)
  if (p === 0 && q === 0) return 'No power flow'
  const activeMode = p > 0 ? 'Import' : p < 0 ? 'Export' : 'No active transfer'
  const reactiveMode = q > 0
    ? 'Inductive/lagging'
    : q < 0 ? 'Capacitive/leading' : 'Reactive power near zero'
  return `${activeMode} · ${reactiveMode}`
}

export function pqResultant(active: number, reactive: number) {
  return Math.hypot(active, reactive)
}

function niceCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const magnitude = 10 ** exponent
  const normalized = value / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

export function buildStableChartScale(active: number, reactive: number, apparent: number) {
  const maximum = Math.max(
    Math.abs(active), Math.abs(reactive), Math.abs(apparent), pqResultant(active, reactive), 1,
  )
  return niceCeiling(maximum * 1.15)
}

export function growStableChartScale(active: number, reactive: number, apparent: number) {
  const maximum = Math.max(
    Math.abs(active), Math.abs(reactive), Math.abs(apparent), pqResultant(active, reactive), 1,
  )
  return niceCeiling(maximum / .85)
}

export function chartMagnitude(active: number, reactive: number, apparent: number) {
  return Math.max(Math.abs(active), Math.abs(reactive), Math.abs(apparent), pqResultant(active, reactive))
}

export function friendlyAttributeName(key: string) {
  return FRIENDLY_ATTRIBUTE_NAMES[key] ?? key
}
