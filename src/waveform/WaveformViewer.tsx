import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  convertedSample, ParsedWaveform, WaveformEnvelopeData, WaveformPyramid,
  WaveformRange, pyramidEnvelopeData, pyramidRange, rawSample,
  waveformDurationSeconds, waveformEnvelopeScale, waveformFrameForSequence,
  waveformFrameTimeSeconds,
} from './waveformFile'

const PLOT_WIDTH = 1200
const PLOT_HEIGHT = 88
const MIN_VISIBLE_FRAMES = 16
const CHANNEL_COLORS = [
  '#5fa8ff', '#ff8d4d', '#54d4af', '#ffbd5c',
  '#e06da9', '#64d467', '#9c8cff',
] as const

interface FrameWindow {
  first: number
  last: number
}

interface PanGesture {
  pointerId: number
  startClientX: number
  width: number
  viewport: FrameWindow
}

type VerticalScale = 'auto' | 'fixed'
export type WaveformPlotLayout = 'separate' | 'electrical' | 'overlay'

interface PlotGroup {
  id: string
  label: string
  indices: number[]
}

interface PlotEnvelope {
  index: number
  channel: ParsedWaveform['channels'][number]
  envelope: WaveformEnvelopeData
  scale: WaveformRange
}

const WaveformCanvas = memo(function WaveformCanvas({
  traces, sharedScale, overlay,
}: {
  traces: readonly PlotEnvelope[]
  sharedScale: boolean
  overlay: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const context = canvasRef.current?.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, PLOT_WIDTH, PLOT_HEIGHT)

    const firstScale = traces[0]?.scale
    if (sharedScale && firstScale && firstScale.minimum <= 0 &&
        firstScale.maximum >= 0) {
      const y = PLOT_HEIGHT - (0 - firstScale.minimum) /
        (firstScale.maximum - firstScale.minimum) * PLOT_HEIGHT
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(PLOT_WIDTH, y)
      context.globalAlpha = 1
      context.strokeStyle = '#24363d'
      context.lineWidth = 1
      context.stroke()
    }

    context.globalAlpha = overlay ? .42 : .72
    context.lineWidth = 1
    for (const { index, envelope, scale } of traces) {
      const buckets = envelope.minima.length
      if (buckets === 0) continue
      const span = scale.maximum - scale.minimum
      const x = (bucket: number) => buckets === 1
        ? 0 : bucket / (buckets - 1) * PLOT_WIDTH
      const y = (value: number) => PLOT_HEIGHT -
        (value - scale.minimum) / span * PLOT_HEIGHT
      context.beginPath()
      context.moveTo(x(0), y(envelope.maxima[0]))
      for (let bucket = 1; bucket < buckets; ++bucket)
        context.lineTo(x(bucket), y(envelope.maxima[bucket]))
      for (let bucket = buckets - 1; bucket >= 0; --bucket)
        context.lineTo(x(bucket), y(envelope.minima[bucket]))
      context.closePath()
      const color = CHANNEL_COLORS[index % CHANNEL_COLORS.length]
      context.fillStyle = color
      context.strokeStyle = color
      context.fill()
      context.stroke()
    }
    context.globalAlpha = 1
  }, [overlay, sharedScale, traces])

  return <canvas className="waveform-envelope-canvas" ref={canvasRef}
    width={PLOT_WIDTH} height={PLOT_HEIGHT} aria-hidden="true" />
})

