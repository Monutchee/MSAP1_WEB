import {
  FormEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect,
  useMemo, useRef, useState,
} from 'react'
import uPlot, { AlignedData, Options, Series } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { api, ApiError, HistoryCapabilities, HistoryPoint } from '../api'
import { PowerQualityEventCatalogue } from './PowerQualityEventCatalogue'
import './history.css'

function scaleValue(value: string, unit: string) {
  // The API remains exact decimal text. This Number is a disposable plotting
  // coordinate only; authoritative energy display/reset logic never uses it.
  const plotted = Number(value)
  if (unit === 'mHz') return plotted / 1000
  if (unit === 'uV' || unit === 'uA') return plotted / 1_000_000
  return plotted
}

function displayUnit(unit: string) {
  return unit === 'mHz' ? 'Hz' : unit === 'uV' ? 'V' : unit === 'uA' ? 'A' : unit
}

/**
 * Produces the wall-clock representation required by an HTML
 * `datetime-local` input. `toISOString()` must not be used here: it emits
 * UTC, while this control intentionally has no timezone and treats its text
 * as the browser's local time. The API conversion below still uses
 * `Date#getTime()`, so every request remains an epoch/UTC timestamp.
 */
function localDateTimeValue(date: Date) {
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function HistoryPlot({ points, capabilities, attributes }: {
  points: HistoryPoint[]
  capabilities: HistoryCapabilities
  attributes: string[]
}) {
  const host = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot>()
  const visibleRange = useRef<{ min: number; max: number }>()
  const [verticalScale, setVerticalScale] = useState<'auto' | 'fixed'>('auto')

  const aligned = useMemo(() => {
    /*
     * Points arrive ordered by measured_at_ns -- the backend orders them and a
     * continuation appends at the boundary -- so the distinct timestamps come
     * from one pass with no hashing and no sort. Anything that changes the merge
     * above must preserve that ordering or this collapses the x axis.
     */
    const sampled: number[] = []
    for (const point of points) {
      if (sampled.length === 0 ||
          sampled[sampled.length - 1] !== point.measured_at_nanoseconds)
        sampled.push(point.measured_at_nanoseconds)
    }
    /*
     * Downtime leaves no rows at all, so two samples on either side of an
     * outage would otherwise be joined by a line fabricating data that was
     * never measured. The historian records on a fixed cadence for the
     * selected measurement period, and the median inter-sample interval
     * recovers that cadence even when the window contains outages. The
     * boundary is unambiguous: a single missing record already doubles an
     * interval, while grid-frequency wander moves it a few percent, so
     * anything beyond 1.5x the cadence gets an explicit all-null row at the
     * gap's midpoint and spanGaps:false breaks the line there.
     */
    let gapThreshold = Infinity
    if (sampled.length >= 3) {
      const deltas = sampled.slice(1)
        .map((time, index) => time - sampled[index])
        .sort((a, b) => a - b)
      gapThreshold = deltas[Math.floor(deltas.length / 2)] * 1.5
    }
    const times: number[] = []
    for (const time of sampled) {
      const previous = times[times.length - 1]
      if (times.length > 0 && time - previous > gapThreshold)
        times.push(previous + (time - previous) / 2)
      times.push(time)
    }

    /* Lifetime counters deliberately jump to zero at an administrative
     * reset. The historian supplies the exact epoch on each M17 point; add an
     * all-null row between differing epochs so no chart line implies negative
     * energy or joins independent peak epochs. */
    const previousEpoch = new Map<string, { epoch: string; time: number }>()
    for (const point of points) {
      if (point.reset_epoch === undefined) continue
      const prior = previousEpoch.get(point.attribute)
      if (prior && prior.epoch !== point.reset_epoch &&
          prior.time < point.measured_at_nanoseconds)
        times.push(prior.time + (point.measured_at_nanoseconds - prior.time) / 2)
      previousEpoch.set(point.attribute, {
        epoch: point.reset_epoch,
        time: point.measured_at_nanoseconds,
      })
    }
    times.sort((a, b) => a - b)
    for (let index = times.length - 1; index > 0; index -= 1)
      if (times[index] === times[index - 1]) times.splice(index, 1)
    const timeIndex = new Map(times.map((time, index) => [time, index]))
    const columns: Array<Array<number | null>> = attributes.map(() =>
      Array.from({ length: times.length }, () => null))
    points.forEach((point) => {
      const attribute = attributes.indexOf(point.attribute)
      const time = timeIndex.get(point.measured_at_nanoseconds)
      if (attribute < 0 || time === undefined || point.quality !== 'valid') return
      const unit = capabilities.attributes.find((entry) => entry.id === point.attribute)?.unit ?? ''
      columns[attribute][time] = scaleValue(point.value, unit)
    })
    return [times.map((time) => time / 1_000_000_000), ...columns] as AlignedData
  }, [attributes, capabilities.attributes, points])

  const fullRange = useMemo(() => ({
    min: aligned[0][0] ?? 0,
    max: aligned[0][aligned[0].length - 1] ?? 1,
  }), [aligned])

  const fixedVerticalRange = useMemo<[number, number]>(() => {
    const values: number[] = []
    aligned.slice(1).forEach((column) => column.forEach((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
    }))
    if (values.length === 0) return [-1, 1]
    const minimum = Math.min(...values)
    const maximum = Math.max(...values)
    const padding = Math.max((maximum - minimum) * 0.05,
      Math.max(Math.abs(minimum), Math.abs(maximum)) * 0.01, 1e-9)
    return [minimum - padding, maximum + padding]
  }, [aligned])

  /*
   * The chart is no longer rebuilt when data arrives, so anything the plot's
   * own callbacks and DOM handlers read has to reach them through a ref. They
   * are registered once at creation and would otherwise capture the ranges from
   * the first page forever.
   */
  const fullRangeRef = useRef(fullRange)
  const fixedVerticalRangeRef = useRef(fixedVerticalRange)
  const alignedRef = useRef(aligned)
  useEffect(() => {
    fullRangeRef.current = fullRange
    fixedVerticalRangeRef.current = fixedVerticalRange
    alignedRef.current = aligned
  }, [aligned, fixedVerticalRange, fullRange])

  const setHorizontalRange = useCallback((minimum: number, maximum: number) => {
    const plot = plotRef.current
    if (!plot) return
    const range = fullRangeRef.current
    const completeSpan = Math.max(range.max - range.min, Number.EPSILON)
    let span = Math.min(Math.max(maximum - minimum, completeSpan / 1_000_000), completeSpan)
    if (!Number.isFinite(span)) span = completeSpan
    let min = minimum
    if (min < range.min) min = range.min
    if (min + span > range.max) min = range.max - span
    const next = { min, max: min + span }
    visibleRange.current = next
    plot.setScale('x', next)
  }, [])

  const zoom = useCallback((factor: number) => {
    const plot = plotRef.current
    if (!plot) return
    const minimum = plot.scales.x.min ?? fullRangeRef.current.min
    const maximum = plot.scales.x.max ?? fullRangeRef.current.max
    const center = (minimum + maximum) / 2
    const half = ((maximum - minimum) * factor) / 2
    setHorizontalRange(center - half, center + half)
  }, [setHorizontalRange])

  const fit = useCallback(() => {
    setHorizontalRange(fullRangeRef.current.min, fullRangeRef.current.max)
  }, [setHorizontalRange])

  useEffect(() => {
    if (!host.current || aligned[0].length === 0) return
    const colors = ['#59e3b0', '#ffbd5c', '#7ca8ff', '#ef74ab', '#48c7ad', '#a78bfa', '#ff7a70', '#f1dc63']
    const series: Series[] = [{ label: 'Time' }, ...attributes.map((attribute, index) => {
      const capability = capabilities.attributes.find((entry) => entry.id === attribute)
      return { label: `${attribute} (${displayUnit(capability?.unit ?? '')})`, stroke: colors[index % colors.length], width: 1.5, spanGaps: false }
    })]
    const scales: Options['scales'] = { x: { time: true } }
    if (verticalScale === 'fixed')
      scales.y = { auto: false, range: () => fixedVerticalRangeRef.current }
    const options: Options = {
      width: Math.max(640, host.current.clientWidth), height: 520,
      title: 'Historical meter data', series,
      scales,
      axes: [{ stroke: '#789098', grid: { stroke: '#20363d' } },
        { stroke: '#789098', grid: { stroke: '#20363d' } }],
      // uPlot's default drag-to-scale interaction draws a zoom selection.
      // History uses direct manipulation instead: drag pans time and wheel or
      // the explicit buttons zooms around the pointer/viewport centre.
      cursor: { drag: { x: false, y: false, setScale: false } },
      hooks: { ready: [(plot) => {
        plotRef.current = plot
        if (visibleRange.current)
          plot.setScale('x', visibleRange.current)

        const wheel = (event: WheelEvent) => {
          event.preventDefault()
          const bounds = plot.over.getBoundingClientRect()
          const left = plot.posToVal(event.clientX - bounds.left, 'x')
          const min = plot.scales.x.min ?? fullRangeRef.current.min
          const max = plot.scales.x.max ?? fullRangeRef.current.max
          const factor = event.deltaY < 0 ? 0.8 : 1.25
          setHorizontalRange(
            left - (left - min) * factor,
            left + (max - left) * factor,
          )
        }
        let dragging: { clientX: number; min: number; max: number } | undefined
        const pointerDown = (event: PointerEvent) => {
          if (event.button !== 0) return
          dragging = {
            clientX: event.clientX,
            min: plot.scales.x.min ?? fullRangeRef.current.min,
            max: plot.scales.x.max ?? fullRangeRef.current.max,
          }
          plot.over.setPointerCapture(event.pointerId)
          plot.over.classList.add('panning')
        }
        const pointerMove = (event: PointerEvent) => {
          if (!dragging) return
          event.preventDefault()
          const width = Math.max(plot.over.clientWidth, 1)
          const offset = -((event.clientX - dragging.clientX) / width) *
            (dragging.max - dragging.min)
          setHorizontalRange(dragging.min + offset, dragging.max + offset)
        }
        const pointerUp = (event: PointerEvent) => {
          if (!dragging) return
          dragging = undefined
          if (plot.over.hasPointerCapture(event.pointerId))
            plot.over.releasePointerCapture(event.pointerId)
          plot.over.classList.remove('panning')
        }
        plot.over.addEventListener('wheel', wheel, { passive: false })
        plot.over.addEventListener('pointerdown', pointerDown)
        plot.over.addEventListener('pointermove', pointerMove)
        plot.over.addEventListener('pointerup', pointerUp)
        plot.over.addEventListener('pointercancel', pointerUp)
      }] },
    }
    const plot = new uPlot(options, alignedRef.current, host.current)
    const observer = new ResizeObserver(() => plot.setSize({
      width: Math.max(640, host.current?.clientWidth ?? 640), height: 520,
    }))
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      if (plotRef.current === plot) plotRef.current = undefined
      plot.destroy()
    }
    /*
     * Structural dependencies only. `aligned` is deliberately absent: it changed
     * on every appended page, and each change destroyed the chart and ran
     * `new uPlot` again -- a full teardown and rebuild per page, on top of
     * rebuilding every column. Data now arrives through setData() below.
     */
  }, [attributes, capabilities.attributes, setHorizontalRange, verticalScale])

  /* Feed new data into the existing chart. */
  useEffect(() => {
    const plot = plotRef.current
    if (!plot || aligned[0].length === 0) return
    plot.setData(aligned)
    /* setData rescales x to the whole extent, so an appended page would yank
     * the operator out of wherever they had panned to. Restore it. */
    if (visibleRange.current)
      plot.setScale('x', visibleRange.current)
  }, [aligned])

  return <section className="history-chart">
    <div className="history-plot-controls" aria-label="History plot controls">
      <div><span>Time</span>
        <button type="button" title="Zoom in" onClick={() => zoom(0.5)}>+</button>
        <button type="button" title="Zoom out" onClick={() => zoom(2)}>−</button>
        <button type="button" onClick={fit}>Fit</button></div>
      <div><span>Vertical scale</span>
        <button type="button" className={verticalScale === 'auto' ? 'active' : ''}
          aria-pressed={verticalScale === 'auto'} onClick={() => setVerticalScale('auto')}>Auto</button>
        <button type="button" className={verticalScale === 'fixed' ? 'active' : ''}
          aria-pressed={verticalScale === 'fixed'} onClick={() => setVerticalScale('fixed')}>Fixed</button></div>
      <small>Drag to pan · wheel to zoom</small>
    </div>
    <div className="history-plot" ref={host} />
  </section>
}

