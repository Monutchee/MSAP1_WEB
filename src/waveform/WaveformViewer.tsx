import {
  useCallback, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  buildWaveformPyramid, convertedSample, ParsedWaveform,
  pyramidEnvelope, pyramidRange, rawSample, waveformDurationSeconds,
  waveformFrameForSequence, waveformFrameTimeSeconds,
} from './waveformFile'

const PLOT_WIDTH = 1200
const PLOT_HEIGHT = 88
const MIN_VISIBLE_FRAMES = 16

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

export function WaveformViewer({ filename, waveform, onClose }: {
  filename: string
  waveform: ParsedWaveform
  onClose: () => void
}) {
  /*
   * One full pass over the samples at open builds the min/max pyramid;
   * every pan/zoom afterwards reads the pyramid instead of the samples, so
   * gesture cost scales with plot width, not with visible frame count.
   */
  const pyramid = useMemo(() => buildWaveformPyramid(waveform), [waveform])
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
  const plotsRef = useRef<HTMLDivElement>(null)
  const panGesture = useRef<PanGesture>()
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
      setViewport(pendingViewport.current)
      pendingViewport.current = undefined
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
    setViewport({ first: 0, last: waveform.frameCount })
    setEnabled(new Set(waveform.channels.map((_, index) => index)))
    setVerticalScale('auto')
    setPlotLayout('separate')
    setCursorFrame(undefined)
    panGesture.current = undefined
    setDragging(false)
  }, [waveform])

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
  const visibleEnvelopes = useMemo(() => waveform.channels.map((channel, index) => ({
    channel,
    envelope: pyramidEnvelope(
      waveform, pyramid, index, converted, PLOT_WIDTH, PLOT_HEIGHT,
      viewport.first, viewport.last,
    ),
  })), [waveform, pyramid, converted, viewport])
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
        : visibleEnvelopes[index].envelope.minimum)),
      maximum: Math.max(...group.indices.map((index) => verticalScale === 'fixed'
        ? wholeCaptureRanges[index].maximum
        : visibleEnvelopes[index].envelope.maximum)),
    } : undefined
    return {
      ...group,
      sharedScale: plotLayout !== 'overlay' || group.indices.length === 1,
      envelopes: group.indices.map((index) => ({
        index,
        channel: waveform.channels[index],
        envelope: pyramidEnvelope(
          waveform, pyramid, index, converted, PLOT_WIDTH, PLOT_HEIGHT,
          viewport.first, viewport.last,
          sharedRange ?? (verticalScale === 'fixed'
            ? wholeCaptureRanges[index] : undefined),
        ),
      })),
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
    setViewport((current) => {
      const frames = current.last - current.first
      const anchor = current.first + clamp(anchorRatio, 0, 1) * frames
      const nextFrames = clamp(
        Math.round(frames * factor),
        Math.min(MIN_VISIBLE_FRAMES, waveform.frameCount),
        waveform.frameCount,
      )
      return normalizedWindow(anchor - anchorRatio * nextFrames, nextFrames)
    })
  }

  function fitCapture() {
    setViewport({ first: 0, last: waveform.frameCount })
  }

  function centerOnTrigger() {
    if (triggerIndex === undefined) return
    const detailFrames = waveform.effectiveSampleRateHz
      ? Math.max(MIN_VISIBLE_FRAMES,
          Math.round(waveform.effectiveSampleRateHz / 4))
      : Math.max(MIN_VISIBLE_FRAMES, Math.round(waveform.frameCount / 10))
    const frames = Math.min(waveform.frameCount, detailFrames)
    setViewport(normalizedWindow(triggerIndex - frames / 2, frames))
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
    const window = pendingViewport.current ?? viewport
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
      viewport,
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

  return <section className="waveform-viewer" aria-label={`Waveform ${filename}`}>
    <header className="waveform-viewer-header">
      <div>
        <p className="eyebrow">Waveform viewer</p>
        <h2>{filename}</h2>
        <span>{captureTime(waveform)} · {waveform.sampleRateHz.toLocaleString()} frame/s
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
            <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
              preserveAspectRatio="none" aria-hidden="true">
              {plot.sharedScale && firstEnvelope.scaleMinimum <= 0 &&
                firstEnvelope.scaleMaximum >= 0 &&
                <line x1="0"
                  y1={PLOT_HEIGHT -
                    (0 - firstEnvelope.scaleMinimum) /
                    (firstEnvelope.scaleMaximum - firstEnvelope.scaleMinimum) * PLOT_HEIGHT}
                  x2={PLOT_WIDTH}
                  y2={PLOT_HEIGHT -
                    (0 - firstEnvelope.scaleMinimum) /
                    (firstEnvelope.scaleMaximum - firstEnvelope.scaleMinimum) * PLOT_HEIGHT}
                  className="waveform-zero-line" />}
              {plot.envelopes.map(({ index, channel, envelope }) =>
                <polygon key={channel.sourceChannel} points={envelope.points}
                  className={`waveform-envelope waveform-series channel-color-${index % 7}`} />)}
            </svg>
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
}
