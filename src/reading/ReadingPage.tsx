import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api, ApiError, HarmonicChannel, HarmonicOrder, HarmonicPeriod,
  HarmonicSpectrum,
  MeterReadings,
} from '../api'
import './reading.css'

type HarmonicGroup = 'voltage' | 'current'
type HarmonicDisplay = 'magnitude' | 'percentage'

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
const SUMMARY_HARMONIC_ORDERS = ALL_HARMONIC_ORDERS.slice(1)
const SUMMARY_AXIS_ORDERS = [2, 25, 50, 75, 100, 127]
const SUMMARY_WIDTH = 1000
const SUMMARY_BASELINE = 60
const SUMMARY_HEIGHT = 52

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

function HarmonicStatus({ ok, pending = false, children }: {
  ok: boolean
  pending?: boolean
  children: string
}) {
  const state = pending ? 'neutral' : ok ? 'ok' : 'bad'
  return <span className={`status-pill ${state}`}><i />{children}</span>
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

function HarmonicOverview({ columns, channelByIndex, ordersByChannel, qualifiedMaxOrder, display }: {
  columns: ChannelColumn[]
  channelByIndex: Map<number, HarmonicChannel>
  ordersByChannel: Map<number, Map<number, HarmonicOrder>>
  qualifiedMaxOrder: number
  display: HarmonicDisplay
}) {
  const series = columns.map((column) => {
    const channel = channelByIndex.get(column.channel)
    const orders = ordersByChannel.get(column.channel)
    const fundamental = orders?.get(1)
    const values = SUMMARY_HARMONIC_ORDERS.map((order) => ({
      order,
      value: order <= qualifiedMaxOrder
        ? displayedValue(orders?.get(order), fundamental, display)
        : undefined,
    }))
    return { column, channel, fundamental, values }
  })
  const validValues = series.flatMap((item) => item.values.flatMap(({ value }) =>
    value === undefined ? [] : [value]))
  const peak = Math.max(0, ...validValues)
  const unit = series.find((item) => item.channel?.unit)?.channel?.unit ?? ''

  return <section className="harmonic-overview" aria-labelledby="harmonic-overview-title">
    <div className="harmonic-overview-heading">
      <div>
        <p className="eyebrow">Spectrum overview</p>
        <h3 id="harmonic-overview-title">Orders 2–127 at a glance</h3>
        <p>Each lane is one selected channel. All lanes share the same vertical scale.</p>
      </div>
      <div className="harmonic-overview-peak">
        <span>Largest displayed harmonic</span>
        <strong>{peak > 0 ? formatDisplayedValue(peak, unit, display) : '—'}</strong>
      </div>
    </div>

    <div className="harmonic-skyline-list">
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
            aria-label={`${column.label} harmonic orders 2 through 127`}>
            {[8, 34, SUMMARY_BASELINE].map((y) => <line className="harmonic-skyline-grid"
              x1="0" x2={SUMMARY_WIDTH} y1={y} y2={y} key={y} />)}
            {values.map(({ order, value }) => {
              if (value === undefined || value <= 0 || peak <= 0) return null
              const x = ((order - 2) / 125) * SUMMARY_WIDTH
              const height = Math.max(1.5, (value / peak) * SUMMARY_HEIGHT)
              return <line className={`harmonic-skyline-stem channel-${channelIndex}`}
                x1={x} x2={x} y1={SUMMARY_BASELINE} y2={SUMMARY_BASELINE - height}
                vectorEffect="non-scaling-stroke" key={order}>
                <title>{`${column.label} H${order}: ${formatDisplayedValue(value, channel?.unit ?? '', display)}`}</title>
              </line>
            })}
          </svg>
        </article>
      })}
      <div className="harmonic-skyline-axis" aria-hidden="true">
        {SUMMARY_AXIS_ORDERS.map((order) => <span key={order}>H{order}</span>)}
      </div>
      {peak === 0 && <p className="harmonic-overview-empty">No valid harmonics above H1 are available.</p>}
    </div>
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
            display={display} />
          <div className="harmonic-table-frame">
            <table className="harmonic-matrix">
              <caption>{group === 'voltage' ? 'Voltage' : 'Current'} harmonic orders 1 through 127</caption>
              <thead><tr>
                <th scope="col">Order</th>
                {channels.map((column) => <th scope="col" key={column.channel}>
                  <strong>{column.label}</strong>
                  <small>{display === 'magnitude' ? 'Magnitude' : '% of fundamental'}
                    {anglesAvailable ? ' · angle' : ''}</small>
                </th>)}
              </tr></thead>
              <tbody>
                {ALL_HARMONIC_ORDERS.map((order) => <tr key={order}>
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
