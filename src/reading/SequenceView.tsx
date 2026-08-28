import type { MeasurementTopology, MeterReadingAttribute } from '../api'
import {
  READING_INTERVAL_LABELS, attribute, effectiveQuality, formatReading,
  friendlyAttributeName, isValidReading, type ReadingInterval, type ReadingRecord,
} from './readingModel'

type SequenceQuantity = 'voltage' | 'current'
type SequenceKind = 'positive' | 'negative' | 'zero'

interface SequenceDefinition {
  kind: SequenceKind
  name: string
  symbol: string
  description: string
}

const SEQUENCE_DEFINITIONS: SequenceDefinition[] = [
  {
    kind: 'positive',
    name: 'Positive sequence',
    symbol: '₁',
    description: 'Forward phase order',
  },
  {
    kind: 'negative',
    name: 'Negative sequence',
    symbol: '₂',
    description: 'Reverse phase order',
  },
  {
    kind: 'zero',
    name: 'Zero sequence',
    symbol: '₀',
    description: 'In-phase component',
  },
]

export const SEQUENCE_CONTEXT_KEYS = [
  'unbalance.voltage', 'unbalance.current',
  'unbalance.voltage.zero', 'unbalance.current.zero',
  'sequence.voltage.positive.rms', 'sequence.voltage.negative.rms',
  'sequence.voltage.zero.rms', 'sequence.current.positive.rms',
  'sequence.current.negative.rms', 'sequence.current.zero.rms',
]

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function sequenceAttribute(
  record: ReadingRecord,
  quantity: SequenceQuantity,
  kind: SequenceKind,
) {
  return attribute(record, `sequence.${quantity}.${kind}.rms`)
}

function ratioAttribute(
  record: ReadingRecord,
  quantity: SequenceQuantity,
  kind: Exclude<SequenceKind, 'positive'>,
) {
  return attribute(record, kind === 'negative'
    ? `unbalance.${quantity}`
    : `unbalance.${quantity}.zero`)
}

function validNonnegative(reading: MeterReadingAttribute | undefined) {
  return isValidReading(reading) && Number.isFinite(reading.value) && reading.value >= 0
    ? reading.value
    : undefined
}

function formatNonnegative(reading: MeterReadingAttribute | undefined, digits = 3) {
  if (isValidReading(reading) && reading.value < 0) return 'Invalid'
  return formatReading(reading, digits)
}

function unavailableOrInvalid(reading: MeterReadingAttribute | undefined) {
  return effectiveQuality(reading) === 'unavailable' ? 'unavailable' : 'invalid'
}

function niceCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const magnitude = 10 ** exponent
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function ratioScaleMaximum(values: Array<number | undefined>) {
  const peak = Math.max(0, ...values.flatMap((value) => value === undefined ? [] : [value]))
  if (peak <= 1) return 1
  if (peak <= 2) return 2
  if (peak <= 5) return 5
  return niceCeiling(peak * 1.1)
}

