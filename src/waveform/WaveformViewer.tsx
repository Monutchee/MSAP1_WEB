import { useMemo, useState } from 'react'
import {
  ParsedWaveform, parseWaveform, waveformEnvelope,
} from './waveformFile'

const PLOT_WIDTH = 1200
const PLOT_HEIGHT = 88

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
  const converted = displayMode === 'converted'
  const envelopes = useMemo(() => waveform.channels.map((channel, index) => ({
    channel,
    envelope: waveformEnvelope(waveform, index, converted),
  })), [waveform, converted])
  const durationSeconds = waveform.sampleRateHz
    ? waveform.frameCount / waveform.sampleRateHz
    : 0
  const triggerInCapture = waveform.triggerSequence >= waveform.firstSequence &&
    waveform.triggerSequence <= waveform.lastSequence
  const triggerIndex = triggerInCapture
    ? Number(waveform.triggerSequence - waveform.firstSequence)
    : 0
  const triggerPercent = waveform.frameCount > 1
    ? Math.max(0, Math.min(100, triggerIndex / (waveform.frameCount - 1) * 100))
    : 0

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
    </div>
    <div className="waveform-plots">
      {envelopes.map(({ channel, envelope }, index) => enabled.has(index) &&
        <article className={`waveform-plot channel-${index % 7}`} key={channel.sourceChannel}>
          <div className="waveform-plot-label">
            <strong>CH{channel.sourceChannel} {channel.name}</strong>
            <span>{converted && channel.conversionValid ? channel.unit : 'ADC count'}</span>
            <code>{formatEngineering(envelope.minimum)} … {formatEngineering(envelope.maximum)}</code>
          </div>
          <div className="waveform-plot-canvas">
            <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
              preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1={PLOT_HEIGHT / 2} x2={PLOT_WIDTH}
                y2={PLOT_HEIGHT / 2} className="waveform-zero-line" />
              <polygon points={envelope.points} className="waveform-envelope" />
            </svg>
            {triggerInCapture &&
              <i className="waveform-trigger-marker" style={{ left: `${triggerPercent}%` }} />}
          </div>
        </article>)}
    </div>
    <footer className="waveform-viewer-footer">
      <span>{triggerInCapture
        ? `Trigger at frame ${triggerIndex.toLocaleString()} (${triggerPercent.toFixed(2)}%)`
        : 'Trigger is outside the stored frame range'}</span>
      <span>{waveform.events.length} event marker{waveform.events.length === 1 ? '' : 's'}</span>
      <span>{waveform.frameCount.toLocaleString()} frames</span>
    </footer>
  </section>
}
