import {
  type PointerEvent as ReactPointerEvent,
  useCallback, useEffect, useMemo, useState,
} from 'react'
import {
  api, ApiError, HarmonicChannel, HarmonicOrder, HarmonicPeriod,
  HarmonicSpectrum,
  MeterReadings,
} from '../api'
import './reading.css'

type HarmonicGroup = 'voltage' | 'current'
type HarmonicDisplay = 'magnitude' | 'percentage'
type HarmonicChartView = 'lanes' | 'combined'

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
    : `${detail.angle.toFixed(3)} deg`
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

/**
 * Viewer-facing metrology results. Harmonic families are atomic: a previous
 * family is never mixed with a partial replacement while the API assembles
 * its seven channels and six chunks per channel.
 */
export function ReadingPage({ readings, onUnauthorized }: {
  readings: MeterReadings | undefined
  onUnauthorized: () => void
}) {
  const [group, setGroup] = useState<HarmonicGroup>('voltage')
  const [period, setPeriod] = useState<Exclude<HarmonicPeriod, 'basic'>>('cycles_150_180')
  const [display, setDisplay] = useState<HarmonicDisplay>('magnitude')
  const [chartView, setChartView] = useState<HarmonicChartView>('lanes')
  const [orderRange, setOrderRange] = useState<HarmonicOrderRange>(FULL_SUMMARY_RANGE)
  const [spectrum, setSpectrum] = useState<HarmonicSpectrum>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setSpectrum(await api.meterHarmonics(period))
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read harmonics')
    }
  }, [onUnauthorized, period])

  useEffect(() => {
    let active = true
    let pending = false
    const refresh = async () => {
      if (!active || pending) return
      pending = true
      await load()
      pending = false
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [load])

  const channels = CHANNEL_GROUPS[group]
  const channelByIndex = useMemo(() => new Map(
    spectrum?.channels.map((channel) => [channel.channel, channel]) ?? [],
  ), [spectrum])
  const ordersByChannel = useMemo(() => new Map(
    spectrum?.channels.map((channel) => [
      channel.channel,
      new Map(channel.orders.map((order) => [order.order, order])),
    ]) ?? [],
  ), [spectrum])
  const anglesAvailable = spectrum?.available === true && channels.some((column) =>
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
      <button className="active" type="button" aria-current="page">Harmonics</button>
    </nav>

    <section className="reading-section" aria-labelledby="harmonic-spectrum-title">
      <div className="reading-section-heading">
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
          <span className="harmonic-family-state">{spectrum?.available
            ? `Family ${formatCount(spectrum.sequence)}`
            : 'Waiting for a complete family'}</span>
        </div>
      </div>

      {error && <div className="error-banner"><strong>Harmonics unavailable</strong>
        <span>{error}</span></div>}

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

      {!spectrum?.available
        ? <div className="harmonic-empty">
          <strong>No complete spectrum yet</strong>
		  <span>The {PERIOD_LABELS[period]} harmonic interval has not completed yet. The adaptive L/25 conditioner supports every selectable rate from 1 to 128 kSPS.
            {readings && <> The current capture is {formatCount(readings.sample_rate_hz)} samples/s with
              {' '}{formatCount(readings.block_sample_count)}-frame basic blocks.</>}
            {' '}The previous spectrum remains hidden until grid lock is valid and all 42 records for one
			family agree. A newly started 10-minute or 2-hour selection remains unavailable until its first complete aligned interval closes.</span>
        </div>
        : <>
          <HarmonicOverview columns={channels} channelByIndex={channelByIndex}
            ordersByChannel={ordersByChannel} qualifiedMaxOrder={spectrum.qualified_max_order}
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
                    qualified={order <= spectrum.qualified_max_order}
                    display={display} />)}
                </tr>)}
              </tbody>
            </table>
          </div>
        </>}

      <p className="harmonic-note">Magnitudes are RMS aggregation of three-bin IEC-style subgroup magnitudes.
        Percentage is derived independently for each channel as Hn / H1 × 100. Relative angles appear only
        when metrology supplies a valid angle; the browser does not infer phase for magnitude-only intervals.</p>
    </section>
  </section>
}
