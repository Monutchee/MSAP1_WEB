import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  HarmonicChannel, HarmonicDistortionStatus, HarmonicSpectrum, MeterReadingAttribute,
} from '../api'
import {
  POWER_METRICS, POWER_SCOPES, POWER_SCOPE_LABELS, READING_INTERVAL_LABELS,
  attribute, buildStableChartScale, chartMagnitude, effectiveQuality,
  formatReading, friendlyAttributeName, growStableChartScale, isValidReading, operatingMode,
  powerAttribute, pqResultant, type PowerScope, type ReadingRecord,
} from './readingModel'

function readingQualityClass(reading: MeterReadingAttribute | undefined) {
  return `quality-${effectiveQuality(reading).replaceAll('_', '-')}`
}

function PowerScopeSelector({ value, onChange }: {
  value: PowerScope
  onChange: (scope: PowerScope) => void
}) {
  return <div className="power-scope-control">
    <span id="power-scope-label">Displayed scope</span>
    <div className="power-scope-selector" role="group" aria-labelledby="power-scope-label">
      {POWER_SCOPES.map((scope) => <button type="button" key={scope}
        className={value === scope ? 'active' : ''} aria-pressed={value === scope}
        aria-label={scope === 'total' ? 'Total' : `Phase ${scope.toUpperCase()}`}
        onClick={() => onChange(scope)}>
        <strong>{scope === 'total' ? 'Σ' : scope.toUpperCase()}</strong>
        <span>{POWER_SCOPE_LABELS[scope]}</span>
      </button>)}
    </div>
  </div>
}

function PowerSummary({ record, scope }: { record: ReadingRecord; scope: PowerScope }) {
  const active = powerAttribute(record, 'active', scope)
  const reactive = powerAttribute(record, 'reactive', scope)
  return <section className="power-summary" aria-label={`${POWER_SCOPE_LABELS[scope]} power summary`}>
    {POWER_METRICS.map((metric) => {
      const reading = powerAttribute(record, metric.id, scope)
      return <article className={`power-summary-card ${readingQualityClass(reading)}`} key={metric.id}>
        <span>{metric.label}</span>
        <strong>{formatReading(reading, metric.digits)}</strong>
        <small>{metric.shortLabel} · {effectiveQuality(reading).replaceAll('_', ' ')}</small>
      </article>
    })}
    <article className="power-summary-card operating-mode-card">
      <span>Operating mode</span>
      <strong>{operatingMode(active, reactive)}</strong>
      <small>P import/export · Q₁ lagging/leading</small>
    </article>
  </section>
}

function useStableScale(active: number, reactive: number, apparent: number) {
  const [scale, setScale] = useState(() =>
    buildStableChartScale(active, reactive, apparent))
  const latestMagnitude = useRef(chartMagnitude(active, reactive, apparent))
  const latestValues = useRef({ active, reactive, apparent })
  const shrinkTimer = useRef<number>()
  const magnitude = chartMagnitude(active, reactive, apparent)

  useEffect(() => {
    latestMagnitude.current = magnitude
    latestValues.current = { active, reactive, apparent }
    if (magnitude > scale * .85) {
      if (shrinkTimer.current !== undefined) window.clearTimeout(shrinkTimer.current)
      shrinkTimer.current = undefined
      setScale(growStableChartScale(active, reactive, apparent))
      return
    }
    if (magnitude >= scale * .35) {
      if (shrinkTimer.current !== undefined) window.clearTimeout(shrinkTimer.current)
      shrinkTimer.current = undefined
      return
    }
    if (shrinkTimer.current === undefined) {
      shrinkTimer.current = window.setTimeout(() => {
        shrinkTimer.current = undefined
        setScale((current) => {
          if (latestMagnitude.current >= current * .35) return current
          const latest = latestValues.current
          return buildStableChartScale(latest.active, latest.reactive, latest.apparent)
        })
      }, 5000)
    }
  }, [active, apparent, magnitude, reactive, scale])

  useEffect(() => () => {
    if (shrinkTimer.current !== undefined) window.clearTimeout(shrinkTimer.current)
  }, [])

  return scale
}

