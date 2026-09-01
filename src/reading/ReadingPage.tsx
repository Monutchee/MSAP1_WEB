import {
  type PointerEvent as ReactPointerEvent,
  useCallback, useEffect, useMemo, useState,
} from 'react'
import {
  api, ApiError, HarmonicChannel, HarmonicOrder, HarmonicPeriod,
  HarmonicSpectrum, MeterAggregate, MeterTenMinute,
  MeterTwoHour, MeterReadings,
} from '../api'
import type { MeasurementTopology } from '../api'
import { PowerView } from './PowerView'
import { EnergyDemandView } from './EnergyDemandView'
import { PowerQualityView } from './PowerQualityView'
import { SequenceView, SEQUENCE_CONTEXT_KEYS } from './SequenceView'
import { harmonicMismatchMessage, harmonicNominalMismatch } from './harmonicDiagnosis'
import {
  READING_INTERVAL_LABELS, aggregateReadingRecord, attribute, basicReadingRecord,
  effectiveQuality, formatReading, formatUtc, friendlyAttributeName, isValidReading,
  harmonicPresentationState, intervalPresentationState, operatingMode, powerAttribute,
  selectCommittedRecord, selectHarmonicSpectrum, updateCompleteRecordCache,
  updateHarmonicSpectrumCache, visibleQuality, type CompleteRecordCache,
  type HarmonicPresentationState, type HarmonicSpectrumCache,
  type IntervalPresentationState, type PowerScope, type ReadingInterval, type ReadingRecord,
} from './readingModel'
import './reading.css'

type ReadingSubtab =
  | 'overview' | 'power' | 'energy' | 'phasor' | 'sequence' | 'harmonics' | 'power-quality'
type PhasorScope = 'voltage' | 'current' | 'all'
type HarmonicGroup = 'voltage' | 'current'
type HarmonicDisplay = 'magnitude' | 'percentage'
type HarmonicChartView = 'lanes' | 'combined'

type PhasorPhase = 'a' | 'b' | 'c'

interface PhasorDefinition {
  label: string
  description: string
  group: Exclude<PhasorScope, 'all'>
  phase: PhasorPhase
  channel: number
  angleKey: string
}

interface PhasorReading extends PhasorDefinition {
  unit: string
  magnitude: number
  magnitudeValid: boolean
  angle: number
  angleValid: boolean
}

interface HarmonicOrderRange {
  first: number
  last: number
}

interface ChannelColumn {
  channel: number
  label: string
}

const CHANNEL_GROUPS: Record<HarmonicGroup, ChannelColumn[]> = {
  voltage: [
    { channel: 6, label: 'Va' },
    { channel: 5, label: 'Vb' },
    { channel: 4, label: 'Vc' },
  ],
  current: [
    { channel: 0, label: 'Ia' },
    { channel: 1, label: 'Ib' },
    { channel: 2, label: 'Ic' },
    { channel: 3, label: 'In' },
  ],
}

const PHASOR_DEFINITIONS: PhasorDefinition[] = [
  { label: 'Va', description: 'Voltage A', group: 'voltage', phase: 'a', channel: 6,
    angleKey: 'phase.angle.voltage.a' },
  { label: 'Vb', description: 'Voltage B', group: 'voltage', phase: 'b', channel: 5,
    angleKey: 'phase.angle.voltage.b' },
  { label: 'Vc', description: 'Voltage C', group: 'voltage', phase: 'c', channel: 4,
    angleKey: 'phase.angle.voltage.c' },
  { label: 'Ia', description: 'Current A', group: 'current', phase: 'a', channel: 0,
    angleKey: 'phase.angle.current.a' },
  { label: 'Ib', description: 'Current B', group: 'current', phase: 'b', channel: 1,
    angleKey: 'phase.angle.current.b' },
  { label: 'Ic', description: 'Current C', group: 'current', phase: 'c', channel: 2,
    angleKey: 'phase.angle.current.c' },
]

const OVERVIEW_CONTEXT_KEYS = [
  'voltage.ll.ab.rms', 'voltage.ll.bc.rms', 'voltage.ll.ca.rms',
  'power.active.total', 'power.reactive.total', 'power.apparent.total',
  'power.factor.total', 'unbalance.voltage', 'unbalance.current',
]
const POWER_CONTEXT_KEYS = [
  ...['active', 'reactive', 'apparent', 'factor'].flatMap((metric) =>
    ['a', 'b', 'c', 'total'].map((scope) => `power.${metric}.${scope}`)),
  ...['a', 'b', 'c', 'total'].map((scope) => `power.factor.displacement.${scope}`),
  'unbalance.voltage', 'unbalance.current',
]
const PHASOR_CONTEXT_KEYS = [
  ...PHASOR_DEFINITIONS.map((definition) => definition.angleKey),
  'unbalance.voltage', 'unbalance.current',
  'unbalance.voltage.zero', 'unbalance.current.zero',
]

const ALL_HARMONIC_ORDERS = Array.from({ length: 127 }, (_, index) => index + 1)
const FIRST_SUMMARY_ORDER = 2
const LAST_SUMMARY_ORDER = 127
const FULL_SUMMARY_RANGE: HarmonicOrderRange = {
  first: FIRST_SUMMARY_ORDER,
  last: LAST_SUMMARY_ORDER,
}
const HARMONIC_RANGE_SHORTCUTS: Array<HarmonicOrderRange & { label: string }> = [
  { label: 'All', ...FULL_SUMMARY_RANGE },
  { label: 'H2–H32', first: 2, last: 32 },
  { label: 'H33–H64', first: 33, last: 64 },
  { label: 'H65–H96', first: 65, last: 96 },
  { label: 'H97–H127', first: 97, last: 127 },
]
const HARMONIC_ZOOM_ORDER_COUNTS = [16, 32, 64, 126]
const MAX_HARMONIC_ZOOM_ORDER_COUNT =
  HARMONIC_ZOOM_ORDER_COUNTS[HARMONIC_ZOOM_ORDER_COUNTS.length - 1]
const SUMMARY_WIDTH = 1000
const SUMMARY_X_PADDING = 7
const SUMMARY_BASELINE = 60
const SUMMARY_HEIGHT = 52
const SUMMARY_COMBINED_BASELINE = 146
const SUMMARY_COMBINED_HEIGHT = 132
const SUMMARY_COMBINED_VIEWBOX_HEIGHT = 152

interface HarmonicTooltipDetail {
  channelIndex: number
  channelLabel: string
  order: number
  magnitude: number
  unit: string
  percentage: number | undefined
  angle: number | undefined
}

interface HarmonicTooltipState extends HarmonicTooltipDetail {
  x: number
  y: number
  below: boolean
}

const PERIOD_LABELS: Record<Exclude<HarmonicPeriod, 'basic'>, string> = {
  cycles_150_180: '3 seconds (150/180 cycles)',
  minutes_10: '10 minutes',
  hours_2: '2 hours',
}

const PERIOD_INTERVAL_LABELS: Record<Exclude<HarmonicPeriod, 'basic'>, string> = {
  cycles_150_180: '3-second',
  minutes_10: '10-minute',
  hours_2: '2-hour',
}

function formatCount(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value)
}

function formatMagnitude(value: number) {
  return value.toLocaleString('en-US', { maximumSignificantDigits: 7 })
}

