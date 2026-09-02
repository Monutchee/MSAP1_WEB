import type { MeterFrequency10s, MeterFrequency10sResult } from '../api'

const REJECTION_LABELS: Readonly<Record<string, string>> = {
  unsupported_profile: 'Unsupported acquisition profile',
  time_unsynchronized: 'UTC clock discipline was unavailable',
  time_uncertainty: 'UTC uncertainty exceeded the Class A 1 ms limit',
  filter_warmup: 'Frequency filter was still warming up',
  reference_invalid: 'CH6 voltage reference was invalid',
  discontinuity: 'Capture discontinuity crossed the interval',
  crossing_overflow: 'Zero-crossing observer overflowed',
  observer_drop: 'Zero-crossing observations were dropped',
  sample_rate_invalid: 'Measured sample rate was not qualified',
  boundary_invalid: 'UTC/sample boundary was invalid',
  calibration_invalid: 'Calibration profile was not qualified',
  insufficient_crossings: 'Too few qualified zero crossings',
  out_of_range: 'Outside the accepted frequency range',
  arithmetic: 'Frequency arithmetic failed',
  transport_gap: 'Transport gap crossed the interval',
  cycle_geometry: 'Zero-crossing geometry was inconsistent',
  time_geometry: 'UTC/sample geometry was inconsistent',
}

function friendlyFlag(value: string) {
  return REJECTION_LABELS[value] ?? value.replaceAll('_', ' ')
}

function clockQualification(result: MeterFrequency10sResult) {
  if (result.class_a_time_qualified) return 'Class A qualified'
  if (result.clock_synchronized) return 'Synchronized · not Class A-qualified'
  if (result.time_quality === 'holdover') return 'Holdover · not Class A-qualified'
  return 'Unsynchronized'
}

function exactInteger(value: string | number) {
  try {
    return new Intl.NumberFormat('en-US').format(BigInt(value))
  } catch {
    return String(value)
  }
}

/**
 * Convert the whole-second part through Date while retaining all nine
 * fractional digits from the authoritative decimal string.
 */
function exactUtc(value: string) {
  try {
    const nanoseconds = BigInt(value)
    const billion = 1_000_000_000n
    const seconds = nanoseconds / billion
    const fraction = nanoseconds % billion
    const date = new Date(Number(seconds) * 1000)
    if (Number.isNaN(date.getTime()) || fraction < 0) return value
    return `${date.toISOString().slice(0, 19)}.${fraction
      .toString().padStart(9, '0')}Z`
  } catch {
    return value
  }
}

