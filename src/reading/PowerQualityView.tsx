import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api, ApiError, FlickerRecord, FlickerStatus, MainsSignalStatus,
  PowerQualityEvent, WaveformSession, WaveformStatus, waveformEventExportPath,
} from '../api'
import './powerQuality.css'

const PHASES = ['A', 'B', 'C'] as const

function formatNumber(value: number | undefined, digits = 3) {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function formatUtc(nanoseconds: number | undefined) {
  if (nanoseconds === undefined) return 'UTC unavailable'
  const milliseconds = nanoseconds / 1_000_000
  const date = new Date(milliseconds)
  return Number.isNaN(date.valueOf()) ? 'UTC unavailable' : date.toLocaleString()
}

function eventLabel(type: PowerQualityEvent['type']) {
  return type === 'unknown' ? 'Unknown event' : type.split('_')
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function eventUnit(event: PowerQualityEvent) {
  return event.type.startsWith('current_') ? 'A' : 'V'
}

function microValue(value: number, unit: string) {
  return `${formatNumber(value / 1_000_000, 6)} ${unit}`
}

function recordPhase(record: FlickerRecord | undefined, phase: string) {
  return record?.phases.find((candidate) => candidate.phase === phase)
}

export function overlappingEventCount(
  event: PowerQualityEvent,
  events: readonly PowerQualityEvent[],
) {
  return events.filter((candidate) => candidate.event_id !== event.event_id &&
    candidate.first_sample <= event.last_sample &&
    candidate.last_sample >= event.first_sample).length
}

function EventTimeline({ events, selectedEventId, onSelect }: {
  events: PowerQualityEvent[]
  selectedEventId: string | undefined
  onSelect: (eventId: string) => void
}) {
  if (events.length === 0) return <div className="power-quality-empty">
    <strong>No durable power-quality events</strong>
    <span>The catalogue will populate when an enabled profile starts.</span>
  </div>

  const first = Math.min(...events.map((event) => event.first_sample))
  const last = Math.max(...events.map((event) => event.last_sample))
  const span = Math.max(1, last - first + 1)

  return <ul className="power-quality-timeline"
    aria-label="Power-quality event timeline">
    {events.map((event) => {
      const left = ((event.first_sample - first) / span) * 100
      const width = Math.max(.7, ((event.last_sample - event.first_sample + 1) / span) * 100)
      const overlaps = overlappingEventCount(event, events)
      return <li key={event.event_id}><button type="button"
        className={selectedEventId === event.event_id ? 'selected' : ''}
        onClick={() => onSelect(event.event_id)}>
        <span className="power-quality-event-summary">
          <strong>{eventLabel(event.type)}</strong>
          <small>{event.affected_phases.join(', ') || 'No phase'} · {event.lifecycle}</small>
        </span>
        <span className="power-quality-event-track" aria-hidden="true">
          <i style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} />
        </span>
        <span className="power-quality-event-time">{formatNumber(event.duration_ms)} ms</span>
        {overlaps > 0 && <span className="power-quality-overlap">
          Overlaps {overlaps} {overlaps === 1 ? 'event' : 'events'}
        </span>}
      </button></li>
    })}
  </ul>
}

function CaptureLink({ captureUuid, event, session }: {
  captureUuid: string
  event: PowerQualityEvent
  session: WaveformSession | undefined
}) {
  return <article className="power-quality-capture-link">
    <div>
      <strong>{session ? `Session ${session.id}` : 'Capture pending in session catalogue'}</strong>
      <code>{captureUuid}</code>
    </div>
    {session && <dl>
      <div><dt>State</dt><dd>{session.state}</dd></div>
      <div><dt>Master</dt><dd>Session {session.master_session_id || session.id}</dd></div>
      <div><dt>Continuation</dt><dd>{session.continuation_of_session_id
        ? `After session ${session.continuation_of_session_id}` : 'Master segment'}</dd></div>
    </dl>}
    {session?.state === 'complete' && session.filename
      ? <a href={waveformEventExportPath(session.id, event.event_id)} download>
        Download event MNCWF
      </a>
      : <span className="power-quality-capture-pending">Materialization pending</span>}
  </article>
}

function EventDetail({ event, waveforms }: {
  event: PowerQualityEvent | undefined
  waveforms: WaveformStatus | undefined
}) {
  if (!event) return <div className="power-quality-empty">
    <strong>Select an event</strong><span>Its lifecycle snapshot and linked captures appear here.</span>
  </div>

  const sessionByCapture = new Map(
    waveforms?.sessions.map((session) => [session.capture_uuid, session]) ?? [],
  )
  const unit = eventUnit(event)
  return <div className="power-quality-event-detail">
    <header>
      <div><p className="eyebrow">Canonical event</p><h3>{eventLabel(event.type)}</h3></div>
      <span className={`session-state ${event.lifecycle === 'abort' ? 'incomplete' : 'complete'}`}>
        {event.lifecycle}
      </span>
    </header>
    <code className="power-quality-event-id">{event.event_id}</code>
    <dl className="power-quality-event-facts">
      <div><dt>Started</dt><dd>{formatUtc(event.start_utc_nanoseconds)}</dd></div>
      <div><dt>Last update</dt><dd>{formatUtc(event.last_utc_nanoseconds)}</dd></div>
      <div><dt>Duration</dt><dd>{formatNumber(event.duration_ms)} ms</dd></div>
      <div><dt>Phases</dt><dd>{event.affected_phases.join(', ') || 'None'}</dd></div>
      <div><dt>Classification</dt><dd>{event.taxonomy === 'iec_61000_4_30'
        ? 'IEC 61000-4-30' : 'MSAP1 product alarm'}</dd></div>
      <div><dt>Phase policy</dt><dd>{event.per_phase ? 'Per phase' : 'Polyphase'}</dd></div>
      <div><dt>Threshold</dt><dd>{formatNumber(event.threshold_e4 / 100)} %</dd></div>
      <div><dt>Hysteresis</dt><dd>{formatNumber(event.hysteresis_e4 / 100)} %</dd></div>
      <div><dt>Reference</dt><dd>{microValue(event.reference_micro_units, unit)}</dd></div>
      <div><dt>Minimum A / B / C</dt><dd>{event.minimum_micro_units
        .map((value) => microValue(value, unit)).join(' · ')}</dd></div>
      <div><dt>Maximum A / B / C</dt><dd>{event.maximum_micro_units
        .map((value) => microValue(value, unit)).join(' · ')}</dd></div>
      <div><dt>Samples</dt><dd>{event.first_sample.toLocaleString()}–{event.last_sample.toLocaleString()}</dd></div>
      <div><dt>Time quality</dt><dd>{event.time_quality}</dd></div>
      <div><dt>Discontinuities</dt><dd>{event.discontinuities}</dd></div>
      <div><dt>Profile generation</dt><dd>{event.profile_generation}</dd></div>
      <div><dt>Settings digest</dt><dd><code>{event.settings_digest}</code></dd></div>
    </dl>
    <section className="power-quality-waveforms" aria-labelledby="event-waveforms-title">
      <header><div><p className="eyebrow">Evidence</p><h4 id="event-waveforms-title">Linked waveforms</h4></div>
        <span>MNCWF is the master record</span></header>
      {event.waveform_capture_uuids.map((captureUuid) => <CaptureLink
        key={captureUuid} captureUuid={captureUuid} event={event}
        session={sessionByCapture.get(captureUuid)} />)}
      {event.waveform_capture_uuids.length === 0 && <div className="power-quality-empty compact">
        <strong>No linked capture</strong><span>{event.waveform.enabled
          ? 'The capture coordinator has not linked a materialized session yet.'
          : 'Waveform capture was disabled in this event snapshot.'}</span>
      </div>}
    </section>
  </div>
}

export function PowerQualityView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [flicker, setFlicker] = useState<FlickerStatus>()
  const [mains, setMains] = useState<MainsSignalStatus>()
  const [events, setEvents] = useState<PowerQualityEvent[]>([])
  const [waveforms, setWaveforms] = useState<WaveformStatus>()
  const [selectedEventId, setSelectedEventId] = useState<string>()
  const [signalError, setSignalError] = useState('')
  const [eventError, setEventError] = useState('')

  const handleFailure = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return 'unauthorized'
    }
    return reason instanceof Error ? reason.message : fallback
  }, [onUnauthorized])

  const loadSignals = useCallback(async () => {
    const [nextFlicker, nextMains] = await Promise.allSettled([
      api.meterFlicker(), api.meterMainsSignalling(),
    ])
    const failures: string[] = []
    if (nextFlicker.status === 'fulfilled') setFlicker(nextFlicker.value)
    else failures.push(handleFailure(nextFlicker.reason, 'Unable to read flicker'))
    if (nextMains.status === 'fulfilled') setMains(nextMains.value)
    else failures.push(handleFailure(nextMains.reason, 'Unable to read mains signalling'))
    setSignalError(failures.filter((failure) => failure !== 'unauthorized').join(' · '))
  }, [handleFailure])

  const loadEvents = useCallback(async () => {
    const [nextEvents, nextWaveforms] = await Promise.allSettled([
      api.powerQualityEvents({ limit: 100 }), api.waveforms(),
    ])
    const failures: string[] = []
    if (nextEvents.status === 'fulfilled') {
      setEvents(nextEvents.value.events)
      setSelectedEventId((current) => nextEvents.value.events.some(
        (event) => event.event_id === current) ? current : nextEvents.value.events[0]?.event_id)
    } else failures.push(handleFailure(nextEvents.reason, 'Unable to read event catalogue'))
    if (nextWaveforms.status === 'fulfilled') setWaveforms(nextWaveforms.value)
    else failures.push(handleFailure(nextWaveforms.reason, 'Unable to read waveform catalogue'))
    setEventError(failures.filter((failure) => failure !== 'unauthorized').join(' · '))
  }, [handleFailure])

  useEffect(() => {
    let active = true
    let signalPending = false
    let eventPending = false
    const refreshSignals = async () => {
      if (!active || signalPending) return
      signalPending = true
      await loadSignals()
      signalPending = false
    }
    const refreshEvents = async () => {
      if (!active || eventPending) return
      eventPending = true
      await loadEvents()
      eventPending = false
    }
    void refreshSignals()
    void refreshEvents()
    const signalTimer = window.setInterval(refreshSignals, 1000)
    const eventTimer = window.setInterval(refreshEvents, 2000)
    return () => {
      active = false
      window.clearInterval(signalTimer)
      window.clearInterval(eventTimer)
    }
  }, [loadEvents, loadSignals])

  const selectedEvent = useMemo(() => events.find(
    (event) => event.event_id === selectedEventId), [events, selectedEventId])

  return <section className="power-quality-view" aria-labelledby="power-quality-title">
    <div className="reading-section-heading compact">
      <div><p className="eyebrow">Power quality</p><h2 id="power-quality-title">Events and signalling</h2>
        <p>Independent flicker, carrier detection, and durable event evidence.</p></div>
    </div>
    {signalError && <div className="error-banner"><strong>Live products unavailable</strong>
      <span>{signalError}</span></div>}
    <div className="power-quality-live-grid">
      <section className="power-quality-live-panel" aria-labelledby="flicker-title">
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
      </section>

      <section className="power-quality-live-panel" aria-labelledby="mains-title">
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
      </section>
    </div>

    {eventError && <div className="error-banner"><strong>Event evidence unavailable</strong>
      <span>{eventError}</span></div>}
    <section className="power-quality-events" aria-labelledby="event-catalogue-title">
      <header><div><p className="eyebrow">Historian</p><h3 id="event-catalogue-title">Event catalogue</h3></div>
        <span>{events.length} most recent events</span></header>
      <div className="power-quality-event-workspace">
        <EventTimeline events={events} selectedEventId={selectedEventId}
          onSelect={setSelectedEventId} />
        <EventDetail event={selectedEvent} waveforms={waveforms} />
      </div>
    </section>
  </section>
}