function PQOperatingPointChart({ record, scope }: {
  record: ReadingRecord
  scope: PowerScope
}) {
  const activeReading = powerAttribute(record, 'active', scope)
  const reactiveReading = powerAttribute(record, 'reactive', scope)
  const apparentReading = powerAttribute(record, 'apparent', scope)
  const validPoint = isValidReading(activeReading) && isValidReading(reactiveReading)
  const validEnvelope = isValidReading(apparentReading) && apparentReading.value >= 0
  const active = validPoint ? activeReading.value : 0
  const reactive = validPoint ? reactiveReading.value : 0
  const apparent = validEnvelope ? apparentReading.value : 0
  const resultant = validPoint ? pqResultant(active, reactive) : undefined
  const scale = useStableScale(active, reactive, apparent)
  const centerX = 280
  const centerY = 215
  const plotRadius = 160
  const x = centerX + active / scale * plotRadius
  const y = centerY - reactive / scale * plotRadius
  const envelopeRadius = apparent / scale * plotRadius
  const mode = operatingMode(activeReading, reactiveReading)
  const scaleLabel = scale.toLocaleString('en-US', { maximumFractionDigits: 3 })
  const description = validPoint
    ? `${POWER_SCOPE_LABELS[scope]} operating point. Active power ${formatReading(activeReading, 2)}, ` +
      `fundamental reactive power ${formatReading(reactiveReading, 2)}. ${mode}. ` +
      `The P-Q resultant is ${resultant?.toFixed(2)} VA. Backend apparent power is ` +
      `${formatReading(apparentReading, 2)}.`
    : `${POWER_SCOPE_LABELS[scope]} P-Q operating point is unavailable.`

  return <section className="pq-panel" aria-labelledby="pq-chart-heading">
    <header>
      <div><p className="eyebrow">Signed coordinate view</p>
        <h3 id="pq-chart-heading">P–Q₁ operating point</h3></div>
      <span>±{scaleLabel} W / var</span>
    </header>
    <div className="pq-chart-layout">
      <svg viewBox="0 0 560 430" role="img"
        aria-labelledby="pq-svg-title pq-svg-description">
        <title id="pq-svg-title">{POWER_SCOPE_LABELS[scope]} P–Q₁ operating point</title>
        <desc id="pq-svg-description">{description}</desc>
        <rect className="pq-plot-background" x="120" y="55" width="320" height="320" rx="12" />
        <line className="pq-grid" x1="120" y1="135" x2="440" y2="135" />
        <line className="pq-grid" x1="120" y1="295" x2="440" y2="295" />
        <line className="pq-grid" x1="200" y1="55" x2="200" y2="375" />
        <line className="pq-grid" x1="360" y1="55" x2="360" y2="375" />
        {validEnvelope && <circle className="pq-envelope" cx={centerX} cy={centerY}
          r={envelopeRadius}>
          <title>Backend apparent power S: {formatReading(apparentReading, 2)}</title>
        </circle>}
        <line className="pq-axis" x1="110" y1={centerY} x2="450" y2={centerY} />
        <line className="pq-axis" x1={centerX} y1="385" x2={centerX} y2="45" />
        <path className="pq-axis-arrow" d="M450 215 l-10 -5 v10 z" />
        <path className="pq-axis-arrow" d="M110 215 l10 -5 v10 z" />
        <path className="pq-axis-arrow" d="M280 45 l-5 10 h10 z" />
        <path className="pq-axis-arrow" d="M280 385 l-5 -10 h10 z" />
        <text className="pq-axis-title pq-axis-right" x="456" y="220">+P import</text>
        <text className="pq-axis-title pq-axis-left" x="104" y="220" textAnchor="end">−P export</text>
        <text className="pq-axis-title" x="280" y="31" textAnchor="middle">+Q₁ inductive / lagging</text>
        <text className="pq-axis-title" x="280" y="410" textAnchor="middle">−Q₁ capacitive / leading</text>
        <text className="pq-quadrant-label" x="360" y="92" textAnchor="middle">IMPORT · LAGGING</text>
        <text className="pq-quadrant-label" x="200" y="92" textAnchor="middle">EXPORT · LAGGING</text>
        <text className="pq-quadrant-label" x="360" y="356" textAnchor="middle">IMPORT · LEADING</text>
        <text className="pq-quadrant-label" x="200" y="356" textAnchor="middle">EXPORT · LEADING</text>
        {validPoint && <g className="pq-operating-point">
          <line x1={centerX} y1={centerY} x2={x} y2={y} />
          <circle cx={x} cy={y} r="8" />
          <text x={x + (active >= 0 ? 14 : -14)} y={y + (reactive >= 0 ? -12 : 23)}
            textAnchor={active >= 0 ? 'start' : 'end'}>{scope === 'total' ? 'Total' : scope.toUpperCase()}</text>
        </g>}
        <circle className="pq-origin" cx={centerX} cy={centerY} r="4" />
      </svg>
      <div className="pq-numeric-summary" aria-label="P-Q numeric summary">
        <strong>{mode}</strong>
        <dl>
          <div><dt>Active power P</dt><dd>{formatReading(activeReading, 2)}</dd></div>
          <div><dt>Fundamental reactive power Q₁</dt><dd>{formatReading(reactiveReading, 2)}</dd></div>
          <div><dt>Backend apparent power S</dt><dd>{formatReading(apparentReading, 2)}</dd></div>
          <div><dt>P–Q₁ resultant</dt><dd>{resultant === undefined ? '—' : `${resultant.toFixed(2)} VA`}</dd></div>
        </dl>
        <p>The dashed envelope is authoritative backend S. It need not match
          √(P² + Q₁²) in distorted or unbalanced systems.</p>
      </div>
    </div>
  </section>
}