function hex32(value: number) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`
}

function flagList(values: string[]) {
  return values.length > 0 ? values.join(', ') : 'none'
}

export function Frequency10sPanel({ frequency, history = [], error = '' }: {
  frequency: MeterFrequency10s | undefined
  history?: MeterFrequency10sResult[]
  error?: string
}) {
  const result = frequency?.available ? frequency : undefined
  const hasValue = result?.valid === true &&
    typeof result.frequency_hz === 'number' &&
    typeof result.frequency_millihz === 'number'
  const values = history
    .filter((entry) => entry.valid && typeof entry.frequency_millihz === 'number')
    .map((entry) => entry.frequency_millihz! / 1000)
  const minimum = values.length > 0 ? Math.min(...values).toFixed(3) : '—'
  const maximum = values.length > 0 ? Math.max(...values).toFixed(3) : '—'
  const state = error ? 'error' : !result ? 'pending' : hasValue ? 'valid' : 'invalid'
  const stateLabel = error ? 'Request failed' : !result ? 'Waiting for interval'
    : hasValue ? 'Valid result' : 'Rejected interval'

  return <section className={`frequency-10s-product ${state}`}
    aria-labelledby="frequency-10s-title">
    <header className="frequency-10s-header">
      <div>
        <p className="eyebrow">IEC 61000-4-30 · Class A interval</p>
        <h2 id="frequency-10s-title">UTC 10-second frequency</h2>
        <p>Independent standardized result from CH6 VLA; it is not the Basic
          or 150/180-cycle frequency.</p>
      </div>
      <span className={`frequency-10s-state ${state}`}><i />{stateLabel}</span>
    </header>

    <div className="frequency-10s-layout">
      <div className="frequency-10s-reading">
        <span>Latest completed interval</span>
        <strong>{hasValue ? (result.frequency_millihz! / 1000).toFixed(3) : '—'}<small> Hz</small></strong>
        {hasValue
          ? <p className="frequency-10s-range">
            <span>recent min <strong>{minimum} Hz</strong></span>
            <span>recent max <strong>{maximum} Hz</strong></span>
          </p>
          : result
            ? <div className="frequency-10s-reasons" role="status">
              <strong>No numeric frequency published</strong>
              <span>Result quality: {friendlyFlag(result.quality)}</span>
              {result.rejection_reasons.length > 0
                ? <ul>{result.rejection_reasons.map((reason) =>
                  <li key={reason}>{friendlyFlag(reason)}</li>)}</ul>
                : <span>The completed record did not pass all validity gates.</span>}
            </div>
            : <p className="frequency-10s-waiting">The first result appears
              after a complete, qualified UTC-aligned ten-second interval.</p>}
        {error && <p className="frequency-10s-error" role="alert">{error}</p>}
      </div>

      {result && <div className="frequency-10s-audit">
        <dl>
          <div><dt>UTC interval</dt><dd>
            <time>{exactUtc(result.utc_start_nanoseconds)}</time>
            <span>to {exactUtc(result.utc_end_nanoseconds)}</span>
          </dd></div>
          <div><dt>Sample interval [start, end)</dt><dd>
            <strong>{exactInteger(result.first_sample_index)}</strong>
            <span>to {exactInteger(result.interval_end_sample_index)}</span>
          </dd></div>
          <div><dt>Clock qualification</dt><dd>
            <strong>{clockQualification(result)}</strong>
            <span>uncertainty {exactInteger(result.utc_uncertainty_nanoseconds)} ns ·{' '}
              Class A limit 1,000,000 ns</span>
          </dd></div>
          <div><dt>Frequency geometry</dt><dd>
            <strong>{exactInteger(result.cycle_count)} cycles</strong>
            <span>{exactInteger(result.included_crossings)} included /{' '}
              {exactInteger(result.observed_crossings)} observed crossings</span>
          </dd></div>
          <div><dt>Acquisition</dt><dd>
            <strong>{exactInteger(result.sample_count)} samples</strong>
            <span>{(result.measured_sample_rate_millihz / 1000).toFixed(3)} Hz measured ·{' '}
              {exactInteger(result.sample_rate_hz)} Hz configured</span>
          </dd></div>
          <div><dt>Certified profile</dt><dd>
            <strong>{result.nominal_frequency_hz} Hz nominal · CH{result.reference_channel}</strong>
            <span>filter {result.filter_profile} · calibration {result.calibration_profile}</span>
          </dd></div>
          <div><dt>Result identity</dt><dd>
            <strong>result #{result.sequence} · source #{result.source_sequence}</strong>
            <span>configuration {result.configuration_generation} · boundary {result.boundary_generation}</span>
          </dd></div>
          <div><dt>Age</dt><dd><strong>{exactInteger(result.age_ms)} ms</strong>
            <span>{exactInteger(result.observer_drop_count)} observer drops ·{' '}
              {exactInteger(result.rejected_cycles)} rejected cycles</span></dd></div>
        </dl>
        <details className="frequency-10s-raw">
          <summary>Exact calculation and status audit</summary>
          <dl>
            <div><dt>Result status</dt><dd>{hex32(result.status)} · {flagList(result.status_flags)}</dd></div>
            <div><dt>Source status</dt><dd>{hex32(result.source_status)} · {flagList(result.source_status_flags)}</dd></div>
            <div><dt>Rejection mask</dt><dd>{hex32(result.reasons)} · {flagList(result.rejection_reasons)}</dd></div>
            <div><dt>Boundary guards</dt><dd>{hex32(result.guard_flags)} · {flagList(result.guard_flag_names)}</dd></div>
            <div><dt>Duration Q16 samples</dt><dd>{exactInteger(result.duration_q16_samples)}</dd></div>
            <div><dt>First crossing Q16</dt><dd>{exactInteger(result.first_crossing_q16_samples)}</dd></div>
            <div><dt>Last crossing Q16</dt><dd>{exactInteger(result.last_crossing_q16_samples)}</dd></div>
          </dl>
        </details>
      </div>}
    </div>
  </section>
}