function formatPercentage(value: number) {
  if (value > 0 && value < 0.001) return '<0.001'
  return value.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

function percentageOfFundamental(
  point: HarmonicOrder | undefined,
  fundamental: HarmonicOrder | undefined,
) {
  if (!point?.magnitude_valid || !fundamental?.magnitude_valid || fundamental.magnitude <= 0) {
    return undefined
  }
  return (point.magnitude / fundamental.magnitude) * 100
}

function displayedValue(
  point: HarmonicOrder | undefined,
  fundamental: HarmonicOrder | undefined,
  display: HarmonicDisplay,
) {
  if (!point?.magnitude_valid) return undefined
  return display === 'magnitude'
    ? point.magnitude
    : percentageOfFundamental(point, fundamental)
}

function formatDisplayedValue(value: number, unit: string, display: HarmonicDisplay) {
  return display === 'magnitude'
    ? `${formatMagnitude(value)}${unit ? ` ${unit}` : ''}`
    : `${formatPercentage(value)} % H1`
}

function rangeOrderCount(range: HarmonicOrderRange) {
  return range.last - range.first + 1
}

function ordersInRange(range: HarmonicOrderRange) {
  return Array.from({ length: rangeOrderCount(range) }, (_, index) => range.first + index)
}

function summaryOrderStep(range: HarmonicOrderRange) {
  return (SUMMARY_WIDTH - SUMMARY_X_PADDING * 2) /
    Math.max(1, rangeOrderCount(range) - 1)
}

function combinedChannelSpacing(orderStep: number, channelCount: number) {
  if (channelCount <= 1) return 0
  // Keep each order's channels visually bound as one cluster. The capped
  // cluster width leaves most of the order step empty at closer zoom levels,
  // while the proportional limit prevents adjacent clusters touching in the
  // all-orders overview.
  const clusterWidth = Math.min(8, orderStep * 0.45)
  return clusterWidth / (channelCount - 1)
}

function summaryOrderX(order: number, range: HarmonicOrderRange) {
  if (range.first === range.last) return SUMMARY_WIDTH / 2
  return SUMMARY_X_PADDING + ((order - range.first) / (range.last - range.first)) *
    (SUMMARY_WIDTH - SUMMARY_X_PADDING * 2)
}

function summaryAxisOrders(range: HarmonicOrderRange) {
  if (range.first === FIRST_SUMMARY_ORDER && range.last === LAST_SUMMARY_ORDER) {
    return [2, 25, 50, 75, 100, 127]
  }

  const tickCount = Math.min(6, rangeOrderCount(range))
  return Array.from({ length: tickCount }, (_, index) => Math.round(
    range.first + ((range.last - range.first) * index) / Math.max(1, tickCount - 1),
  )).filter((order, index, orders) => index === 0 || order !== orders[index - 1])
}

function centeredRange(range: HarmonicOrderRange, orderCount: number): HarmonicOrderRange {
  const boundedCount = Math.min(
    LAST_SUMMARY_ORDER - FIRST_SUMMARY_ORDER + 1,
    Math.max(1, orderCount),
  )
  const center = (range.first + range.last) / 2
  let first = Math.round(center - (boundedCount - 1) / 2)
  first = Math.max(FIRST_SUMMARY_ORDER,
    Math.min(first, LAST_SUMMARY_ORDER - boundedCount + 1))
  return { first, last: first + boundedCount - 1 }
}

function zoomedRange(range: HarmonicOrderRange, direction: 'in' | 'out') {
  const orderCount = rangeOrderCount(range)
  const targetCount = direction === 'in'
    ? [...HARMONIC_ZOOM_ORDER_COUNTS].reverse().find((count) => count < orderCount)
    : HARMONIC_ZOOM_ORDER_COUNTS.find((count) =>
      count > orderCount && !(orderCount > 16 && orderCount <= 32 && count === 32))
  return targetCount === undefined ? range : centeredRange(range, targetCount)
}

function harmonicTooltipText(detail: HarmonicTooltipDetail) {
  const percentage = detail.percentage === undefined
    ? 'Unavailable'
    : `${formatPercentage(detail.percentage)} % H1`
  const angle = detail.angle === undefined
    ? 'Unavailable'
    : `${detail.angle.toFixed(3)}°`
  return `${detail.channelLabel} H${detail.order}\n` +
    `Magnitude: ${formatMagnitude(detail.magnitude)} ${detail.unit}\n` +
    `Percentage: ${percentage}\nRelative angle: ${angle}`
}

function HarmonicTooltip({ tooltip }: { tooltip: HarmonicTooltipState | undefined }) {
  if (!tooltip) return null
  return <aside className={`harmonic-chart-tooltip${tooltip.below ? ' below' : ''}`}
    style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
    <div className="harmonic-tooltip-heading">
      <span><i className={`channel-${tooltip.channelIndex}`} />{tooltip.channelLabel}</span>
      <strong>H{tooltip.order}</strong>
    </div>
    <dl>
      <div><dt>Magnitude</dt><dd>{formatMagnitude(tooltip.magnitude)} <span>{tooltip.unit}</span></dd></div>
      <div><dt>Percentage</dt><dd>{tooltip.percentage === undefined
        ? <em>Unavailable</em>
        : <>{formatPercentage(tooltip.percentage)} <span>% H1</span></>}</dd></div>
      <div><dt>Relative angle</dt><dd>{tooltip.angle === undefined
        ? <em>Unavailable</em>
        : <>{tooltip.angle.toFixed(3)}<span>°</span></>}</dd></div>
    </dl>
  </aside>
}

function HarmonicStem({ x, baseline, height, hitWidth, channelIndex, detail, combined,
  highlighted, dimmed, onShow, onHide }: {
  x: number
  baseline: number
  height: number
  hitWidth: number
  channelIndex: number
  detail: HarmonicTooltipDetail
  combined?: boolean
  highlighted: boolean
  dimmed: boolean
  onShow: (event: ReactPointerEvent<SVGRectElement>, detail: HarmonicTooltipDetail) => void
  onHide: () => void
}) {
  const y = baseline - height
  const label = harmonicTooltipText(detail)
  return <g>
    <line className={`harmonic-skyline-stem channel-${channelIndex}` +
      `${combined ? ' combined' : ''}${highlighted ? ' highlighted' : ''}` +
      `${dimmed ? ' dimmed' : ''}`}
      x1={x} x2={x} y1={baseline} y2={y} vectorEffect="non-scaling-stroke"
      aria-hidden="true" />
    <rect className="harmonic-skyline-stem-hit" x={x - hitWidth / 2} y="0"
      width={hitWidth} height={baseline} aria-label={label}
      onPointerEnter={(event) => onShow(event, detail)}
      onPointerLeave={onHide} onPointerCancel={onHide}>
      <title>{label}</title>
    </rect>
  </g>
}

function HarmonicStatus({ ok, pending = false, children }: {
  ok: boolean
  pending?: boolean
  children: string
}) {
  const state = pending ? 'neutral' : ok ? 'ok' : 'bad'
  return <span className={`status-pill ${state}`}><i />{children}</span>
}

function HarmonicRangeShortcuts({ range, onChange, includeFundamental = false }: {
  range: HarmonicOrderRange
  onChange: (range: HarmonicOrderRange) => void
  includeFundamental?: boolean
}) {
  return <div className="harmonic-range-shortcuts" role="group"
    aria-label="Harmonic order range shortcuts">
    {HARMONIC_RANGE_SHORTCUTS.map((shortcut) => {
      const active = range.first === shortcut.first && range.last === shortcut.last
      const label = includeFundamental && shortcut.first === 2 && shortcut.last === 32
        ? 'H1–H32'
        : shortcut.label
      return <button type="button" className={active ? 'active' : ''}
        aria-pressed={active} onClick={() => onChange({
          first: shortcut.first,
          last: shortcut.last,
        })} key={shortcut.label}>{label}</button>
    })}
  </div>
}

function HarmonicCell({ point, fundamental, channel, qualified, display }: {
  point: HarmonicOrder | undefined
  fundamental: HarmonicOrder | undefined
  channel: HarmonicChannel | undefined
  qualified: boolean
  display: HarmonicDisplay
}) {
  if (!qualified) {
    return <td className="harmonic-value unavailable"><strong>—</strong>
      <small>Not qualified</small></td>
  }

  const value = displayedValue(point, fundamental, display)
  if (value === undefined) {
    return <td className="harmonic-value unavailable"><strong>—</strong>
      <small>{display === 'percentage' && point?.magnitude_valid
        ? 'Fundamental unavailable'
        : 'Unavailable'}</small></td>
  }

  return <td className="harmonic-value">
    <strong>{display === 'magnitude'
      ? <>{formatMagnitude(value)} <span>{channel?.unit ?? ''}</span></>
      : <>{formatPercentage(value)} <span>% H1</span></>}</strong>
    {point?.angle_valid && <small>Relative angle {point.angle_degrees.toFixed(3)}°</small>}
  </td>
}

function HarmonicOverview({ columns, channelByIndex, ordersByChannel, qualifiedMaxOrder,
  display, group, view, orderRange, onOrderRangeChange }: {
  columns: ChannelColumn[]
  channelByIndex: Map<number, HarmonicChannel>
  ordersByChannel: Map<number, Map<number, HarmonicOrder>>
  qualifiedMaxOrder: number
  display: HarmonicDisplay
  group: HarmonicGroup
  view: HarmonicChartView
  orderRange: HarmonicOrderRange
  onOrderRangeChange: (range: HarmonicOrderRange) => void
}) {
  const [tooltip, setTooltip] = useState<HarmonicTooltipState>()
  const summaryOrders = ordersInRange(orderRange)
  const axisOrders = summaryAxisOrders(orderRange)
  const orderStep = summaryOrderStep(orderRange)
  const visibleOrderCount = rangeOrderCount(orderRange)
  const canZoomIn = visibleOrderCount > HARMONIC_ZOOM_ORDER_COUNTS[0]
  const canZoomOut = visibleOrderCount < MAX_HARMONIC_ZOOM_ORDER_COUNT
  const series = columns.map((column) => {
    const channel = channelByIndex.get(column.channel)
    const orders = ordersByChannel.get(column.channel)
    const fundamental = orders?.get(1)
    const values = summaryOrders.map((order) => {
      const point = orders?.get(order)
      return {
        order,
        point,
        percentage: percentageOfFundamental(point, fundamental),
        value: order <= qualifiedMaxOrder
          ? displayedValue(point, fundamental, display)
          : undefined,
      }
    })
    return { column, channel, fundamental, values }
  })
  const validValues = series.flatMap((item) => item.values.flatMap(({ value }) =>
    value === undefined ? [] : [value]))
  const peak = Math.max(0, ...validValues)
  const unit = series.find((item) => item.channel?.unit)?.channel?.unit ?? ''
  const yAxisLabel = display === 'magnitude'
    ? `Magnitude (${group === 'voltage' ? 'V' : 'A'} RMS)`
    : 'Percentage of H1 (%)'

  useEffect(() => setTooltip(undefined), [columns, display, orderRange, view])

  const showTooltip = (event: ReactPointerEvent<SVGRectElement>,
    detail: HarmonicTooltipDetail) => {
    const halfWidth = Math.min(130, Math.max(0, window.innerWidth / 2 - 12))
    const x = Math.min(
      Math.max(event.clientX, halfWidth + 12),
      window.innerWidth - halfWidth - 12,
    )
    setTooltip({
      ...detail,
      x,
      y: event.clientY,
      below: event.clientY < 180,
    })
  }

  const detailFor = (channelIndex: number, column: ChannelColumn,
    channel: HarmonicChannel | undefined, point: HarmonicOrder,
    percentage: number | undefined): HarmonicTooltipDetail => ({
    channelIndex,
    channelLabel: column.label,
    order: point.order,
    magnitude: point.magnitude,
    unit: channel?.unit ?? (group === 'voltage' ? 'V' : 'A'),
    percentage,
    angle: point.angle_valid ? point.angle_degrees : undefined,
  })

  return <section className="harmonic-overview" aria-labelledby="harmonic-overview-title">
    <div className="harmonic-overview-heading">
      <div>
        <p className="eyebrow">Spectrum overview</p>
        <h3 id="harmonic-overview-title">Orders {orderRange.first}–{orderRange.last}</h3>
        <p>{view === 'lanes'
          ? 'Each lane is one selected channel. All lanes share the same vertical scale.'
          : 'Channels are grouped at each harmonic order on one shared scale.'}</p>
      </div>
      <div className="harmonic-overview-peak">
        <span>Largest displayed harmonic</span>
        <strong>{peak > 0 ? formatDisplayedValue(peak, unit, display) : '—'}</strong>
      </div>
    </div>

    <div className="harmonic-chart-toolbar">
      <div className="harmonic-range-control">
        <span className="harmonic-chart-control-label">Order range</span>
        <HarmonicRangeShortcuts range={orderRange} onChange={onOrderRangeChange} />
      </div>
      <div className="harmonic-zoom-control">
        <span className="harmonic-chart-control-label">Zoom</span>
        <div className="harmonic-zoom-buttons">
          <button type="button" disabled={!canZoomOut}
            aria-label="Zoom out to show more harmonic orders"
            title="Zoom out to show more harmonic orders"
            onClick={() => onOrderRangeChange(zoomedRange(orderRange, 'out'))}>
            <span aria-hidden="true">−</span> Zoom out
          </button>
          <button type="button" disabled={!canZoomIn}
            aria-label="Zoom in to show fewer harmonic orders"
            title="Zoom in to show fewer harmonic orders"
            onClick={() => onOrderRangeChange(zoomedRange(orderRange, 'in'))}>
            <span aria-hidden="true">+</span> Zoom in
          </button>
        </div>
        <output aria-live="polite">H{orderRange.first}–H{orderRange.last}
          <small>{visibleOrderCount} orders</small></output>
      </div>
    </div>

    <div className={`harmonic-plot-shell ${view}`}>
      <div className="harmonic-y-axis-label" aria-label={`Y axis: ${yAxisLabel}`}>
        <span>{yAxisLabel}</span>
      </div>
      {view === 'lanes'
        ? <div className="harmonic-skyline-list">
          {series.map(({ column, channel, fundamental, values }, channelIndex) => {
            const reference = fundamental?.magnitude_valid
              ? `${formatMagnitude(fundamental.magnitude)}${channel?.unit ? ` ${channel.unit}` : ''}`
              : 'Unavailable'
            return <article className="harmonic-skyline-row" key={column.channel}>
              <header>
                <span><i className={`channel-${channelIndex}`} />{column.label}</span>
                <small>H1 reference <strong>{reference}</strong></small>
              </header>
              <svg viewBox={`0 0 ${SUMMARY_WIDTH} 64`} preserveAspectRatio="none" role="img"
                aria-label={`${column.label} harmonic orders ${orderRange.first} through ${orderRange.last}; ${yAxisLabel}`}>
                {[8, 34, SUMMARY_BASELINE].map((y) => <line className="harmonic-skyline-grid"
                  x1="0" x2={SUMMARY_WIDTH} y1={y} y2={y} key={y} />)}
                {values.map(({ order, point, percentage, value }) => {
                  if (!point || value === undefined || value <= 0 || peak <= 0) return null
                  const height = Math.max(1.5, (value / peak) * SUMMARY_HEIGHT)
                  return <HarmonicStem x={summaryOrderX(order, orderRange)} baseline={SUMMARY_BASELINE}
                    height={height} hitWidth={orderStep} channelIndex={channelIndex}
                    detail={detailFor(channelIndex, column, channel, point, percentage)}
                    highlighted={tooltip?.order === order}
                    dimmed={tooltip !== undefined && tooltip.order !== order}
                    onShow={showTooltip} onHide={() => setTooltip(undefined)} key={order} />
                })}
              </svg>
            </article>
          })}
          <div className="harmonic-skyline-axis" aria-hidden="true">
            {axisOrders.map((order) => <span key={order}>H{order}</span>)}
          </div>
          {peak === 0 && <p className="harmonic-overview-empty">No valid harmonics above H1 are available.</p>}
        </div>
        : <div className="harmonic-combined-view">
          <div className="harmonic-combined-legend" aria-label="Displayed channels">
            {series.map(({ column, channel, fundamental }, channelIndex) => {
              const reference = fundamental?.magnitude_valid
                ? `${formatMagnitude(fundamental.magnitude)}${channel?.unit ? ` ${channel.unit}` : ''}`
                : 'Unavailable'
              return <span key={column.channel}><i className={`channel-${channelIndex}`} />
                <strong>{column.label}</strong><small>H1 {reference}</small></span>
            })}
          </div>
          <svg className="harmonic-combined-chart"
            viewBox={`0 0 ${SUMMARY_WIDTH} ${SUMMARY_COMBINED_VIEWBOX_HEIGHT}`}
            preserveAspectRatio="none" role="img"
            aria-label={`Combined ${group} harmonic orders ${orderRange.first} through ${orderRange.last}; ${yAxisLabel}`}>
            {[14, 80, SUMMARY_COMBINED_BASELINE].map((y) =>
              <line className="harmonic-skyline-grid" x1="0" x2={SUMMARY_WIDTH}
                y1={y} y2={y} key={y} />)}
            {series.flatMap(({ column, channel, values }, channelIndex) =>
              values.map(({ order, point, percentage, value }) => {
                if (!point || value === undefined || value <= 0 || peak <= 0) return null
                const channelSpacing = combinedChannelSpacing(orderStep, columns.length)
                const offset = (channelIndex - (columns.length - 1) / 2) * channelSpacing
                const height = Math.max(1.5, (value / peak) * SUMMARY_COMBINED_HEIGHT)
                return <HarmonicStem x={summaryOrderX(order, orderRange) + offset}
                  baseline={SUMMARY_COMBINED_BASELINE} height={height}
                  hitWidth={Math.max(1.5, channelSpacing)} channelIndex={channelIndex} combined
                  detail={detailFor(channelIndex, column, channel, point, percentage)}
                  highlighted={tooltip?.order === order}
                  dimmed={tooltip !== undefined && tooltip.order !== order}
                  onShow={showTooltip} onHide={() => setTooltip(undefined)}
                  key={`${column.channel}-${order}`} />
              }),
            )}
          </svg>
          <div className="harmonic-combined-axis" aria-hidden="true">
            {axisOrders.map((order) => <span key={order}>H{order}</span>)}
          </div>
          {peak === 0 && <p className="harmonic-overview-empty combined">No valid harmonics above H1 are available.</p>}
        </div>}
    </div>
    <HarmonicTooltip tooltip={tooltip} />
  </section>
}

function ReadingIntervalSelect({ id, value, onChange }: {
  id: string
  value: ReadingInterval
  onChange: (interval: ReadingInterval) => void
}) {
  return <label className="reading-interval-select" htmlFor={id}>
    Measurement interval
    <select id={id} value={value}
      onChange={(event) => onChange(event.target.value as ReadingInterval)}>
      <option value="basic">10/12 cycles</option>
      <option value="aggregate">150/180 cycles</option>
      <option value="min10">10 minutes</option>
      <option value="hour2">2 hours</option>
    </select>
  </label>
}

function RecordContextBar({
  interval, record, state, section, intervalError, onIntervalChange,
}: {
  interval: ReadingInterval
  record: ReadingRecord | undefined
  state: IntervalPresentationState
  section: Exclude<ReadingSubtab, 'harmonics'>
  intervalError: string
  onIntervalChange: (interval: ReadingInterval) => void
}) {
  const contextKeys = section === 'overview' ? OVERVIEW_CONTEXT_KEYS
    : section === 'power' ? POWER_CONTEXT_KEYS
      : section === 'sequence' ? SEQUENCE_CONTEXT_KEYS : PHASOR_CONTEXT_KEYS
  const quality = record ? visibleQuality(contextKeys.map((key) => attribute(record, key))) : undefined
  const qualityLabel = quality === 'valid' ? 'Visible values valid'
    : quality === 'partial' ? 'Some values unavailable'
      : quality === 'invalid' ? 'Invalid values present' : 'Awaiting complete record'
  const synchronization = record?.timeQuality === 'synchronized' ? 'Clock synchronized'
    : record?.timeQuality === 'holdover' ? 'Clock holdover'
      : record?.timeQuality === 'unsynchronized' ? 'Unsynchronized' : 'Timing unavailable'
  const uncertainty = record?.utcUncertaintyNanoseconds === undefined ? undefined
    : record.utcUncertaintyNanoseconds / 1_000_000

  const modeLabel = state === 'ready' ? 'Finalized'
    : state === 'rejected' ? 'Previous finalized'
      : state === 'priming' ? 'Priming' : 'Waiting'
  const intervalName = interval === 'min10' ? '10-minute'
    : interval === 'hour2' ? '2-hour' : READING_INTERVAL_LABELS[interval]

  return <section className="record-context" aria-label="Meter record context">
    <ReadingIntervalSelect id="shared-reading-interval" value={interval}
      onChange={onIntervalChange} />
    <div className="record-context-status">
      <span className={`record-mode-badge state-${state}`}>{modeLabel}</span>
      <span className={`record-quality quality-${quality ?? 'waiting'}`}>{qualityLabel}</span>
      <span>{synchronization}</span>
      {record?.flags.map((flag) => <span className="record-flag" key={flag}>{flag}</span>)}
    </div>
    <dl>
      <div><dt>Record sequence</dt><dd>{record ? formatCount(record.sequence) : '—'}</dd></div>
      <div><dt>UTC start</dt><dd>{formatUtc(record?.utcStartNanoseconds)}</dd></div>
      <div><dt>UTC uncertainty</dt><dd>{uncertainty === undefined
        ? '—' : `±${uncertainty.toLocaleString('en-US', { maximumFractionDigits: 3 })} ms`}</dd></div>
    </dl>
    {state === 'priming' && <div className="interval-state-banner priming"
      role="status" aria-live="polite">
      <strong>Waiting for the first clean finalized {intervalName} interval</strong>
      <span>{interval === 'min10'
        ? 'The partial UTC window closed at startup remains available for diagnostics. The display waits for the following complete 10-minute window, so startup can cross two UTC boundaries.'
        : 'Only clean, time-aligned 10-minute intervals contribute to the first 2-hour result. Partial startup data remains available for diagnostics but is not presented as a measurement.'}</span>
    </div>}
    {state === 'rejected' && <div className="interval-state-banner rejected" role="alert">
      <strong>Latest {intervalName} interval rejected</strong>
      <span>{record
        ? `Showing finalized record ${formatCount(record.sequence)} as stale while waiting for the next clean, time-aligned interval.`
        : 'Waiting for the next clean, time-aligned interval.'}</span>
    </div>}
    {intervalError && <div className="error-banner"><strong>Interval unavailable</strong>
      <span>{intervalError}</span></div>}
  </section>
}

function OverviewReading({ record, name, metricKey, digits }: {
  record: ReadingRecord
  name: string
  metricKey: string
  digits: number
}) {
  const reading = attribute(record, metricKey)
  const quality = effectiveQuality(reading)
  return <article className={`overview-reading quality-${quality.replaceAll('_', '-')}`}>
    <span>{name}</span>
    <strong>{formatReading(reading, digits)}</strong>
    <small>{quality.replaceAll('_', ' ')}</small>
  </article>
}

function ReadingOverview({ interval, record }: {
  interval: ReadingInterval
  record: ReadingRecord | undefined
}) {
  const active = powerAttribute(record, 'active', 'total')
  const reactive = powerAttribute(record, 'reactive', 'total')
  return <section className="reading-section" aria-labelledby="reading-overview-title">
    <div className="reading-section-heading compact">
      <div>
        <p className="eyebrow">Operator summary</p>
        <h2 id="reading-overview-title">Electrical state at a glance</h2>
        <p>{READING_INTERVAL_LABELS[interval]} · one coherent backend record.</p>
      </div>
    </div>
    {!record
      ? <div className="harmonic-empty">
        <strong>Waiting for {READING_INTERVAL_LABELS[interval]} data</strong>
        <span>The previous generation is cleared immediately; this view commits only when every
          derived sibling has the same source sequence.</span>
      </div>
      : <div className="overview-groups">
        <section className="overview-group" aria-labelledby="overview-voltage-heading">
          <header><p className="eyebrow">Line-line voltage</p>
            <h3 id="overview-voltage-heading">Three-phase voltage</h3></header>
          <div className="overview-reading-grid three">
            <OverviewReading record={record} name="Vab" metricKey="voltage.ll.ab.rms" digits={3} />
            <OverviewReading record={record} name="Vbc" metricKey="voltage.ll.bc.rms" digits={3} />
            <OverviewReading record={record} name="Vca" metricKey="voltage.ll.ca.rms" digits={3} />
          </div>
        </section>
        <section className="overview-group" aria-labelledby="overview-power-heading">
          <header><p className="eyebrow">Total power</p>
            <h3 id="overview-power-heading">Authoritative system totals</h3></header>
          <div className="overview-reading-grid four">
            <OverviewReading record={record} name="Active power P"
              metricKey="power.active.total" digits={2} />
            <OverviewReading record={record} name="Apparent power S"
              metricKey="power.apparent.total" digits={2} />
            <OverviewReading record={record} name="True power factor"
              metricKey="power.factor.total" digits={4} />
            <OverviewReading record={record} name="Fundamental reactive power Q₁"
              metricKey="power.reactive.total" digits={2} />
          </div>
          <div className="overview-operating-mode"><span>Operating mode</span>
            <strong>{operatingMode(active, reactive)}</strong></div>
        </section>
        <section className="overview-group" aria-labelledby="overview-unbalance-heading">
          <header><p className="eyebrow">Power quality</p>
            <h3 id="overview-unbalance-heading">Unbalance</h3></header>
          <div className="overview-reading-grid two">
            <OverviewReading record={record} name="Voltage unbalance"
              metricKey="unbalance.voltage" digits={3} />
            <OverviewReading record={record} name="Current unbalance"
              metricKey="unbalance.current" digits={3} />
          </div>
        </section>
      </div>}
  </section>
}

function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360
}