function TopologyDiagram({ topology }: { topology: MeasurementTopology }) {
  const wye = topology === 'wye'
  const title = wye ? 'Star or wye voltage connection' : 'Delta voltage connection'
  const description = wye
    ? 'Three voltage inputs meet at a neutral reference. The configured nominal voltage is line-to-neutral.'
    : 'Three line-to-line voltage inputs form a closed triangle. The configured nominal voltage is line-to-line.'
  return <svg className={`sequence-topology-diagram ${topology}`} viewBox="0 0 260 180"
    role="img" aria-labelledby="sequence-topology-title"
    aria-describedby="sequence-topology-description">
    <title id="sequence-topology-title">{title}</title>
    <desc id="sequence-topology-description">{description}</desc>
    {wye
      ? <>
        <line x1="130" y1="88" x2="130" y2="22" />
        <line x1="130" y1="88" x2="58" y2="140" />
        <line x1="130" y1="88" x2="202" y2="140" />
        <line className="neutral" x1="130" y1="88" x2="130" y2="150" />
        <circle className="junction" cx="130" cy="88" r="6" />
        <text x="130" y="16" textAnchor="middle">A</text>
        <text x="45" y="153" textAnchor="middle">B</text>
        <text x="215" y="153" textAnchor="middle">C</text>
        <text className="neutral-label" x="141" y="169">N</text>
      </>
      : <>
        <path d="M130 22 L48 145 L212 145 Z" />
        <circle className="junction" cx="130" cy="22" r="5" />
        <circle className="junction" cx="48" cy="145" r="5" />
        <circle className="junction" cx="212" cy="145" r="5" />
        <text x="130" y="16" textAnchor="middle">A</text>
        <text x="33" y="159" textAnchor="middle">B</text>
        <text x="227" y="159" textAnchor="middle">C</text>
        <text className="edge-label" x="82" y="75" textAnchor="middle">Vab</text>
        <text className="edge-label" x="178" y="75" textAnchor="middle">Vca</text>
        <text className="edge-label" x="130" y="163" textAnchor="middle">Vbc</text>
      </>}
  </svg>
}

function SequenceMagnitudeChart({ record, quantity }: {
  record: ReadingRecord
  quantity: SequenceQuantity
}) {
  const prefix = quantity === 'voltage' ? 'V' : 'I'
  const unit = quantity === 'voltage' ? 'V' : 'A'
  const readings = SEQUENCE_DEFINITIONS.map((definition) => ({
    ...definition,
    reading: sequenceAttribute(record, quantity, definition.kind),
  }))
  const values = readings.map(({ reading }) => validNonnegative(reading))
  const maximum = niceCeiling(Math.max(0, ...values.flatMap((value) =>
    value === undefined ? [] : [value])) * 1.08)
  const plotLeft = 178
  const plotWidth = 472
  const laneY = [48, 112, 176]
  const ticks = [0, .25, .5, .75, 1]
  const titleId = `sequence-${quantity}-chart-title`
  const descriptionId = `sequence-${quantity}-chart-description`

  return <svg className="sequence-magnitude-chart" viewBox="0 0 690 224" role="img"
    aria-labelledby={titleId} aria-describedby={descriptionId}>
    <title id={titleId}>{quantity === 'voltage' ? 'Voltage' : 'Current'} sequence magnitudes</title>
    <desc id={descriptionId}>Horizontal bars compare authoritative positive, negative, and zero
      sequence RMS magnitudes on one linear scale. Sequence angles are not published.</desc>
    {ticks.map((tick) => {
      const x = plotLeft + plotWidth * tick
      return <g key={tick}>
        <line className="sequence-chart-grid" x1={x} x2={x} y1="23" y2="198" />
        <text className="sequence-chart-axis" x={x} y="218" textAnchor="middle">
          {(maximum * tick).toLocaleString('en-US', { maximumFractionDigits: 3 })}
        </text>
      </g>
    })}
    <text className="sequence-chart-unit" x="672" y="218" textAnchor="end">{unit} RMS</text>
    {readings.map(({ kind, name, symbol, description, reading }, index) => {
      const value = values[index]
      const width = value === undefined || maximum <= 0 ? 0 : plotWidth * value / maximum
      const y = laneY[index]
      const accessible = value === undefined
        ? `${name} ${prefix}${symbol} ${unavailableOrInvalid(reading)}`
        : `${name} ${prefix}${symbol}, ${value.toFixed(3)} ${unit} RMS`
      return <g className={`sequence-chart-lane sequence-${kind}`} role="img"
        aria-label={accessible} tabIndex={0} key={kind}>
        <title>{accessible}</title>
        <text className="sequence-chart-symbol" x="0" y={y + 4}>{prefix}{symbol}</text>
        <text className="sequence-chart-name" x="38" y={y - 4}>{name}</text>
        <text className="sequence-chart-description" x="38" y={y + 16}>{description}</text>
        <rect className="sequence-chart-track" x={plotLeft} y={y - 15}
          width={plotWidth} height="30" rx="8" />
        {value !== undefined && <>
          <rect className="sequence-chart-bar" x={plotLeft} y={y - 15}
            width={Math.max(value > 0 ? 2 : 0, width)} height="30" rx="8" />
          <circle className="sequence-chart-marker" cx={plotLeft + width} cy={y} r="5" />
        </>}
        <text className="sequence-chart-value" x={plotLeft + plotWidth - 8} y={y + 5}
          textAnchor="end">{formatNonnegative(reading)}</text>
      </g>
    })}
  </svg>
}