export function waveformPlotGroups(
  channels: readonly { kind: 'current' | 'voltage' | 'debug' }[],
  enabled: ReadonlySet<number>,
  layout: WaveformPlotLayout,
): PlotGroup[] {
  const indices = channels.map((_, index) => index).filter((index) => enabled.has(index))
  if (layout === 'separate') return indices.map((index) => ({
    id: `channel-${index}`, label: `Channel ${index}`, indices: [index],
  }))
  if (layout === 'overlay') return indices.length === 0 ? [] : [{
    id: 'all-channels', label: 'All channels', indices,
  }]
  const labels = { current: 'Current channels', voltage: 'Voltage channels', debug: 'Other channels' }
  return (['current', 'voltage', 'debug'] as const).map((kind) => ({
    id: kind,
    label: labels[kind],
    indices: indices.filter((index) => channels[index].kind === kind),
  })).filter((group) => group.indices.length > 0)
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function formatEngineering(value: number) {
  const absolute = Math.abs(value)
  if (absolute >= 1000) return value.toFixed(1)
  if (absolute >= 10) return value.toFixed(3)
  return value.toFixed(6)
}

function captureTime(waveform: ParsedWaveform) {
  if (waveform.triggerRealtimeNanoseconds === 0n) return 'Legacy capture'
  return new Date(Number(waveform.triggerRealtimeNanoseconds / 1_000_000n))
    .toLocaleString()
}

export function WaveformViewer({ filename, waveform, pyramid, onClose }: {
  filename: string
  waveform: ParsedWaveform
  pyramid: WaveformPyramid
  onClose: () => void
}) {
  const conversionAvailable = waveform.channels.some((channel) => channel.conversionValid)
  const [displayMode, setDisplayMode] = useState<'raw' | 'converted'>(
    conversionAvailable ? 'converted' : 'raw',
  )
  const [enabled, setEnabled] = useState(
    () => new Set(waveform.channels.map((_, index) => index)),
  )
  const [viewport, setViewport] = useState<FrameWindow>(
    () => ({ first: 0, last: waveform.frameCount }),
  )
  const [verticalScale, setVerticalScale] = useState<VerticalScale>('auto')
  const [plotLayout, setPlotLayout] = useState<WaveformPlotLayout>('separate')
  const [cursorFrame, setCursorFrame] = useState<number>()
  const [dragging, setDragging] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const plotsRef = useRef<HTMLDivElement>(null)
  const panGesture = useRef<PanGesture>()
  const viewportRef = useRef(viewport)
  /*
   * Pointer events can arrive far faster than the display refreshes (gaming
   * mice report at 500-1000 Hz). Panning and cursor moves stage their state
   * here and commit once per animation frame, so React renders at most once
   * per displayed frame however fast the pointer streams.
   */
  const pendingViewport = useRef<FrameWindow>()
  const pendingCursor = useRef<number>()
  const flushHandle = useRef<number>()
  const flushView = useCallback(() => {
    flushHandle.current = undefined
    if (pendingViewport.current !== undefined) {
      const next = pendingViewport.current
      pendingViewport.current = undefined
      viewportRef.current = next
      setViewport(next)
    }
    if (pendingCursor.current !== undefined) {
      setCursorFrame(pendingCursor.current)
      pendingCursor.current = undefined
    }
  }, [])
  const scheduleFlush = useCallback(() => {
    flushHandle.current ??= requestAnimationFrame(flushView)
  }, [flushView])
  useEffect(() => () => {
    if (flushHandle.current !== undefined)
      cancelAnimationFrame(flushHandle.current)
  }, [])

  useEffect(() => {
    const wholeCapture = { first: 0, last: waveform.frameCount }
    pendingViewport.current = undefined
    viewportRef.current = wholeCapture
    setViewport(wholeCapture)
    setEnabled(new Set(waveform.channels.map((_, index) => index)))
    setVerticalScale('auto')
    setPlotLayout('separate')
    setCursorFrame(undefined)
    panGesture.current = undefined
    setDragging(false)
  }, [waveform])

  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const plots = plotsRef.current
    if (!plots) return
    /*
     * React delegates wheel events through a passive listener in some browser
     * configurations. A native non-passive listener is required to guarantee
     * that a zoom gesture over the plots cannot scroll the containing page.
     */
    const captureWheel = (event: WheelEvent) => event.preventDefault()
    plots.addEventListener('wheel', captureWheel, { passive: false })
    return () => plots.removeEventListener('wheel', captureWheel)
  }, [])

  const converted = displayMode === 'converted'
  const wholeCaptureRanges = useMemo(() => waveform.channels.map((_, index) =>
    pyramidRange(waveform, pyramid, index, converted),
  ), [waveform, pyramid, converted])
  const visibleEnvelopes = useMemo(() => waveform.channels.map((_, index) =>
    enabled.has(index) ? pyramidEnvelopeData(
      waveform, pyramid, index, converted, PLOT_WIDTH,
      viewport.first, viewport.last,
    ) : undefined,
  ), [waveform, pyramid, converted, enabled, viewport])
  const plotGroups = useMemo(() => waveformPlotGroups(
    waveform.channels, enabled, plotLayout,
  ), [waveform.channels, enabled, plotLayout])
  const plots = useMemo(() => plotGroups.map((group) => {
    /* Voltage/current overlays share a scale within their electrical unit.
     * "All channels" keeps an independent scale per channel because amperes
     * and volts are not numerically comparable; otherwise current would be a
     * nearly flat line beside nominal voltage. */
    const sharedRange = plotLayout === 'electrical' ? {
      minimum: Math.min(...group.indices.map((index) => verticalScale === 'fixed'
        ? wholeCaptureRanges[index].minimum
        : visibleEnvelopes[index]!.minimum)),
      maximum: Math.max(...group.indices.map((index) => verticalScale === 'fixed'
        ? wholeCaptureRanges[index].maximum
        : visibleEnvelopes[index]!.maximum)),
    } : undefined
    return {
      ...group,
      sharedScale: plotLayout !== 'overlay' || group.indices.length === 1,
      envelopes: group.indices.map((index): PlotEnvelope => {
        const envelope = visibleEnvelopes[index]!
        return {
          index,
          channel: waveform.channels[index],
          envelope,
          scale: waveformEnvelopeScale(envelope,
            sharedRange ?? (verticalScale === 'fixed'
              ? wholeCaptureRanges[index] : undefined)),
        }
      }),
    }
  }), [converted, pyramid, plotGroups, plotLayout, verticalScale, viewport,
    visibleEnvelopes, waveform, wholeCaptureRanges])
  const durationSeconds = waveformDurationSeconds(waveform)
  const triggerIndex = waveformFrameForSequence(
    waveform, waveform.triggerSequence)
  const triggerInCapture = triggerIndex !== undefined
  const triggerFrame = triggerIndex ?? 0
  const visibleFrames = viewport.last - viewport.first
  const triggerInViewport = triggerInCapture &&
    triggerFrame >= viewport.first && triggerFrame < viewport.last
  const triggerPercent = visibleFrames > 1
    ? clamp((triggerFrame - viewport.first) / (visibleFrames - 1) * 100, 0, 100)
    : 0
  const zoomLevel = waveform.frameCount / visibleFrames
  const cursorPercent = cursorFrame === undefined || visibleFrames <= 1
    ? undefined
    : clamp((cursorFrame - viewport.first) / (visibleFrames - 1) * 100, 0, 100)

  function normalizedWindow(first: number, frames: number): FrameWindow {
    const boundedFrames = clamp(
      Math.round(frames),
      Math.min(MIN_VISIBLE_FRAMES, waveform.frameCount),
      waveform.frameCount,
    )
    const boundedFirst = clamp(
      Math.round(first), 0, waveform.frameCount - boundedFrames,
    )
    return { first: boundedFirst, last: boundedFirst + boundedFrames }
  }

  function zoomAt(factor: number, anchorRatio = .5) {
    const current = pendingViewport.current ?? viewportRef.current
    const frames = current.last - current.first
    const boundedAnchor = clamp(anchorRatio, 0, 1)
    const anchor = current.first + boundedAnchor * frames
    const nextFrames = clamp(
      Math.round(frames * factor),
      Math.min(MIN_VISIBLE_FRAMES, waveform.frameCount),
      waveform.frameCount,
    )
    pendingViewport.current = normalizedWindow(
      anchor - boundedAnchor * nextFrames, nextFrames,
    )
    scheduleFlush()
  }

  function commitViewport(next: FrameWindow) {
    pendingViewport.current = undefined
    viewportRef.current = next
    setViewport(next)
  }

  function fitCapture() {
    commitViewport({ first: 0, last: waveform.frameCount })
  }

  function centerOnTrigger() {
    if (triggerIndex === undefined) return
    const detailFrames = waveform.effectiveSampleRateHz
      ? Math.max(MIN_VISIBLE_FRAMES,
          Math.round(waveform.effectiveSampleRateHz / 4))
      : Math.max(MIN_VISIBLE_FRAMES, Math.round(waveform.frameCount / 10))
    const frames = Math.min(waveform.frameCount, detailFrames)
    commitViewport(normalizedWindow(triggerIndex - frames / 2, frames))
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.deltaY === 0) return
    event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    const anchor = bounds.width
      ? clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      : .5
    const unit = event.deltaMode === 1 ? 16 :
      event.deltaMode === 2 ? bounds.height : 1
    const delta = clamp(event.deltaY * unit, -240, 240)
    zoomAt(Math.exp(delta * .003), anchor)
  }

  function updateCursor(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = bounds.width
      ? clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      : 0
    /* Against the staged viewport when a pan is in flight this frame. */
    const window = pendingViewport.current ?? viewportRef.current
    const frames = window.last - window.first
    pendingCursor.current = clamp(
      window.first + Math.round(ratio * Math.max(0, frames - 1)),
      window.first,
      window.last - 1,
    )
    scheduleFlush()
  }

  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    updateCursor(event)
    const bounds = event.currentTarget.getBoundingClientRect()
    panGesture.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      width: Math.max(1, bounds.width),
      viewport: pendingViewport.current ?? viewportRef.current,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  function continuePan(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = panGesture.current
    if (gesture && gesture.pointerId === event.pointerId) {
      const frames = gesture.viewport.last - gesture.viewport.first
      const frameDelta = (gesture.startClientX - event.clientX) /
        gesture.width * frames
      pendingViewport.current =
        normalizedWindow(gesture.viewport.first + frameDelta, frames)
    }
    updateCursor(event)
    scheduleFlush()
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = panGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    panGesture.current = undefined
    setDragging(false)
  }

  function leavePlot() {
    if (!panGesture.current) setCursorFrame(undefined)
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
      'textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])
    if (controls.length === 0) {
      event.preventDefault()
      return
    }
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (document.activeElement === dialogRef.current) {
      event.preventDefault()
      const target = event.shiftKey ? last : first
      target.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function relativeTime(frame: number) {
    if (triggerIndex === undefined) return 'unknown'
    const seconds = waveformFrameTimeSeconds(waveform, frame) -
      waveformFrameTimeSeconds(waveform, triggerIndex)
    return `${seconds >= 0 ? '+' : ''}${seconds.toFixed(6)} s`
  }

  function toggleChannel(index: number) {
    setEnabled((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return createPortal(<div className="waveform-viewer-backdrop"
    onClick={(event) => {
      event.stopPropagation()
      if (event.target === event.currentTarget) onClose()
    }}>
    <section ref={dialogRef} tabIndex={-1} className="waveform-viewer"
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      aria-describedby={descriptionId} onKeyDown={handleDialogKeyDown}>
    <header className="waveform-viewer-header">
      <div>
        <p className="eyebrow">Waveform viewer</p>
        <h2 id={titleId}>{filename}</h2>
        <span id={descriptionId}>{captureTime(waveform)} · {waveform.sampleRateHz.toLocaleString()} frame/s
          {waveform.decimation > 1 &&
            ` ÷ ${waveform.decimation} (mean of each group)`} ·
          {' '}{durationSeconds.toFixed(3)} s · MNCWF v{waveform.version}</span>
      </div>
      <button type="button" onClick={onClose}>Close viewer</button>
    </header>
    <div className="waveform-viewer-controls">
      <fieldset>
        <legend>Display values</legend>
        <label><input type="radio" name="waveform-units" value="raw"
          checked={displayMode === 'raw'} onChange={() => setDisplayMode('raw')} />
          Raw ADC counts</label>
        <label><input type="radio" name="waveform-units" value="converted"
          checked={displayMode === 'converted'} disabled={!conversionAvailable}
          onChange={() => setDisplayMode('converted')} />
          Converted amperes / volts</label>
      </fieldset>
      <fieldset className="waveform-channel-toggles">
        <legend>Channels</legend>
        {waveform.channels.map((channel, index) =>
          <label key={`${channel.sourceChannel}-${channel.name}`}>
            <input type="checkbox" checked={enabled.has(index)}
              onChange={() => toggleChannel(index)} />
            CH{channel.sourceChannel} {channel.name}
          </label>)}
      </fieldset>
      <fieldset>
        <legend>Plot layout</legend>
        <label><input type="radio" name="waveform-layout" value="separate"
          checked={plotLayout === 'separate'}
          onChange={() => setPlotLayout('separate')} />
          Separate</label>
        <label><input type="radio" name="waveform-layout" value="electrical"
          checked={plotLayout === 'electrical'}
          onChange={() => setPlotLayout('electrical')} />
          Voltage / current overlays</label>
        <label><input type="radio" name="waveform-layout" value="overlay"
          checked={plotLayout === 'overlay'}
          onChange={() => setPlotLayout('overlay')} />
          All channels overlay</label>
      </fieldset>
      <fieldset>
        <legend>Vertical scale</legend>
        <label><input type="radio" name="waveform-scale" value="auto"
          checked={verticalScale === 'auto'}
          onChange={() => setVerticalScale('auto')} />
          Auto (visible view)</label>
        <label><input type="radio" name="waveform-scale" value="fixed"
          checked={verticalScale === 'fixed'}
          onChange={() => setVerticalScale('fixed')} />
          Fixed (whole capture)</label>
      </fieldset>
      <fieldset className="waveform-viewport-controls">
        <legend>View</legend>
        <button type="button" onClick={() => zoomAt(.5)}
          disabled={visibleFrames <= Math.min(MIN_VISIBLE_FRAMES, waveform.frameCount)}>
          Zoom in
        </button>
        <button type="button" onClick={() => zoomAt(2)}
          disabled={visibleFrames >= waveform.frameCount}>
          Zoom out
        </button>
        <button type="button" onClick={fitCapture}
          disabled={visibleFrames >= waveform.frameCount}>Fit</button>
        <button type="button" onClick={centerOnTrigger}
          disabled={!triggerInCapture}>At trigger</button>
        <span>Wheel to zoom · drag to pan</span>
      </fieldset>
    </div>
    <div className="waveform-plots" ref={plotsRef}>
      {plots.map((plot) => {
        const firstEnvelope = plot.envelopes[0]?.envelope
        return <article className={`waveform-plot ${plotLayout === 'separate'
          ? `channel-color-${plot.envelopes[0].index % 7}` : 'waveform-overlay-plot'}`}
          key={plot.id}>
          {plotLayout === 'separate' ? <div className="waveform-plot-label">
            <strong>CH{plot.envelopes[0].channel.sourceChannel} {plot.envelopes[0].channel.name}</strong>
            <span>{converted && plot.envelopes[0].channel.conversionValid
              ? plot.envelopes[0].channel.unit : 'ADC count'}</span>
            <code>{formatEngineering(firstEnvelope.minimum)} … {formatEngineering(firstEnvelope.maximum)}</code>
            {cursorFrame !== undefined && <output>
              {formatEngineering(converted && plot.envelopes[0].channel.conversionValid
                ? convertedSample(rawSample(waveform, cursorFrame,
                  plot.envelopes[0].index), plot.envelopes[0].channel) ?? 0
                : rawSample(waveform, cursorFrame, plot.envelopes[0].index))}
              {' '}{converted && plot.envelopes[0].channel.conversionValid
                ? plot.envelopes[0].channel.unit : 'count'}
            </output>}
          </div> : <div className="waveform-overlay-label">
            <strong>{plot.label}</strong>
            <span>{plot.sharedScale ? 'Shared electrical scale' : 'Independent channel scales'}</span>
            <div className="waveform-overlay-legend">
              {plot.envelopes.map(({ index, channel, envelope }) =>
                <span className={`channel-color-${index % 7}`} key={channel.sourceChannel}>
                  <i />
                  <b>CH{channel.sourceChannel} {channel.name}</b>
                  <code>{formatEngineering(envelope.minimum)} … {formatEngineering(envelope.maximum)}</code>
                  {cursorFrame !== undefined && <output>
                    {formatEngineering(converted && channel.conversionValid
                      ? convertedSample(rawSample(waveform, cursorFrame, index), channel) ?? 0
                      : rawSample(waveform, cursorFrame, index))}
                    {' '}{converted && channel.conversionValid ? channel.unit : 'count'}
                  </output>}
                </span>)}
            </div>
          </div>}
          <div className="waveform-plot-canvas"
            data-dragging={dragging ? 'true' : 'false'}
            title="Wheel to zoom; drag horizontally to pan"
            onWheel={handleWheel}
            onPointerDown={beginPan}
            onPointerMove={continuePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onPointerLeave={leavePlot}>
            <WaveformCanvas traces={plot.envelopes}
              sharedScale={plot.sharedScale}
              overlay={plotLayout !== 'separate'} />
            {triggerInViewport &&
              <i className="waveform-trigger-marker" style={{ left: `${triggerPercent}%` }} />}
            {cursorFrame !== undefined && cursorPercent !== undefined &&
              <i className="waveform-cursor-marker"
                style={{ left: `${cursorPercent}%` }} />}
          </div>
        </article>
      })}
    </div>
    <footer className="waveform-viewer-footer">
      <span>{triggerInCapture
        ? `Trigger at frame ${triggerFrame.toLocaleString()}${triggerInViewport
          ? ` (${triggerPercent.toFixed(2)}% of view)` : ' (outside view)'}`
        : 'Trigger is outside the stored frame range'}</span>
      <span>View {relativeTime(viewport.first)} … {relativeTime(viewport.last - 1)}
        {' '}· {visibleFrames.toLocaleString()} frames · {zoomLevel.toFixed(2)}×</span>
      <span>{waveform.events.length} event marker{waveform.events.length === 1 ? '' : 's'}</span>
      {cursorFrame !== undefined &&
        <span>Cursor frame {cursorFrame.toLocaleString()} · {relativeTime(cursorFrame)}</span>}
      <span>{waveform.frameCount.toLocaleString()} total frames</span>
    </footer>
    </section>
  </div>, document.body)
}