const THD_CHANNELS: Record<Exclude<PowerScope, 'total'>, { voltage: number; current: number }> = {
  a: { voltage: 6, current: 0 },
  b: { voltage: 5, current: 1 },
  c: { voltage: 4, current: 2 },
}

const THD_STATUS_MESSAGES: Record<HarmonicDistortionStatus, string> = {
  valid: '',
  interval_invalid: 'The matching harmonic interval failed measurement validation.',
  channel_unavailable: 'One or more selected phase channels are unavailable.',
  fundamental_unavailable: 'A valid nonzero H₁ is unavailable for one or more selected phases.',
  insufficient_order_range: 'The current sample rate does not qualify magnitudes through H₅₀.',
  harmonic_unavailable: 'At least one H₂–H₅₀ magnitude is unavailable.',
}

function harmonicChannel(spectrum: HarmonicSpectrum | undefined, channel: number) {
  return spectrum?.channels.find((candidate) => candidate.channel === channel)
}

function formatThd(channel: HarmonicChannel | undefined) {
  const thd = channel?.thd
  return thd?.status === 'valid' && thd.percent !== null && Number.isFinite(thd.percent)
    ? `${thd.percent.toFixed(3)}%` : '—'
}

function ThdReadout({ spectrum, scope, kind }: {
  spectrum: HarmonicSpectrum | undefined
  scope: PowerScope
  kind: 'voltage' | 'current'
}) {
  const phases = scope === 'total' ? (['a', 'b', 'c'] as const) : [scope]
  if (scope !== 'total')
    return <>{formatThd(harmonicChannel(spectrum, THD_CHANNELS[scope][kind]))}</>
  return <span className="thd-phase-values" aria-label={`${kind} THD by phase`}>
    {phases.map((phase) => <span key={phase}>
      <b>{phase.toUpperCase()}</b> {formatThd(harmonicChannel(
        spectrum, THD_CHANNELS[phase][kind],
      ))}
    </span>)}
  </span>
}

function thdAvailabilityMessage(
  spectrum: HarmonicSpectrum | undefined,
  scope: PowerScope,
  pendingMessage: string | undefined,
) {
  if (!spectrum) return pendingMessage ??
    'Waiting for the harmonic family that exactly matches this Power interval.'
  const phases = scope === 'total' ? (['a', 'b', 'c'] as const) : [scope]
  const channels = phases.flatMap((phase) => [
    harmonicChannel(spectrum, THD_CHANNELS[phase].voltage),
    harmonicChannel(spectrum, THD_CHANNELS[phase].current),
  ])
  if (channels.some((channel) => !channel?.thd))
    return 'The matching harmonic family does not provide an APU THD result.'
  const statuses = [...new Set(channels.map((channel) => channel!.thd.status)
    .filter((status) => status !== 'valid'))]
  if (statuses.length > 0)
    return statuses.map((status) => THD_STATUS_MESSAGES[status]).join(' ')
  return 'The APU calculated each value from H₂–H₅₀ of this exact interval; phases are not averaged.'
}