function MeasurementHistory({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [capabilities, setCapabilities] = useState<HistoryCapabilities>()
  const [period, setPeriod] = useState('basic')
  const [attributes, setAttributes] = useState<string[]>(['voltage.ln.a.rms'])
  // The picker is a user-facing local-time control. Its values are converted
  // back to UTC epoch nanoseconds only at the API boundary in fetchPage().
  const [start, setStart] = useState(() =>
    localDateTimeValue(new Date(Date.now() - 60 * 60 * 1000)))
  const [end, setEnd] = useState(() =>
    localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)))
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.historyCapabilities().then(setCapabilities).catch((reason) => {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized()
      else setError(reason instanceof Error ? reason.message : 'Unable to read historian capabilities')
    })
  }, [onUnauthorized])

  async function fetchPage(append: boolean) {
    if (!capabilities || attributes.length === 0) return
    setBusy(true); setError('')
    try {
      const requestedStart = new Date(start).getTime() * 1_000_000
      // Repeat the last timestamp on continuation.  The merge below removes
      // duplicates and prevents losing attributes if a bounded page ended in
      // the middle of one measurement block.
      const pageStart = append && points.length > 0
        ? Math.max(...points.map((point) => point.measured_at_nanoseconds))
        : requestedStart
      const result = await api.historyQuery({
        period, attributes,
        start_nanoseconds: pageStart,
        end_nanoseconds: new Date(end).getTime() * 1_000_000,
        limit: Math.min(10000, capabilities.maximum_points),
      })
      if (append) {
        setPoints((current) => {
          if (current.length === 0) return result.points
          /*
           * A continuation restarts at the newest timestamp already held, so
           * that single timestamp is the only one that can appear in both
           * pages. Deduplicating just that boundary replaces the previous
           * approach of rebuilding a keyed Map over every accumulated point
           * and re-sorting the whole set on each page: that cost grew with the
           * total, so the work to load N pages grew quadratically and the tab
           * stalled long before a large range finished.
           *
           * The backend orders by measured_at_ns, and the continuation starts
           * at the boundary, so appending keeps the series ordered.
           */
          const boundary =
            current[current.length - 1].measured_at_nanoseconds
          const held = new Set<string>()
          for (let index = current.length - 1; index >= 0; index -= 1) {
            const point = current[index]
            if (point.measured_at_nanoseconds !== boundary) break
            held.add(`${point.source_sequence}:${point.attribute}`)
          }
          /* Keeps the attributes of a block the previous page cut in half,
           * which is why the overlap exists in the first place. */
          const fresh = result.points.filter((point) =>
            point.measured_at_nanoseconds !== boundary ||
            !held.has(`${point.source_sequence}:${point.attribute}`))
          return fresh.length === 0 ? current : current.concat(fresh)
        })
      } else {
        setPoints(result.points)
      }
      setTruncated(result.truncated)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized()
      else setError(reason instanceof Error ? reason.message : 'History query failed')
    } finally { setBusy(false) }
  }

  function query(event: FormEvent) {
    event.preventDefault()
    void fetchPage(false)
  }

  function toggle(attribute: string) {
    setAttributes((current) => current.includes(attribute)
      ? current.filter((item) => item !== attribute)
      : [...current, attribute])
  }

  return <>
    {error && <div className="error-banner"><strong>History unavailable</strong><span>{error}</span></div>}
    {capabilities && <form className="history-query" onSubmit={query}>
      <label>Measurement period<select value={period} onChange={(event) => setPeriod(event.target.value)}>
        {capabilities.periods.map((value) => <option value={value} key={value}>{value.replaceAll('_', ' ')}</option>)}
      </select></label>
      <label>Start<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>End<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <fieldset><legend>Attributes</legend>{capabilities.attributes.map((attribute) =>
        <label key={attribute.id}><input type="checkbox" checked={attributes.includes(attribute.id)}
          onChange={() => toggle(attribute.id)} />{attribute.id} ({displayUnit(attribute.unit)})</label>)}</fieldset>
      <button type="submit" disabled={busy || attributes.length === 0}>{busy ? 'Loading…' : 'Query history'}</button>
    </form>}
    {truncated && <div className="history-pagination">
      <p className="history-warning">The query reached its bounded page size. Load the next ordered page or select a shorter range.</p>
      <button type="button" disabled={busy} onClick={() => { void fetchPage(true) }}>
        {busy ? 'Loading…' : 'Load next page'}
      </button>
    </div>}
    {capabilities && points.length > 0
      ? <HistoryPlot points={points} capabilities={capabilities} attributes={attributes} />
      : <div className="history-empty">Select a time range and attributes, then query the historian.</div>}
  </>
}

