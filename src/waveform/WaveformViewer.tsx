import {
  useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  ParsedWaveform, parseWaveform, waveformEnvelope,
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

export function WaveformViewer({ filename, buffer, onClose }: {
  filename: string
  buffer: ArrayBuffer
  onClose: () => void
}) {
  const waveform = useMemo(() => parseWaveform(buffer), [buffer])
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
  const [dragging, setDragging] = useState(false)
  const panGesture = useRef<PanGesture>()

  useEffect(() => {
    setViewport({ first: 0, last: waveform.frameCount })
    setEnabled(new Set(waveform.channels.map((_, index) => index)))
    panGesture.current = undefined
    setDragging(false)
  }, [waveform])

  const converted = displayMode === 'converted'
  const envelopes = useMemo(() => waveform.channels.map((channel, index) => ({
    channel,
    envelope: waveformEnvelope(
      waveform, index, converted, PLOT_WIDTH, PLOT_HEIGHT,
      viewport.first, viewport.last,
    ),
  })), [waveform, converted, viewport])
  const durationSeconds = waveform.sampleRateHz
    ? waveform.frameCount / waveform.sampleRateHz
    : 0
  const triggerInCapture = waveform.triggerSequence >= waveform.firstSequence &&
    waveform.triggerSequence <= waveform.lastSequence
  const triggerIndex = triggerInCapture
    ? Number(waveform.triggerSequence - waveform.firstSequence)
    : 0
  const visibleFrames = viewport.last - viewport.first
  const triggerInViewport = triggerInCapture &&
    triggerIndex >= viewport.first && triggerIndex < viewport.last
  const triggerPercent = visibleFrames > 1
    ? clamp((triggerIndex - viewport.first) / (visibleFrames - 1) * 100, 0, 100)
    : 0
  const zoomLevel = waveform.frameCount / visibleFrames

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
    if (!triggerInCapture) return
    const detailFrames = waveform.sampleRateHz
      ? Math.max(MIN_VISIBLE_FRAMES, Math.round(waveform.sampleRateHz / 4))
      : Math.max(MIN_VISIBLE_FRAMES, Math.round(waveform.frameCount / 10))
    const frames = Math.min(waveform.frameCount, detailFrames)
    setViewport(normalizedWindow(triggerIndex - frames / 2, frames))
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.deltaY === 0) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const anchor = bounds.width
      ? clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      : .5
    const unit = event.deltaMode === 1 ? 16 :
      event.deltaMode === 2 ? bounds.height : 1
    const delta = clamp(event.deltaY * unit, -240, 240)
    zoomAt(Math.exp(delta * .003), anchor)
  }

  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
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
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const frames = gesture.viewport.last - gesture.viewport.first
    const frameDelta = (gesture.startClientX - event.clientX) /
      gesture.width * frames
    setViewport(normalizedWindow(gesture.viewport.first + frameDelta, frames))
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = panGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    panGesture.current = undefined
    setDragging(false)
  }

  function relativeTime(frame: number) {
    if (!waveform.sampleRateHz) return 'unknown'
    const seconds = (frame - triggerIndex) / waveform.sampleRateHz
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
        <span>{captureTime(waveform)} · {waveform.sampleRateHz.toLocaleString()} frame/s ·
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
    <div className="waveform-plots">
      {envelopes.map(({ channel, envelope }, index) => enabled.has(index) &&
        <article className={`waveform-plot channel-${index % 7}`} key={channel.sourceChannel}>
          <div className="waveform-plot-label">
            <strong>CH{channel.sourceChannel} {channel.name}</strong>
            <span>{converted && channel.conversionValid ? channel.unit : 'ADC count'}</span>
            <code>{formatEngineering(envelope.minimum)} … {formatEngineering(envelope.maximum)}</code>
          </div>
          <div className="waveform-plot-canvas"
            data-dragging={dragging ? 'true' : 'false'}
            title="Wheel to zoom; drag horizontally to pan"
            onWheel={handleWheel}
            onPointerDown={beginPan}
            onPointerMove={continuePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}>
            <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
              preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1={PLOT_HEIGHT / 2} x2={PLOT_WIDTH}
                y2={PLOT_HEIGHT / 2} className="waveform-zero-line" />
              <polygon points={envelope.points} className="waveform-envelope" />
            </svg>
            {triggerInViewport &&
              <i className="waveform-trigger-marker" style={{ left: `${triggerPercent}%` }} />}
          </div>
        </article>)}
    </div>
    <footer className="waveform-viewer-footer">
      <span>{triggerInCapture
        ? `Trigger at frame ${triggerIndex.toLocaleString()}${triggerInViewport
          ? ` (${triggerPercent.toFixed(2)}% of view)` : ' (outside view)'}`
        : 'Trigger is outside the stored frame range'}</span>
      <span>View {relativeTime(viewport.first)} … {relativeTime(viewport.last - 1)}
        {' '}· {visibleFrames.toLocaleString()} frames · {zoomLevel.toFixed(2)}×</span>
      <span>{waveform.events.length} event marker{waveform.events.length === 1 ? '' : 's'}</span>
      <span>{waveform.frameCount.toLocaleString()} total frames</span>
    </footer>
  </section>
}