function PowerFactorAnalysis({ record, scope, harmonics, harmonicMessage }: {
  record: ReadingRecord
  scope: PowerScope
  harmonics: HarmonicSpectrum | undefined
  harmonicMessage: string | undefined
}) {
  const powerFactor = powerAttribute(record, 'factor', scope)
  const displacement = powerAttribute(record, 'displacement', scope)
  const voltageUnbalance = attribute(record, 'unbalance.voltage')
  const currentUnbalance = attribute(record, 'unbalance.current')
  const difference = isValidReading(powerFactor) && isValidReading(displacement)
    ? Math.abs(powerFactor.value - displacement.value).toFixed(4) : '—'
  const thdMessage = thdAvailabilityMessage(harmonics, scope, harmonicMessage)

  return <section className="pf-analysis" aria-labelledby="pf-analysis-heading">
    <header><p className="eyebrow">Power-quality context</p>
      <h3 id="pf-analysis-heading">Power-factor analysis</h3></header>
    <dl>
      <div><dt>True power factor</dt><dd>{formatReading(powerFactor, 4, false)}</dd></div>
      <div><dt>Displacement power factor</dt><dd>{formatReading(displacement, 4, false)}</dd></div>
      <div><dt>|PF − DPF|</dt><dd>{difference}</dd></div>
      <div><dt>Voltage unbalance</dt><dd>{formatReading(voltageUnbalance, 3)}</dd></div>
      <div><dt>Current unbalance</dt><dd>{formatReading(currentUnbalance, 3)}</dd></div>
      <div><dt>Voltage THD (H₂–H₅₀)</dt><dd>
        <ThdReadout spectrum={harmonics} scope={scope} kind="voltage" />
      </dd></div>
      <div><dt>Current THD (H₂–H₅₀)</dt><dd>
        <ThdReadout spectrum={harmonics} scope={scope} kind="current" />
      </dd></div>
      <div><dt>Fundamental P₁ / S₁</dt><dd>—</dd></div>
    </dl>
    <p>The difference between true PF and displacement PF may reflect waveform
      distortion, unbalance, or other nonfundamental effects. {thdMessage}{' '}
      A complete P₁–Q₁–S₁ decomposition is not supplied by this record.</p>
  </section>
}

function PowerPhaseMatrix({ record }: { record: ReadingRecord }) {
  return <section className="power-matrix-panel" aria-labelledby="power-matrix-heading">
    <header><p className="eyebrow">Phase comparison</p>
      <h3 id="power-matrix-heading">A, B, C, and authoritative total</h3></header>
    <div className="power-matrix-scroll" tabIndex={0} aria-label="Scrollable power phase matrix">
      <table className="power-matrix">
        <caption>Power measurements by phase and total</caption>
        <thead><tr><th scope="col">Measurement</th>
          {POWER_SCOPES.map((scope) => <th scope="col" key={scope}>
            <span className={`phase-marker phase-${scope}`}>{scope === 'total' ? 'Σ' : scope.toUpperCase()}</span>
            {POWER_SCOPE_LABELS[scope]}
          </th>)}</tr></thead>
        <tbody>{POWER_METRICS.map((metric) => <tr key={metric.id}>
          <th scope="row"><strong>{metric.label}</strong><small>{metric.shortLabel}</small></th>
          {POWER_SCOPES.map((scope) => {
            const reading = powerAttribute(record, metric.id, scope)
            return <td className={readingQualityClass(reading)} key={scope}>
              {formatReading(reading, metric.digits)}
            </td>
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <p>Total values are supplied by the meter and are never reconstructed from phases.</p>
  </section>
}

function RawPowerMeasurements({ record }: { record: ReadingRecord }) {
  const measurements = useMemo(() => record.attributes.filter((reading) =>
    reading.key.startsWith('power.')), [record])
  return <details className="reading-advanced">
    <summary>Advanced power measurements <span>{measurements.length} fields</span></summary>
    <div className="reading-advanced-scroll">
      <table>
        <thead><tr><th>Friendly name</th><th>Raw key</th><th>Value / unit</th>
          <th>Quality</th><th>Source sequence</th><th>Interval</th></tr></thead>
        <tbody>{measurements.map((reading) => <tr key={reading.key}>
          <td>{friendlyAttributeName(reading.key)}</td><td><code>{reading.key}</code></td>
          <td>{formatReading(reading, reading.unit === 'PF' ? 4 : 2)}</td>
          <td>{effectiveQuality(reading)}</td><td>{reading.source_sequence.toLocaleString('en-US')}</td>
          <td>{READING_INTERVAL_LABELS[record.interval]}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </details>
}

export function PowerView({ record, scope, onScopeChange, harmonics, harmonicMessage }: {
  record: ReadingRecord
  scope: PowerScope
  onScopeChange: (scope: PowerScope) => void
  harmonics?: HarmonicSpectrum
  harmonicMessage?: string
}) {
  return <section className="reading-section power-view" aria-labelledby="power-view-heading">
    <div className="reading-section-heading compact">
      <div><p className="eyebrow">Backend-authoritative measurements</p>
        <h2 id="power-view-heading">Power</h2>
        <p>Compare signed power flow and power-factor context from one finalized record.</p></div>
      <PowerScopeSelector value={scope} onChange={onScopeChange} />
    </div>
    <PowerSummary record={record} scope={scope} />
    <div className="power-analysis-grid">
      <PQOperatingPointChart key={`${record.interval}-${scope}`} record={record} scope={scope} />
      <PowerFactorAnalysis record={record} scope={scope} harmonics={harmonics}
        harmonicMessage={harmonicMessage} />
    </div>
    <PowerPhaseMatrix record={record} />
    <RawPowerMeasurements record={record} />
  </section>
}
