import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot, { AlignedData, Options, Series } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { api, ApiError, HistoryCapabilities, HistoryPoint } from '../api'
import './history.css'

function scaleValue(value: number, unit: string) {
  if (unit === 'mHz') return value / 1000
  if (unit === 'uV' || unit === 'uA') return value / 1_000_000
  return value
}

function displayUnit(unit: string) {
  return unit === 'mHz' ? 'Hz' : unit === 'uV' ? 'V' : unit === 'uA' ? 'A' : unit
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
    const times = [...new Set(points.map((point) => point.measured_at_nanoseconds))]
      .sort((a, b) => a - b)
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

  const setHorizontalRange = useCallback((minimum: number, maximum: number) => {
    const plot = plotRef.current
    if (!plot) return
    const completeSpan = Math.max(fullRange.max - fullRange.min, Number.EPSILON)
    let span = Math.min(Math.max(maximum - minimum, completeSpan / 1_000_000), completeSpan)
    if (!Number.isFinite(span)) span = completeSpan
    let min = minimum
    if (min < fullRange.min) min = fullRange.min
    if (min + span > fullRange.max) min = fullRange.max - span
    const next = { min, max: min + span }
    visibleRange.current = next
    plot.setScale('x', next)
  }, [fullRange])

  const zoom = useCallback((factor: number) => {
    const plot = plotRef.current
    if (!plot) return
    const minimum = plot.scales.x.min ?? fullRange.min
    const maximum = plot.scales.x.max ?? fullRange.max
    const center = (minimum + maximum) / 2
    const half = ((maximum - minimum) * factor) / 2
    setHorizontalRange(center - half, center + half)
  }, [fullRange, setHorizontalRange])

  const fit = useCallback(() => {
    setHorizontalRange(fullRange.min, fullRange.max)
  }, [fullRange, setHorizontalRange])

  useEffect(() => {
    if (!host.current || aligned[0].length === 0) return
    const colors = ['#59e3b0', '#ffbd5c', '#7ca8ff', '#ef74ab', '#48c7ad', '#a78bfa', '#ff7a70', '#f1dc63']
    const series: Series[] = [{ label: 'Time' }, ...attributes.map((attribute, index) => {
      const capability = capabilities.attributes.find((entry) => entry.id === attribute)
      return { label: `${attribute} (${displayUnit(capability?.unit ?? '')})`, stroke: colors[index % colors.length], width: 1.5, spanGaps: false }
    })]
    const scales: Options['scales'] = { x: { time: true } }
    if (verticalScale === 'fixed')
      scales.y = { auto: false, range: () => fixedVerticalRange }
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
          const min = plot.scales.x.min ?? aligned[0][0]
          const max = plot.scales.x.max ?? aligned[0][aligned[0].length - 1]
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
            min: plot.scales.x.min ?? fullRange.min,
            max: plot.scales.x.max ?? fullRange.max,
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
    const plot = new uPlot(options, aligned, host.current)
    const observer = new ResizeObserver(() => plot.setSize({
      width: Math.max(640, host.current?.clientWidth ?? 640), height: 520,
    }))
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      if (plotRef.current === plot) plotRef.current = undefined
      plot.destroy()
    }
  }, [aligned, attributes, capabilities.attributes, fixedVerticalRange,
    fullRange, setHorizontalRange, verticalScale])

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

export function HistoryPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [capabilities, setCapabilities] = useState<HistoryCapabilities>()
  const [period, setPeriod] = useState('basic')
  const [attributes, setAttributes] = useState<string[]>(['voltage.ln.a.rms'])
  const [start, setStart] = useState(() => new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 16))
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 16))
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
          const merged = new Map(current.map((point) => [
            `${point.measured_at_nanoseconds}:${point.source_sequence}:${point.attribute}`,
            point,
          ]))
          result.points.forEach((point) => merged.set(
            `${point.measured_at_nanoseconds}:${point.source_sequence}:${point.attribute}`,
            point))
          return [...merged.values()].sort((left, right) =>
            left.measured_at_nanoseconds - right.measured_at_nanoseconds)
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

  return <section className="history-page">
    <div className="developer-heading"><div><p className="eyebrow">Historian</p>
      <h1>Historical meter data</h1><p>Query PL-calculated values retained by measurement period.</p></div></div>
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
  </section>
}