function phasorReadings(
  record: ReadingRecord,
  topology: MeasurementTopology,
): PhasorReading[] {
  const channels = new Map(record.channels.map((channel) => [channel.index, channel]))
  const attributes = new Map(record.attributes.map((attribute) => [attribute.key, attribute]))
  return PHASOR_DEFINITIONS.map((definition) => {
    const channel = channels.get(definition.channel)
    const angle = attributes.get(definition.angleKey)
    const deltaVoltage = topology === 'delta' && definition.group === 'voltage'
      ? {
          a: { label: 'Vab', description: 'Line voltage AB' },
          b: { label: 'Vbc', description: 'Line voltage BC' },
          c: { label: 'Vca', description: 'Line voltage CA' },
        }[definition.phase]
      : undefined
    return {
      ...definition,
      ...deltaVoltage,
      unit: channel?.unit ?? (definition.group === 'voltage' ? 'V' : 'A'),
      magnitude: channel?.rms ?? 0,
      magnitudeValid: channel?.valid ?? false,
      angle: angle?.value ?? 0,
      angleValid: isValidReading(angle),
    }
  })
}

function PhasorDiagram({ readings, nominalVoltage, topology }: {
  readings: PhasorReading[]
  nominalVoltage: number
  topology: MeasurementTopology
}) {
  const [activeLabel, setActiveLabel] = useState<string>()
  const center = 220
  const outerRadius = 180
  const valid = readings.filter((reading) =>
    reading.magnitudeValid && reading.angleValid && reading.magnitude >= 0)
  const maximumVoltage = Math.max(0, ...valid
    .filter((reading) => reading.group === 'voltage')
    .map((reading) => reading.magnitude))
  const maximumCurrent = Math.max(0, ...valid
    .filter((reading) => reading.group === 'current')
    .map((reading) => reading.magnitude))
  const includesVoltage = readings.some((reading) => reading.group === 'voltage')
  const includesCurrent = readings.some((reading) => reading.group === 'current')
  const spokes = Array.from({ length: 12 }, (_, index) => index * 30)
  const voltageScaleMaximum = Math.max(nominalVoltage * 1.2, maximumVoltage * 1.05)
  const nominalRadius = outerRadius * nominalVoltage / voltageScaleMaximum
  const active = valid.find((reading) => reading.label === activeLabel)

  const radiusFor = (reading: PhasorReading) => {
    if (reading.group === 'voltage') {
      return outerRadius * reading.magnitude / voltageScaleMaximum
    }
    if (maximumCurrent <= 0) return 0
    return (reading.magnitude / maximumCurrent) *
      (includesVoltage && includesCurrent ? outerRadius * 0.72 : outerRadius)
  }

  return <section className="phasor-diagram-panel" aria-labelledby="phasor-diagram-title">
    <header>
      <div><p className="eyebrow">Vector view</p>
        <h3 id="phasor-diagram-title">Fundamental phasor diagram</h3></div>
      <span>{includesVoltage
        ? `${formatMagnitude(nominalVoltage)} V ${topology === 'delta' ? 'L-L' : 'L-N'} nominal`
        : 'Current normalized to Imax'}</span>
    </header>
    <div className="phasor-diagram-frame">
      <svg viewBox="0 0 440 440" role="img"
        aria-labelledby="phasor-diagram-svg-title phasor-diagram-svg-description">
        <title id="phasor-diagram-svg-title">Fundamental voltage and current phasors</title>
        <desc id="phasor-diagram-svg-description">Zero degrees points right and positive angles
          rotate counter-clockwise. Voltage magnitude uses the configured
          {topology === 'delta' ? ' line-to-line' : ' line-to-neutral'} nominal voltage.</desc>
        <circle className="phasor-grid-ring outer" cx={center} cy={center} r={outerRadius} />
        {[outerRadius / 3, outerRadius * 2 / 3].map((radius) => <circle
          className="phasor-grid-ring"
          cx={center} cy={center} r={radius} key={radius} />)}
        {includesVoltage && <circle className="phasor-grid-ring nominal"
          cx={center} cy={center} r={nominalRadius} />}
        {spokes.map((angle) => {
          const radians = angle * Math.PI / 180
          return <line className="phasor-grid-spoke" x1={center} y1={center}
            x2={center + Math.cos(radians) * outerRadius}
            y2={center - Math.sin(radians) * outerRadius} key={angle} />
        })}
        <text className="phasor-axis-label" x="412" y="224" textAnchor="end">0°</text>
        <text className="phasor-axis-label" x="220" y="18" textAnchor="middle">90°</text>
        <text className="phasor-axis-label" x="27" y="224">180°</text>
        <text className="phasor-axis-label" x="220" y="432" textAnchor="middle">270°</text>
        {valid.map((reading) => {
          const radians = normalizeAngle(reading.angle) * Math.PI / 180
          const unitX = Math.cos(radians)
          const unitY = -Math.sin(radians)
          const radius = radiusFor(reading)
          const x = center + unitX * radius
          const y = center + unitY * radius
          const perpendicularX = -unitY
          const perpendicularY = unitX
          const arrowBaseX = x - unitX * 12
          const arrowBaseY = y - unitY * 12
          const arrow = `${x},${y} ` +
            `${arrowBaseX + perpendicularX * 5},${arrowBaseY + perpendicularY * 5} ` +
            `${arrowBaseX - perpendicularX * 5},${arrowBaseY - perpendicularY * 5}`
          const labelX = x + unitX * 14
          const labelY = y + unitY * 14
          const anchor = unitX > 0.25 ? 'start' : unitX < -0.25 ? 'end' : 'middle'
          const highlighted = active?.label === reading.label
          const dimmed = active !== undefined && !highlighted
          const accessibleDetail = `${reading.label}, ${reading.description}, ` +
            `${formatMagnitude(reading.magnitude)} ${reading.unit} RMS, ` +
            `${normalizeAngle(reading.angle).toFixed(3)} degrees`
          return <g className={`phasor-vector ${reading.group} phase-${reading.phase}` +
              `${highlighted ? ' highlighted' : ''}${dimmed ? ' dimmed' : ''}`}
            role="img" tabIndex={0} aria-label={accessibleDetail}
            aria-describedby={highlighted ? 'phasor-vector-detail' : undefined}
            onPointerEnter={() => setActiveLabel(reading.label)}
            onPointerLeave={() => setActiveLabel((current) =>
              current === reading.label ? undefined : current)}
            onPointerCancel={() => setActiveLabel(undefined)}
            onFocus={() => setActiveLabel(reading.label)}
            onBlur={() => setActiveLabel((current) =>
              current === reading.label ? undefined : current)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setActiveLabel(undefined)
              }
            }} key={reading.label}>
            <title>{reading.label}: {formatMagnitude(reading.magnitude)} {reading.unit} RMS,
              {' '}{normalizeAngle(reading.angle).toFixed(3)} degrees</title>
            <line x1={center} y1={center} x2={x} y2={y} />
            <polygon points={arrow} />
            <text x={labelX} y={labelY} textAnchor={anchor}>{reading.label}</text>
            <line className="phasor-vector-hit" x1={center} y1={center} x2={x} y2={y}
              aria-hidden="true" />
          </g>
        })}
        <circle className="phasor-origin" cx={center} cy={center} r="4" />
      </svg>
      {active && <aside id="phasor-vector-detail"
        className={`phasor-vector-detail ${active.group} phase-${active.phase}`} role="tooltip">
        <header><i /><span><strong>{active.label}</strong><small>{active.description}</small></span></header>
        <dl>
          <div><dt>Magnitude</dt><dd>{formatMagnitude(active.magnitude)}
            <span>{active.unit} RMS</span></dd></div>
          <div><dt>Angle</dt><dd>{normalizeAngle(active.angle).toFixed(3)}<span>°</span></dd></div>
          <div><dt>Plot scale</dt><dd>{active.group === 'voltage'
            ? nominalVoltage > 0
              ? `${(active.magnitude / nominalVoltage * 100).toFixed(2)} % nominal`
              : 'Nominal unavailable'
            : maximumCurrent > 0
              ? `${(active.magnitude / maximumCurrent * 100).toFixed(2)} % Imax`
              : 'Imax unavailable'}</dd></div>
        </dl>
      </aside>}
      {valid.length === 0 && <div className="phasor-diagram-empty">
        <strong>No valid phase angles</strong>
        <span>The selected interval does not provide drawable phasors.</span>
      </div>}
    </div>
    <footer>
      {includesVoltage && <span><i className="voltage" />Voltage: solid, nominal-voltage scale</span>}
      {includesCurrent && <span><i className="current" />Current: dashed, normalized to Imax</span>}
      <span>0° right · positive counter-clockwise</span>
    </footer>
  </section>
}

