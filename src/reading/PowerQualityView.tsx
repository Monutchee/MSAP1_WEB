import {
  type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useState,
} from 'react'
import {
  api, ApiError, FlickerRecord, FlickerStatus, MainsSignalStatus,
  PowerQualityRecord, PowerQualityStatus,
} from '../api'
import './powerQuality.css'

const PHASES = ['A', 'B', 'C'] as const
const CATEGORIES = ['flicker', 'mains', 'events'] as const
type PowerQualityCategory = typeof CATEGORIES[number]

function formatNumber(value: number | undefined, digits = 3) {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function recordPhase(record: FlickerRecord | undefined, phase: string) {
  return record?.phases.find((candidate) => candidate.phase === phase)
}

function eventLabel(record: PowerQualityRecord | undefined) {
  if (!record || record.event_type === 'none') return 'No event edge recorded'
  const label = record.event_type[0].toUpperCase() + record.event_type.slice(1)
  return `${label} ${record.kind === 'event_end' ? 'ended' : 'started'}`
}

export function PowerQualityView({ onUnauthorized, enabled = true }: {
  onUnauthorized: () => void
  enabled?: boolean
}) {
  const [category, setCategory] = useState<PowerQualityCategory>('flicker')
  const [flicker, setFlicker] = useState<FlickerStatus>()
  const [mains, setMains] = useState<MainsSignalStatus>()
  const [events, setEvents] = useState<PowerQualityStatus>()
  const [error, setError] = useState('')

  const handleFailure = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return 'unauthorized'
    }
    return reason instanceof Error ? reason.message : fallback
  }, [onUnauthorized])

  const load = useCallback(async () => {
    const [nextFlicker, nextMains, nextEvents] = await Promise.allSettled([
      api.meterFlicker(), api.meterMainsSignalling(), api.meterPowerQuality(),
    ])
    const failures: string[] = []
    if (nextFlicker.status === 'fulfilled') setFlicker(nextFlicker.value)
    else failures.push(handleFailure(nextFlicker.reason, 'Unable to read flicker'))
    if (nextMains.status === 'fulfilled') setMains(nextMains.value)
    else failures.push(handleFailure(nextMains.reason, 'Unable to read mains signalling'))
    if (nextEvents.status === 'fulfilled') setEvents(nextEvents.value)
    else failures.push(handleFailure(nextEvents.reason, 'Unable to read PQ Event state'))
    setError(failures.filter((failure) => failure !== 'unauthorized').join(' · '))
  }, [handleFailure])

  useEffect(() => {
    if (!enabled) {
      setFlicker(undefined)
      setMains(undefined)
      setEvents(undefined)
      setError('')
      return
    }
    let active = true
    let pending = false
    const refresh = async () => {
      if (!active || pending) return
      pending = true
      await load()
      pending = false
    }
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [enabled, load])

  function handleCategoryTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
        event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const current = CATEGORIES.indexOf(category)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? CATEGORIES.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + CATEGORIES.length) %
          CATEGORIES.length
    setCategory(CATEGORIES[next])
    document.getElementById(`power-quality-reading-tab-${CATEGORIES[next]}`)?.focus()
  }

  const latest = events?.has_latest ? events.latest : undefined
  const edge = events?.has_event ? events.event : undefined

  return <section className="power-quality-view" aria-labelledby="power-quality-title">
    <div className="reading-section-heading compact">
      <div><p className="eyebrow">Power quality</p><h2 id="power-quality-title">Live product status</h2>
        <p>Inspect flicker, mains signalling, and the half-cycle PQ Event detector independently.</p></div>
    </div>
    <nav className="power-quality-reading-tabs" role="tablist"
      aria-orientation="horizontal" aria-label="Power-quality reading sections">
      <button id="power-quality-reading-tab-flicker" role="tab" type="button"
        className={category === 'flicker' ? 'active' : ''}
        aria-selected={category === 'flicker'}
        aria-controls="power-quality-reading-panel-flicker"
        tabIndex={category === 'flicker' ? 0 : -1}
        onKeyDown={handleCategoryTabKeyDown} onClick={() => setCategory('flicker')}>
        <span>Flicker</span><small>Pinst, Pst, and Plt</small>
      </button>
      <button id="power-quality-reading-tab-mains" role="tab" type="button"
        className={category === 'mains' ? 'active' : ''}
        aria-selected={category === 'mains'}
        aria-controls="power-quality-reading-panel-mains"
        tabIndex={category === 'mains' ? 0 : -1}
        onKeyDown={handleCategoryTabKeyDown} onClick={() => setCategory('mains')}>
        <span>Mains signal</span><small>Carrier observation</small>
      </button>
      <button id="power-quality-reading-tab-events" role="tab" type="button"
        className={category === 'events' ? 'active' : ''}
        aria-selected={category === 'events'}
        aria-controls="power-quality-reading-panel-events"
        tabIndex={category === 'events' ? 0 : -1}
        onKeyDown={handleCategoryTabKeyDown} onClick={() => setCategory('events')}>
        <span>PQ Event</span><small>Urms(1/2) detector</small>
      </button>
    </nav>

    {error && <div className="error-banner"><strong>Live product unavailable</strong>
      <span>{error}</span></div>}

    {category === 'flicker' && <section id="power-quality-reading-panel-flicker"
      role="tabpanel" aria-labelledby="power-quality-reading-tab-flicker"
      className="power-quality-live-panel">
      <header><div><p className="eyebrow">IEC flicker</p><h3 id="flicker-title">Flicker severity</h3></div>
        <span className={`status-pill ${flicker?.running ? 'ok' : 'bad'}`}><i />
          {flicker?.running ? 'Running' : 'Stopped'}</span></header>
      <div className="power-quality-phase-grid">
        {PHASES.map((phase) => {
          const live = recordPhase(flicker?.live, phase)
          const pst = recordPhase(flicker?.pst, phase)
          const plt = recordPhase(flicker?.plt, phase)
          return <article key={phase} className={live?.valid ? 'valid' : 'invalid'}>
            <strong>Phase {phase}</strong>
            <dl>
              <div><dt>Pinst</dt><dd>{live?.valid ? formatNumber(live.pinst, 4) : '—'}</dd></div>
              <div><dt>Pst</dt><dd>{pst?.valid ? formatNumber(pst.pst, 4) : '—'}</dd></div>
              <div><dt>Plt</dt><dd>{plt?.valid ? formatNumber(plt.plt, 4) : '—'}</dd></div>
            </dl>
          </article>
        })}
      </div>
      <footer>{flicker
        ? `${flicker.records.toLocaleString()} records · ${flicker.sequence_gaps.toLocaleString()} gaps`
        : 'Waiting for the flicker engine'}</footer>
    </section>}

    {category === 'mains' && <section id="power-quality-reading-panel-mains"
      role="tabpanel" aria-labelledby="power-quality-reading-tab-mains"
      className="power-quality-live-panel">
      <header><div><p className="eyebrow">Mains signalling</p><h3 id="mains-title">Carrier observation</h3></div>
        <span className={`status-pill ${mains?.running ? 'ok' : 'bad'}`}><i />
          {mains?.running ? 'Running' : 'Stopped'}</span></header>
      <div className="power-quality-carrier-summary">
        <div><span>Configured</span><strong>{formatNumber(mains?.configured_hz)} Hz</strong></div>
        <div><span>Measured</span><strong>{mains?.available
          ? `${formatNumber(mains.measured_hz)} Hz` : '—'}</strong></div>
        <div><span>Bandwidth</span><strong>{formatNumber(mains?.bandwidth_hz)} Hz</strong></div>
        <div><span>Threshold</span><strong>{formatNumber(mains?.threshold_percent)} %</strong></div>
      </div>
      <div className="power-quality-phase-grid mains">
        {PHASES.map((phase) => {
          const reading = mains?.phases.find((candidate) => candidate.phase === phase)
          return <article key={phase} className={reading?.valid ? 'valid' : 'invalid'}>
            <strong>Phase {phase}</strong>
            <span className={`carrier-detected ${reading?.detected ? 'active' : ''}`}>
              {reading?.detected ? 'Detected' : 'Clear'}</span>
            <dl>
              <div><dt>Carrier</dt><dd>{reading?.valid
                ? `${formatNumber(reading.magnitude_volts, 6)} V` : '—'}</dd></div>
              <div><dt>Background</dt><dd>{reading?.valid
                ? `${formatNumber(reading.background_volts, 6)} V` : '—'}</dd></div>
            </dl>
          </article>
        })}
      </div>
      <footer>{mains
        ? `${mains.records.toLocaleString()} records · ${mains.sequence_gaps.toLocaleString()} gaps`
        : 'Waiting for the mains-signalling engine'}</footer>
    </section>}

    {category === 'events' && <section id="power-quality-reading-panel-events"
      role="tabpanel" aria-labelledby="power-quality-reading-tab-events"
      className="power-quality-live-panel">
      <header><div><p className="eyebrow">IEC voltage events</p><h3 id="pq-events-title">PQ Event detector</h3></div>
        <span className={`status-pill ${events?.running ? 'ok' : 'bad'}`}><i />
          {events?.running ? 'Running' : 'Stopped'}</span></header>
      <div className="power-quality-engine-summary">
        <div><span>Records</span><strong>{events?.records.toLocaleString() ?? '—'}</strong></div>
        <div><span>Edges</span><strong>{events?.events.toLocaleString() ?? '—'}</strong></div>
        <div><span>Detector</span><strong>{latest?.armed ? 'Armed' : 'Disarmed'}</strong></div>
        <div><span>Reference</span><strong>{latest
          ? `${formatNumber(latest.reference_volts, 3)} V` : '—'}</strong></div>
      </div>
      {latest ? <div className="power-quality-phase-grid event-engine">
        {latest.phases.map((phase) => <article key={phase.phase}
          className={phase.quality === 1 ? 'valid' : 'invalid'}>
          <strong>Phase {phase.phase}</strong>
          <dl>
            <div><dt>Urms(1/2)</dt><dd>{formatNumber(phase.urms_half, 3)} V</dd></div>
            <div><dt>Minimum</dt><dd>{formatNumber(phase.urms_half_minimum, 3)} V</dd></div>
            <div><dt>Maximum</dt><dd>{formatNumber(phase.urms_half_maximum, 3)} V</dd></div>
            <div><dt>Irms(1/2)</dt><dd>{formatNumber(phase.irms_half, 4)} A</dd></div>
          </dl>
        </article>)}
      </div> : <div className="power-quality-empty">
        <strong>Waiting for the half-cycle detector</strong>
        <span>The event engine may still be priming its first Urms(1/2) window.</span>
      </div>}
      <div className="power-quality-last-edge">
        <div><span>Last detector edge</span><strong>{eventLabel(edge)}</strong></div>
        {edge && <dl>
          <div><dt>Phases</dt><dd>{edge.affected_phases.join(', ') || 'None'}</dd></div>
          <div><dt>Duration</dt><dd>{formatNumber(edge.duration_ms, 3)} ms</dd></div>
          <div><dt>Samples</dt><dd>{edge.duration_samples.toLocaleString()}</dd></div>
        </dl>}
        <p>Durable lifecycle records and linked waveform evidence are under History → PQ Event catalogue.</p>
      </div>
    </section>}
  </section>
}