function RatioCard({ label, reading, scaleMaximum, kind }: {
  label: string
  reading: MeterReadingAttribute | undefined
  scaleMaximum: number
  kind: 'negative' | 'zero'
}) {
  const value = validNonnegative(reading)
  const width = value === undefined ? 0 : Math.min(100, value / scaleMaximum * 100)
  const formatted = formatNonnegative(reading)
  return <article className={`sequence-ratio-card sequence-${kind}`}>
    <div><span>{label}</span><strong>{formatted}</strong></div>
    <div className="sequence-ratio-meter" role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={scaleMaximum}
      aria-valuenow={value} aria-valuetext={formatted}>
      <span style={{ width: `${width}%` }} />
    </div>
    <small>Shared scale 0–{scaleMaximum.toLocaleString('en-US', {
      maximumFractionDigits: 3,
    })}% · no pass/fail limit configured</small>
  </article>
}

function SequenceQuantityPanel({ record, quantity }: {
  record: ReadingRecord
  quantity: SequenceQuantity
}) {
  const voltage = quantity === 'voltage'
  const prefix = voltage ? 'V' : 'I'
  const positive = sequenceAttribute(record, quantity, 'positive')
  const negativeRatio = ratioAttribute(record, quantity, 'negative')
  const zeroRatio = ratioAttribute(record, quantity, 'zero')
  const ratioMaximum = ratioScaleMaximum([
    validNonnegative(negativeRatio), validNonnegative(zeroRatio),
  ])
  const titleId = `sequence-${quantity}-panel-title`
  return <section className={`sequence-component-panel ${quantity}`} aria-labelledby={titleId}>
    <header>
      <div><p className="eyebrow">{voltage ? 'Voltage components' : 'Current components'}</p>
        <h3 id={titleId}>{voltage ? 'Voltage sequence profile' : 'Current sequence profile'}</h3></div>
      <div className="sequence-positive-reference"><span>Positive reference {prefix}₁</span>
        <strong>{formatNonnegative(positive)}</strong></div>
    </header>
    <div className="sequence-chart-scroll">
      <SequenceMagnitudeChart record={record} quantity={quantity} />
    </div>
    <div className="sequence-ratio-grid">
      <RatioCard label={`${prefix}₂ / ${prefix}₁ negative-sequence ratio`}
        reading={negativeRatio} scaleMaximum={ratioMaximum} kind="negative" />
      <RatioCard label={`${prefix}₀ / ${prefix}₁ zero-sequence ratio`}
        reading={zeroRatio} scaleMaximum={ratioMaximum} kind="zero" />
    </div>
  </section>
}

function SequenceConcepts() {
  const concepts = [
    { kind: 'positive', order: 'A → B → C', title: 'Positive sequence',
      body: 'Forward phase order. This is the normal balanced component and the reference for both ratios.' },
    { kind: 'negative', order: 'A → C → B', title: 'Negative sequence',
      body: 'Reverse phase order. The backend reports its magnitude relative to the positive sequence as unbalance.' },
    { kind: 'zero', order: 'A = B = C', title: 'Zero sequence',
      body: 'Three in-phase components. Its physical path and observability depend on the configured connection.' },
  ] as const
  return <section className="sequence-concepts" aria-labelledby="sequence-concepts-title">
    <header><p className="eyebrow">Operator key</p><h3 id="sequence-concepts-title">How to read the components</h3></header>
    <div>{concepts.map((concept) => <article className={`sequence-${concept.kind}`}
      key={concept.kind}>
      <span>{concept.order}</span><h4>{concept.title}</h4><p>{concept.body}</p>
    </article>)}</div>
  </section>
}