function PhasorUnbalanceSummary({ record }: { record: ReadingRecord }) {
  const groups = [
    { title: 'Unbalance ratios', entries: [
      ['Voltage unbalance', 'unbalance.voltage'],
      ['Current unbalance', 'unbalance.current'],
      ['Voltage zero-sequence ratio', 'unbalance.voltage.zero'],
      ['Current zero-sequence ratio', 'unbalance.current.zero'],
    ] },
  ]
  return <div className="phasor-context-grid">
    {groups.map((group) => <section className="phasor-context-card" key={group.title}>
      <h3>{group.title}</h3><dl>{group.entries.map(([label, key]) => {
        const reading = attribute(record, key)
        return <div key={key}><dt>{label}</dt><dd>{formatReading(reading, 3)}</dd></div>
      })}</dl>
    </section>)}
  </div>
}

function RawPhasorDetails({ record }: { record: ReadingRecord }) {
  const readings = record.attributes.filter((reading) =>
    reading.key.startsWith('phase.angle.') || PHASOR_CONTEXT_KEYS.includes(reading.key))
  return <details className="reading-advanced">
    <summary>Advanced phasor and unbalance details <span>{readings.length} fields</span></summary>
    <div className="reading-advanced-scroll"><table>
      <thead><tr><th>Friendly name</th><th>Raw key</th><th>Value / unit</th>
        <th>Quality</th><th>Source sequence</th></tr></thead>
      <tbody>{readings.map((reading) => <tr key={reading.key}>
        <td>{friendlyAttributeName(reading.key)}</td><td><code>{reading.key}</code></td>
        <td>{formatReading(reading, 3)}</td><td>{effectiveQuality(reading)}</td>
        <td>{formatCount(reading.source_sequence)}</td>
      </tr>)}</tbody>
    </table></div>
  </details>
}