const HISTORY_SECTIONS = ['measurements', 'events'] as const
type HistorySection = typeof HISTORY_SECTIONS[number]

export function HistoryPage({ onUnauthorized, onViewWaveform }: {
  onUnauthorized: () => void
  onViewWaveform: (filename: string) => void
}) {
  const [section, setSection] = useState<HistorySection>('measurements')

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
        event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const current = HISTORY_SECTIONS.indexOf(section)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? HISTORY_SECTIONS.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + HISTORY_SECTIONS.length) %
          HISTORY_SECTIONS.length
    setSection(HISTORY_SECTIONS[next])
    document.getElementById(`history-tab-${HISTORY_SECTIONS[next]}`)?.focus()
  }

  return <section className="history-page">
    <div className="developer-heading"><div><p className="eyebrow">Historian</p>
      <h1>History</h1><p>Query retained meter products or inspect durable power-quality events.</p></div></div>
    <nav className="history-section-tabs" role="tablist" aria-orientation="horizontal"
      aria-label="History sections">
      <button id="history-tab-measurements" role="tab" type="button"
        className={section === 'measurements' ? 'active' : ''}
        aria-selected={section === 'measurements'} aria-controls="history-panel-measurements"
        tabIndex={section === 'measurements' ? 0 : -1}
        onKeyDown={handleTabKeyDown} onClick={() => setSection('measurements')}>
        <span>Meter data</span><small>Measurement-period records</small>
      </button>
      <button id="history-tab-events" role="tab" type="button"
        className={section === 'events' ? 'active' : ''}
        aria-selected={section === 'events'} aria-controls="history-panel-events"
        tabIndex={section === 'events' ? 0 : -1}
        onKeyDown={handleTabKeyDown} onClick={() => setSection('events')}>
        <span>PQ Event catalogue</span><small>Events and linked evidence</small>
      </button>
    </nav>
    {section === 'measurements' && <div id="history-panel-measurements" role="tabpanel"
      aria-labelledby="history-tab-measurements">
      <MeasurementHistory onUnauthorized={onUnauthorized} />
    </div>}
    {section === 'events' && <div id="history-panel-events" role="tabpanel"
      aria-labelledby="history-tab-events">
      <PowerQualityEventCatalogue onUnauthorized={onUnauthorized}
        onViewWaveform={onViewWaveform} />
    </div>}
  </section>
}