function RawSequenceDetails({ record }: { record: ReadingRecord }) {
  const readings = SEQUENCE_CONTEXT_KEYS.flatMap((key) => {
    const reading = attribute(record, key)
    return reading ? [reading] : []
  })
  return <details className="reading-advanced sequence-advanced">
    <summary>Advanced sequence details <span>{readings.length} fields</span></summary>
    <div className="reading-advanced-scroll"><table>
      <thead><tr><th>Friendly name</th><th>Raw key</th><th>Value / unit</th>
        <th>Quality</th><th>Source sequence</th><th>Interval</th></tr></thead>
      <tbody>{readings.map((reading) => <tr key={reading.key}>
        <td>{friendlyAttributeName(reading.key)}</td><td><code>{reading.key}</code></td>
        <td>{formatReading(reading, 3)}</td><td>{effectiveQuality(reading)}</td>
        <td>{formatCount(reading.source_sequence)}</td>
        <td>{READING_INTERVAL_LABELS[record.interval]}</td>
      </tr>)}</tbody>
    </table></div>
  </details>
}

export function SequenceView({ interval, record, topology }: {
  interval: ReadingInterval
  record: ReadingRecord | undefined
  topology: MeasurementTopology
}) {
  const wye = topology === 'wye'
  return <section className="reading-section sequence-view" aria-labelledby="sequence-view-title">
    <div className="reading-section-heading compact">
      <div>
        <p className="eyebrow">Symmetrical components</p>
        <h2 id="sequence-view-title">Sequence balance</h2>
        <p>See the forward, reverse, and in-phase content without implying unpublished angles.</p>
      </div>
    </div>
    {!record
      ? <div className="harmonic-empty">
        <strong>Waiting for {READING_INTERVAL_LABELS[interval]} sequence data</strong>
        <span>The view appears only after all sequence and unbalance siblings share one finalized record.</span>
      </div>
      : <>
        <section className={`sequence-topology-card ${topology}`}
          aria-labelledby="sequence-topology-card-title">
          <TopologyDiagram topology={topology} />
          <div>
            <p className="eyebrow">Configured measurement connection</p>
            <h3 id="sequence-topology-card-title">{wye ? 'Star (wye)' : 'Delta'}</h3>
            <strong>{wye ? 'Nominal reference: line-to-neutral (L-N)'
              : 'Nominal reference: line-to-line (L-L)'}</strong>
            <p>{wye
              ? 'Zero-sequence components may have a neutral or ground return path. Interpret V₀ and I₀ together with grounding and sensor wiring.'
              : 'Three-wire line measurements do not directly expose zero-sequence circulation inside a delta. Treat V₀ and I₀ here as measured line-side residuals.'}</p>
            <small>This setting changes labels and guidance only; it does not change the backend sequence calculation.</small>
          </div>
        </section>
        <div className="sequence-component-grid">
          <SequenceQuantityPanel record={record} quantity="voltage" />
          <SequenceQuantityPanel record={record} quantity="current" />
        </div>
        <SequenceConcepts />
        <aside className="sequence-angle-note"><strong>Why there is no polar sequence plot</strong>
          <span>The meter API publishes authoritative sequence magnitudes and ratios, but not sequence
            angles. Phase angles remain available under Phasor &amp; Unbalance; this page does not
            reconstruct or invent sequence angles in the browser.</span></aside>
        <RawSequenceDetails record={record} />
      </>}
  </section>
}