function PhasorUnbalanceView({
  interval, record, nominalVoltage, topology, scope, onScopeChange,
}: {
  interval: ReadingInterval
  record: ReadingRecord | undefined
  nominalVoltage: number
  topology: MeasurementTopology
  scope: PhasorScope
  onScopeChange: (scope: PhasorScope) => void
}) {
  const allReadings = record ? phasorReadings(record, topology) : []
  const displayed = allReadings.filter((reading) =>
    scope === 'all' || reading.group === scope)

  return <section className="reading-section" aria-labelledby="phasor-angle-title">
    <div className="reading-section-heading compact">
      <div>
        <p className="eyebrow">Fundamental vectors</p>
        <h2 id="phasor-angle-title">Phasor &amp; unbalance</h2>
        <p>Compare phase relationships and unbalance from one coherent record.</p>
      </div>
    </div>

    {!record
      ? <div className="harmonic-empty">
        <strong>Waiting for {READING_INTERVAL_LABELS[interval]} phasors</strong>
        <span>The diagram appears when the selected finalized interval is available.</span>
      </div>
      : <>
        <div className="phasor-toolbar">
          <div>
            <span className="harmonic-control-label" id="phasor-scope-label">Displayed vectors</span>
            <div className="phasor-scope-toggle" role="group" aria-labelledby="phasor-scope-label">
              {(['voltage', 'current', 'all'] as PhasorScope[]).map((option) =>
                <button type="button" className={scope === option ? 'active' : ''}
                  aria-pressed={scope === option} onClick={() => onScopeChange(option)} key={option}>
                  {option === 'voltage' ? 'Voltage' : option === 'current' ? 'Current' : 'All'}
                </button>)}
            </div>
          </div>
          <span>Every vector is labeled by phase · record {formatCount(record.sequence)}</span>
        </div>
        <div className="phasor-workspace">
          <section className="phasor-readout-panel" aria-label="Phasor values">
            <header><p className="eyebrow">Phasor values</p><h3>Magnitude and phase angle</h3></header>
            <div className="phasor-readout-list">
              {displayed.map((reading) => <article
                className={`${reading.group} phase-${reading.phase}`} key={reading.label}>
                <div><i /><span><strong>{reading.label}</strong><small>{reading.description}</small></span></div>
                <dl>
                  <div><dt>Magnitude</dt><dd>{reading.magnitudeValid
                    ? <>{formatMagnitude(reading.magnitude)} <span>{reading.unit} RMS</span></>
                    : <em>Unavailable</em>}</dd></div>
                  <div><dt>Angle</dt><dd>{reading.angleValid
                    ? <>{normalizeAngle(reading.angle).toFixed(3)}<span>°</span></>
                    : <em>Unavailable</em>}</dd></div>
                </dl>
              </article>)}
            </div>
            <p className="phasor-readout-note">Neutral current is omitted because the metrology catalog
              currently publishes phase angles for Ia, Ib, and Ic only.</p>
          </section>
          <PhasorDiagram readings={displayed} nominalVoltage={nominalVoltage}
            topology={topology} />
        </div>
        <PhasorUnbalanceSummary record={record} />
        <RawPhasorDetails record={record} />
      </>}
  </section>
}

/**
 * Viewer-facing metrology results. Harmonic families are atomic: a previous
 * family is never mixed with a partial replacement while the API assembles
 * its seven channels and six chunks per channel.
 */
export function ReadingPage({
  readings, onUnauthorized, systemNominalVoltage, measurementTopology,
  canReset = false, canConfigure = false, acquisitionAvailable = true,
}: {
  readings: MeterReadings | undefined
  onUnauthorized: () => void
  systemNominalVoltage: number
  measurementTopology: MeasurementTopology
  canReset?: boolean
  canConfigure?: boolean
  acquisitionAvailable?: boolean
}) {
  const [activeSubtab, setActiveSubtab] = useState<ReadingSubtab>('overview')
  const [readingInterval, setReadingInterval] = useState<ReadingInterval>('basic')
  const [powerScope, setPowerScope] = useState<PowerScope>('total')
  const [phasorScope, setPhasorScope] = useState<PhasorScope>('all')
  const [completeRecords, setCompleteRecords] = useState<CompleteRecordCache>({})
  const [harmonicSpectra, setHarmonicSpectra] = useState<HarmonicSpectrumCache>({})
  const [aggregate, setAggregate] = useState<MeterAggregate>()
  const [tenMinute, setTenMinute] = useState<MeterTenMinute>()
  const [twoHour, setTwoHour] = useState<MeterTwoHour>()
  const [intervalError, setIntervalError] = useState('')
  const [group, setGroup] = useState<HarmonicGroup>('voltage')
  const [period, setPeriod] = useState<Exclude<HarmonicPeriod, 'basic'>>('cycles_150_180')
  const [display, setDisplay] = useState<HarmonicDisplay>('percentage')
  const [chartView, setChartView] = useState<HarmonicChartView>('combined')
  const [orderRange, setOrderRange] = useState<HarmonicOrderRange>(FULL_SUMMARY_RANGE)
  const [spectrum, setSpectrum] = useState<HarmonicSpectrum>()
  const [harmonicError, setHarmonicError] = useState('')

  useEffect(() => {
    if (!acquisitionAvailable || activeSubtab === 'harmonics' || readingInterval === 'basic') {
      setIntervalError('')
      return
    }

    let active = true
    let pending = false
    const refresh = async () => {
      if (!active || pending) return
      pending = true
      try {
        if (readingInterval === 'aggregate') {
          const next = await api.meterAggregate()
          if (active) setAggregate(next)
        } else if (readingInterval === 'min10') {
          const next = await api.meterTenMinute()
          if (active) setTenMinute(next)
        } else {
          const next = await api.meterTwoHour()
          if (active) setTwoHour(next)
        }
        if (active) setIntervalError('')
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          onUnauthorized()
          return
        }
        setIntervalError(reason instanceof Error
          ? reason.message
          : `Unable to read ${READING_INTERVAL_LABELS[readingInterval]} data`)
      } finally {
        pending = false
      }
    }
    void refresh()
    const pollMilliseconds = readingInterval === 'aggregate' ? 1000
      : readingInterval === 'min10' ? 5000 : 10000
    const timer = window.setInterval(refresh, pollMilliseconds)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [acquisitionAvailable, activeSubtab, onUnauthorized, readingInterval])

  const loadHarmonics = useCallback(async () => {
    if (!acquisitionAvailable) return
    try {
      setSpectrum(await api.meterHarmonics(period))
      setHarmonicError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setHarmonicError(reason instanceof Error ? reason.message : 'Unable to read harmonics')
    }
  }, [acquisitionAvailable, onUnauthorized, period])

  useEffect(() => {
    if (!acquisitionAvailable || activeSubtab !== 'harmonics') return
    let active = true
    let pending = false
    const refresh = async () => {
      if (!active || pending) return
      pending = true
      await loadHarmonics()
      pending = false
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [acquisitionAvailable, activeSubtab, loadHarmonics])

  useEffect(() => {
    if (acquisitionAvailable) return
    setAggregate(undefined)
    setTenMinute(undefined)
    setTwoHour(undefined)
    setSpectrum(undefined)
    setCompleteRecords({})
    setHarmonicSpectra({})
    setIntervalError('')
    setHarmonicError('')
  }, [acquisitionAvailable])

  const aggregateResult = aggregate?.available ? aggregate : undefined
  const tenMinuteResult = tenMinute?.available ? tenMinute : undefined
  const twoHourResult = twoHour?.available ? twoHour : undefined
  const basicCandidate = useMemo(() => basicReadingRecord(readings), [readings])
  const aggregateCandidate = useMemo(() =>
    aggregateReadingRecord('aggregate', aggregateResult), [aggregateResult])
  const tenMinuteCandidate = useMemo(() =>
    aggregateReadingRecord('min10', tenMinuteResult), [tenMinuteResult])
  const twoHourCandidate = useMemo(() =>
    aggregateReadingRecord('hour2', twoHourResult), [twoHourResult])
  const intervalCandidate = readingInterval === 'basic' ? basicCandidate
    : readingInterval === 'aggregate' ? aggregateCandidate
      : readingInterval === 'min10' ? tenMinuteCandidate : twoHourCandidate
  const activeGeneration = readings?.configuration_generation ??
    intervalCandidate?.configurationGeneration
  const nominalMismatch = harmonicNominalMismatch(readings)
  const harmonicGeneration = readings?.configuration_generation ??
    spectrum?.configuration_generation

  useEffect(() => {
    setCompleteRecords((current) => acquisitionAvailable
      ? updateCompleteRecordCache(current, readingInterval, intervalCandidate, activeGeneration)
      : {})
  }, [acquisitionAvailable, activeGeneration, intervalCandidate, readingInterval])

  const selectedRecord = selectCommittedRecord(
    completeRecords, readingInterval, intervalCandidate, activeGeneration)
  const committedRecord = acquisitionAvailable ? selectedRecord : undefined
  const intervalState = acquisitionAvailable
    ? intervalPresentationState(intervalCandidate, committedRecord, activeGeneration)
    : 'waiting'

  useEffect(() => {
    setHarmonicSpectra((current) => acquisitionAvailable
      ? updateHarmonicSpectrumCache(current, period, spectrum, harmonicGeneration)
      : {})
  }, [acquisitionAvailable, harmonicGeneration, period, spectrum])

  const cachedSpectrum = acquisitionAvailable
    ? selectHarmonicSpectrum(harmonicSpectra, period, spectrum, harmonicGeneration)
    : undefined
  const harmonicState: HarmonicPresentationState = acquisitionAvailable
    ? harmonicPresentationState(spectrum, cachedSpectrum, harmonicGeneration)
    : 'waiting'
  const displayedSpectrum = nominalMismatch ? undefined : cachedSpectrum
  const channels = CHANNEL_GROUPS[group]
  const channelByIndex = useMemo(() => new Map(
    displayedSpectrum?.channels.map((channel) => [channel.channel, channel]) ?? [],
  ), [displayedSpectrum])
  const ordersByChannel = useMemo(() => new Map(
    displayedSpectrum?.channels.map((channel) => [
      channel.channel,
      new Map(channel.orders.map((order) => [order.order, order])),
    ]) ?? [],
  ), [displayedSpectrum])
  const anglesAvailable = displayedSpectrum?.available === true && channels.some((column) =>
    channelByIndex.get(column.channel)?.orders.some((order) => order.angle_valid))
  const tableFirstOrder = orderRange.first === FIRST_SUMMARY_ORDER ? 1 : orderRange.first
  const tableOrders = ALL_HARMONIC_ORDERS.filter((order) =>
    order >= tableFirstOrder && order <= orderRange.last)

  return <section className="reading-page">
    <header className="reading-heading">
      <p className="eyebrow">Readings</p>
      <h1>Meter readings</h1>
      <p>Inspect processed measurement products from the programmable-logic metrology pipeline.</p>
    </header>

    <nav className="reading-subtabs" aria-label="Reading sections">
      <button className={activeSubtab === 'overview' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'overview' ? 'page' : undefined}
        onClick={() => setActiveSubtab('overview')}>Overview</button>
      <button className={activeSubtab === 'power' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'power' ? 'page' : undefined}
        onClick={() => setActiveSubtab('power')}>Power</button>
      <button className={activeSubtab === 'energy' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'energy' ? 'page' : undefined}
        onClick={() => setActiveSubtab('energy')}>Energy &amp; Demand</button>
      <button className={activeSubtab === 'phasor' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'phasor' ? 'page' : undefined}
        onClick={() => setActiveSubtab('phasor')}>Phasor &amp; Unbalance</button>
      <button className={activeSubtab === 'sequence' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'sequence' ? 'page' : undefined}
        onClick={() => setActiveSubtab('sequence')}>Sequence</button>
      <button className={activeSubtab === 'harmonics' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'harmonics' ? 'page' : undefined}
        onClick={() => setActiveSubtab('harmonics')}>Harmonics</button>
      <button className={activeSubtab === 'power-quality' ? 'active' : ''} type="button"
        aria-current={activeSubtab === 'power-quality' ? 'page' : undefined}
        onClick={() => setActiveSubtab('power-quality')}>Power Quality</button>
    </nav>

    {activeSubtab !== 'harmonics' && activeSubtab !== 'energy' &&
      activeSubtab !== 'power-quality' &&
      <RecordContextBar interval={readingInterval}
      record={committedRecord} state={intervalState} section={activeSubtab}
      intervalError={intervalError}
      onIntervalChange={setReadingInterval} />}

    {activeSubtab === 'overview'
      ? <ReadingOverview interval={readingInterval} record={committedRecord} />
      : activeSubtab === 'power'
        ? committedRecord
          ? <PowerView record={committedRecord} scope={powerScope}
              onScopeChange={setPowerScope} />
          : <section className="reading-section"><div className="harmonic-empty">
            <strong>Waiting for {READING_INTERVAL_LABELS[readingInterval]} power data</strong>
            <span>Power cards, chart, and matrix commit together after all source sequences agree.</span>
          </div></section>
        : activeSubtab === 'energy'
          ? <EnergyDemandView canReset={canReset} onUnauthorized={onUnauthorized}
              enabled={acquisitionAvailable} />
        : activeSubtab === 'power-quality'
          ? <PowerQualityView onUnauthorized={onUnauthorized}
              enabled={acquisitionAvailable} />
        : activeSubtab === 'phasor'
          ? <PhasorUnbalanceView interval={readingInterval} record={committedRecord}
              nominalVoltage={Math.max(1, systemNominalVoltage)} scope={phasorScope}
              topology={measurementTopology} onScopeChange={setPhasorScope} />
          : activeSubtab === 'sequence'
            ? <SequenceView interval={readingInterval} record={committedRecord}
                topology={measurementTopology} />
            : <section className="reading-section" aria-labelledby="harmonic-spectrum-title">
      <div className="reading-section-heading harmonic-section-heading">
        <div>
          <p className="eyebrow">Metrology M16</p>
          <h2 id="harmonic-spectrum-title">Harmonic subgroup spectrum</h2>
          <p>Orders 1–127 from one atomic interval family across all seven channels.</p>
        </div>
        <div className="harmonic-controls">
          <label htmlFor="harmonic-group">Measurement</label>
          <select id="harmonic-group" value={group}
            onChange={(event) => setGroup(event.target.value as HarmonicGroup)}>
            <option value="voltage">Voltage</option>
            <option value="current">Current</option>
          </select>
          <label htmlFor="harmonic-period">Period</label>
          <select id="harmonic-period" value={period}
            onChange={(event) => {
              setSpectrum(undefined)
              setPeriod(event.target.value as Exclude<HarmonicPeriod, 'basic'>)
            }}>
            <option value="cycles_150_180">3 seconds (150/180 cycles)</option>
            <option value="minutes_10">10 minutes</option>
            <option value="hours_2">2 hours</option>
          </select>
          <span className="harmonic-control-label" id="harmonic-display-label">Display</span>
          <div className="harmonic-display-toggle" role="group" aria-labelledby="harmonic-display-label">
            <button type="button" className={display === 'magnitude' ? 'active' : ''}
              aria-pressed={display === 'magnitude'} onClick={() => setDisplay('magnitude')}>
              Magnitude
            </button>
            <button type="button" className={display === 'percentage' ? 'active' : ''}
              aria-pressed={display === 'percentage'} onClick={() => setDisplay('percentage')}>
              Percentage (% H1)
            </button>
          </div>
          <span className="harmonic-control-label" id="harmonic-chart-view-label">Chart view</span>
          <div className="harmonic-display-toggle" role="group" aria-labelledby="harmonic-chart-view-label">
            <button type="button" className={chartView === 'lanes' ? 'active' : ''}
              aria-pressed={chartView === 'lanes'} onClick={() => setChartView('lanes')}>
              Separate lanes
            </button>
            <button type="button" className={chartView === 'combined' ? 'active' : ''}
              aria-pressed={chartView === 'combined'} onClick={() => setChartView('combined')}>
              Combined
            </button>
          </div>
          <span className="harmonic-family-state">{nominalMismatch
            ? 'Nominal frequency mismatch'
            : harmonicState === 'ready' && displayedSpectrum
              ? `Family ${formatCount(displayedSpectrum.sequence)}`
              : harmonicState === 'rejected' && displayedSpectrum
                ? `Family ${formatCount(displayedSpectrum.sequence)} · latest rejected`
                : harmonicState === 'invalid' ? 'Latest family invalid'
                  : harmonicState === 'priming' ? 'Waiting for a clean family'
                    : 'Waiting for a complete family'}</span>
        </div>
      </div>

      {harmonicError && <div className="error-banner"><strong>Harmonics unavailable</strong>
        <span>{harmonicError}</span></div>}
      {nominalMismatch &&
        <div className="harmonic-mismatch-warning" role="alert">
          <strong>Nominal frequency does not match the measured grid</strong>
          <span>{harmonicMismatchMessage(nominalMismatch, canConfigure)}</span>
        </div>}
      {!nominalMismatch && harmonicState === 'rejected' &&
        <div className="harmonic-mismatch-warning interval-rejected" role="alert">
          <strong>Latest harmonic interval rejected</strong>
          <span>Showing family {formatCount(displayedSpectrum?.sequence)} as stale while waiting
            for the next clean, time-aligned {PERIOD_INTERVAL_LABELS[period]} interval.</span>
        </div>}
      {!nominalMismatch && harmonicState === 'invalid' &&
        <div className="harmonic-mismatch-warning interval-rejected" role="alert">
          <strong>Latest finalized harmonic interval is invalid</strong>
          <span>{displayedSpectrum
            ? `Showing family ${formatCount(displayedSpectrum.sequence)} as stale; the latest full interval failed measurement validation.`
            : 'The latest full interval failed measurement validation. Waiting for a valid family.'}</span>
        </div>}

      <div className="harmonic-summary" aria-label="Harmonic pipeline status">
		<HarmonicStatus ok={spectrum?.interval_valid ?? false} pending={!spectrum}>Interval valid</HarmonicStatus>
		<HarmonicStatus ok={spectrum?.time_aligned ?? false} pending={!spectrum}>Time aligned</HarmonicStatus>
		<HarmonicStatus ok={!(spectrum?.contaminated ?? true)} pending={!spectrum}>Uncontaminated</HarmonicStatus>
        <span>Chunks {formatCount(spectrum?.records)}</span>
        <span>Families {formatCount(spectrum?.families)}</span>
        <span>Incomplete {formatCount(spectrum?.incomplete_families)}</span>
        {spectrum?.available && <>
		  <span>{PERIOD_LABELS[period]}</span>
		  <span>{formatCount(spectrum.contributors)} source {spectrum.contributors === 1 ? 'family' : 'families'}</span>
		  <span>{formatCount(spectrum.sample_count)} samples</span>
		  <span>Source sequence {formatCount(spectrum.first_source_sequence)}–{formatCount(spectrum.last_source_sequence)}</span>
		  {spectrum.overshoot_samples > 0 && <span>Boundary overshoot {formatCount(spectrum.overshoot_samples)} samples</span>}
          <span>Qualified through order {spectrum.qualified_max_order}</span>
        </>}
      </div>

      {!displayedSpectrum?.available
        ? <div className={`harmonic-empty${harmonicState === 'priming' ? ' warning' : ''}`}
            role={!nominalMismatch && harmonicState === 'priming' ? 'status' : undefined}
            aria-live={!nominalMismatch && harmonicState === 'priming' ? 'polite' : undefined}>
          <strong>{nominalMismatch ? 'Harmonic windows intentionally rejected'
            : harmonicState === 'priming'
              ? `Waiting for the first clean finalized ${PERIOD_INTERVAL_LABELS[period]} interval`
              : harmonicState === 'invalid'
                ? 'No valid spectrum from the latest finalized interval'
                : 'No complete spectrum yet'}</strong>
		  <span>{nominalMismatch
            ? <>{harmonicMismatchMessage(nominalMismatch, canConfigure)} The strict interval geometry guard remains active so a 50 Hz window cannot be mislabeled as a 60 Hz spectrum.</>
            : harmonicState === 'priming'
              ? <>The closed startup family is partial, contaminated, or not time aligned and remains available to diagnostics. The spectrum appears after one complete clean UTC interval closes.</>
              : harmonicState === 'invalid'
                ? <>The interval completed without startup contamination, but its measurement validity failed. Correct the reported metrology fault and wait for the next finalized family.</>
            : <>The {PERIOD_LABELS[period]} harmonic interval has not completed yet. The adaptive L/25 conditioner supports every selectable rate from 1 to 128 kSPS.
            {readings && <> The current capture is {formatCount(readings.sample_rate_hz)} samples/s with
              {' '}{formatCount(readings.block_sample_count)}-frame basic blocks.</>}
            {' '}The previous spectrum remains hidden until grid lock is valid and all 42 records for one
			family agree. A newly started 10-minute or 2-hour selection remains unavailable until its first complete aligned interval closes.</>}</span>
        </div>
        : <>
          <HarmonicOverview columns={channels} channelByIndex={channelByIndex}
            ordersByChannel={ordersByChannel} qualifiedMaxOrder={displayedSpectrum.qualified_max_order}
            display={display} group={group} view={chartView} orderRange={orderRange}
            onOrderRangeChange={setOrderRange} />
          <div className="harmonic-table-toolbar">
            <div>
              <p className="eyebrow">Harmonic data</p>
              <h3>Orders {tableFirstOrder}–{orderRange.last}</h3>
              <p>The table follows the chart range; H1 remains in the first band as its reference.</p>
            </div>
            <div className="harmonic-table-range-control">
              <span className="harmonic-chart-control-label">32-order bands</span>
              <HarmonicRangeShortcuts range={orderRange} onChange={setOrderRange}
                includeFundamental />
            </div>
          </div>
          <div className="harmonic-table-frame">
            <table className="harmonic-matrix">
              <caption>{group === 'voltage' ? 'Voltage' : 'Current'} harmonic orders
                {' '}{tableFirstOrder} through {orderRange.last}</caption>
              <thead><tr>
                <th scope="col">Order</th>
                {channels.map((column) => <th scope="col" key={column.channel}>
                  <strong>{column.label}</strong>
                  <small>{display === 'magnitude' ? 'Magnitude' : '% of fundamental'}
                    {anglesAvailable ? ' · angle' : ''}</small>
                </th>)}
              </tr></thead>
              <tbody>
                {tableOrders.map((order) => <tr key={order}>
                  <th scope="row">{order}</th>
                  {channels.map((column) => <HarmonicCell key={column.channel}
                    channel={channelByIndex.get(column.channel)}
                    point={ordersByChannel.get(column.channel)?.get(order)}
                    fundamental={ordersByChannel.get(column.channel)?.get(1)}
                    qualified={order <= displayedSpectrum.qualified_max_order}
                    display={display} />)}
                </tr>)}
              </tbody>
            </table>
          </div>
        </>}

      <p className="harmonic-note">Magnitudes are RMS aggregation of three-bin IEC-style subgroup magnitudes.
        Percentage is derived independently for each channel as Hn / H1 × 100. Relative angles appear only
        when metrology supplies a valid angle; the browser does not infer phase for magnitude-only intervals.</p>
    </section>}
  </section>
}
