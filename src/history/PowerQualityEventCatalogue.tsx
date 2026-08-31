import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api, ApiError, PowerQualityEvent, WaveformSession, WaveformStatus,
  waveformEventExportPath,
} from '../api'
import { ConfirmDialog, ConfirmDialogState } from '../components/ConfirmDialog'
import { WaveformViewer } from '../waveform/WaveformViewer'
import { parseWaveform, ParsedWaveform } from '../waveform/waveformFile'
import '../reading/powerQuality.css'

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

function eventsOverlap(first: PowerQualityEvent, second: PowerQualityEvent) {
  if (first.source_session === second.source_session)
    return first.first_sample <= second.last_sample &&
      first.last_sample >= second.first_sample
  if (first.start_utc_nanoseconds === undefined ||
      first.last_utc_nanoseconds === undefined ||
      second.start_utc_nanoseconds === undefined ||
      second.last_utc_nanoseconds === undefined) return false
  return first.start_utc_nanoseconds <= second.last_utc_nanoseconds &&
    first.last_utc_nanoseconds >= second.start_utc_nanoseconds
}

export function overlappingEventCount(
  event: PowerQualityEvent,
  events: readonly PowerQualityEvent[],
) {
  return events.filter((candidate) => candidate.event_id !== event.event_id &&
    eventsOverlap(event, candidate)).length
}

export interface PowerQualityEventGroup {
  id: string
  events: PowerQualityEvent[]
  firstSample: number
  lastSample: number
}

/** Connected components make overlap grouping transitive: if A overlaps B
 * and B overlaps C, the catalogue renders one incident even when A and C do
 * not directly intersect. API order is retained within and between groups. */
export function groupOverlappingEvents(
  events: readonly PowerQualityEvent[],
): PowerQualityEventGroup[] {
  const parents = events.map((_, index) => index)
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]]
      index = parents[index]
    }
    return index
  }
  for (let first = 0; first < events.length; first += 1) {
    for (let second = first + 1; second < events.length; second += 1) {
      if (!eventsOverlap(events[first], events[second])) continue
      const firstRoot = root(first)
      const secondRoot = root(second)
      if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot
    }
  }
  const grouped = new Map<number, PowerQualityEvent[]>()
  events.forEach((event, index) => {
    const groupRoot = root(index)
    const group = grouped.get(groupRoot) ?? []
    group.push(event)
    grouped.set(groupRoot, group)
  })
  return Array.from(grouped.values()).map((members) => ({
    id: members[0].event_id,
    events: members,
    firstSample: Math.min(...members.map((event) => event.first_sample)),
    lastSample: Math.max(...members.map((event) => event.last_sample)),
  }))
}

function groupLabel(group: PowerQualityEventGroup) {
  if (group.events.length === 1) return eventLabel(group.events[0].type)
  const types = new Set(group.events.map((event) => event.type))
  return types.size === 1
    ? `${eventLabel(group.events[0].type)} incident`
    : 'Overlapping PQ incident'
}

function groupDuration(group: PowerQualityEventGroup) {
  const rate = group.events[0].sample_rate_hz
  if (rate > 0 && group.events.every((event) =>
    event.sample_rate_hz === rate &&
    event.source_session === group.events[0].source_session))
    return (group.lastSample - group.firstSample + 1) / rate * 1000
  const starts = group.events.map((event) => event.start_utc_nanoseconds)
  const ends = group.events.map((event) => event.last_utc_nanoseconds)
  if (starts.every((value) => value !== undefined) &&
      ends.every((value) => value !== undefined))
    return (Math.max(...ends as number[]) - Math.min(...starts as number[])) /
      1_000_000
  return Math.max(...group.events.map((event) => event.duration_ms))
}

function GroupCheckbox({ group, selected, onToggle }: {
  group: PowerQualityEventGroup
  selected: ReadonlySet<string>
  onToggle: (eventIds: string[]) => void
}) {
  const ids = group.events.map((event) => event.event_id)
  const checked = ids.every((id) => selected.has(id))
  return <input type="checkbox" checked={checked}
    aria-label={`Select ${groupLabel(group)}`}
    onChange={() => onToggle(ids)} />
}

function EventTimeline({ groups, selectedEventId, checkedEventIds, expandedGroups,
  canDelete, onSelect, onToggleExpanded, onToggleChecked, onDelete }: {
  groups: PowerQualityEventGroup[]
  selectedEventId: string | undefined
  checkedEventIds: ReadonlySet<string>
  expandedGroups: ReadonlySet<string>
  canDelete: boolean
  onSelect: (eventId: string) => void
  onToggleExpanded: (groupId: string) => void
  onToggleChecked: (eventIds: string[]) => void
  onDelete: (events: PowerQualityEvent[]) => void
}) {
  if (groups.length === 0) return <div className="power-quality-empty">
    <strong>No durable power-quality events</strong>
    <span>The catalogue will populate when an enabled profile starts.</span>
  </div>

  const first = Math.min(...groups.map((group) => group.firstSample))
  const last = Math.max(...groups.map((group) => group.lastSample))
  const span = Math.max(1, last - first + 1)

  return <ul className="power-quality-timeline"
    aria-label="Power-quality event timeline">
    {groups.map((group) => {
      const expanded = expandedGroups.has(group.id)
      const groupSelected = group.events.some(
        (event) => event.event_id === selectedEventId)
      const phases = Array.from(new Set(group.events.flatMap(
        (event) => event.affected_phases))).join(', ') || 'No phase'
      const left = ((group.firstSample - first) / span) * 100
      const width = Math.max(.7,
        ((group.lastSample - group.firstSample + 1) / span) * 100)
      return <li className="power-quality-event-group" key={group.id}>
        <div className={`power-quality-group-row ${groupSelected ? 'selected' : ''}`}>
          {canDelete && <GroupCheckbox group={group} selected={checkedEventIds}
            onToggle={onToggleChecked} />}
          <button type="button" className="power-quality-group-main"
            onClick={() => onSelect(group.events[0].event_id)}>
            <span className="power-quality-event-summary">
              <strong>{groupLabel(group)}</strong>
              <small>{phases} · {group.events.length} event{group.events.length === 1 ? '' : 's'}</small>
            </span>
            <span className="power-quality-event-track" aria-hidden="true">
              <i style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} />
            </span>
            <span className="power-quality-event-time">
              {formatNumber(groupDuration(group))} ms</span>
          </button>
          {group.events.length > 1 && <button type="button"
            className="power-quality-group-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${groupLabel(group)}`}
            aria-expanded={expanded} onClick={() => onToggleExpanded(group.id)}>
            <span aria-hidden="true">⌄</span>
          </button>}
        </div>
        {expanded && group.events.length > 1 &&
          <ul className="power-quality-subevents" aria-label={`${groupLabel(group)} events`}>
            {group.events.map((event) => <li key={event.event_id}
              className={selectedEventId === event.event_id ? 'selected' : ''}>
              {canDelete && <input type="checkbox"
                aria-label={`Select ${eventLabel(event.type)} ${event.affected_phases.join(', ')}`}
                checked={checkedEventIds.has(event.event_id)}
                onChange={() => onToggleChecked([event.event_id])} />}
              <button type="button" className="power-quality-subevent-main"
                onClick={() => onSelect(event.event_id)}>
                <strong>{eventLabel(event.type)}</strong>
                <small>{event.affected_phases.join(', ') || 'No phase'} · {event.lifecycle}</small>
                <span>{formatNumber(event.duration_ms)} ms</span>
              </button>
              {canDelete && <button type="button" className="power-quality-row-delete"
                aria-label={`Delete ${eventLabel(event.type)} ${event.affected_phases.join(', ')}`}
                onClick={() => onDelete([event])}>Delete</button>}
            </li>)}
          </ul>}
      </li>
    })}
  </ul>
}

function CaptureLink({ captureUuid, event, session, onViewWaveform }: {
  captureUuid: string
  event: PowerQualityEvent
  session: WaveformSession | undefined
  onViewWaveform: (filename: string) => void
}) {
  const materialized = session?.state === 'complete' && Boolean(session.filename)
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
    {materialized
      ? <div className="power-quality-capture-actions">
        <button type="button" onClick={() => onViewWaveform(session.filename)}>
          View waveform
        </button>
        <a href={waveformEventExportPath(session.id, event.event_id)} download>
          Download event MNCWF
        </a>
      </div>
      : <span className="power-quality-capture-pending">Materialization pending</span>}
  </article>
}

function EventDetail({ event, waveforms, canDelete, onDelete, onViewWaveform }: {
  event: PowerQualityEvent | undefined
  waveforms: WaveformStatus | undefined
  canDelete: boolean
  onDelete: (events: PowerQualityEvent[]) => void
  onViewWaveform: (filename: string) => void
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
      <div className="power-quality-detail-actions">
        <span className={`session-state ${event.lifecycle === 'abort' ? 'incomplete' : 'complete'}`}>
          {event.lifecycle}
        </span>
        {canDelete && <button type="button" className="power-quality-row-delete"
          onClick={() => onDelete([event])}>Delete event</button>}
      </div>
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
        session={sessionByCapture.get(captureUuid)} onViewWaveform={onViewWaveform} />)}
      {event.waveform_capture_uuids.length === 0 && <div className="power-quality-empty compact">
        <strong>No linked capture</strong><span>{event.waveform.enabled
          ? 'The capture coordinator has not linked a materialized session yet.'
          : 'Waveform capture was disabled in this event snapshot.'}</span>
      </div>}
    </section>
  </div>
}

interface PendingDeletion {
  events: PowerQualityEvent[]
  dialog: ConfirmDialogState
}

export function PowerQualityEventCatalogue({ onUnauthorized,
  canDelete = false }: {
  onUnauthorized: () => void
  canDelete?: boolean
}) {
  const [events, setEvents] = useState<PowerQualityEvent[]>([])
  const [waveforms, setWaveforms] = useState<WaveformStatus>()
  const [selectedEventId, setSelectedEventId] = useState<string>()
  const [checkedEventIds, setCheckedEventIds] = useState<ReadonlySet<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set())
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion>()
  const [deleting, setDeleting] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [error, setError] = useState('')
  const [loadingWaveform, setLoadingWaveform] = useState('')
  const [viewer, setViewer] = useState<{
    filename: string
    waveform: ParsedWaveform
  }>()

  const handleFailure = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return 'unauthorized'
    }
    return reason instanceof Error ? reason.message : fallback
  }, [onUnauthorized])

  const load = useCallback(async () => {
    const [nextEvents, nextWaveforms] = await Promise.allSettled([
      api.powerQualityEvents({ limit: 100 }), api.waveforms(),
    ])
    const failures: string[] = []
    if (nextEvents.status === 'fulfilled') {
      const available = new Set(nextEvents.value.events.map((event) => event.event_id))
      setEvents(nextEvents.value.events)
      setSelectedEventId((current) => current && available.has(current)
        ? current : nextEvents.value.events[0]?.event_id)
      setCheckedEventIds((current) => new Set(
        Array.from(current).filter((id) => available.has(id)),
      ))
    } else failures.push(handleFailure(nextEvents.reason, 'Unable to read event catalogue'))
    if (nextWaveforms.status === 'fulfilled') setWaveforms(nextWaveforms.value)
    else failures.push(handleFailure(nextWaveforms.reason, 'Unable to read waveform catalogue'))
    setError(failures.filter((failure) => failure !== 'unauthorized').join(' · '))
  }, [handleFailure])

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

  const groups = useMemo(() => groupOverlappingEvents(events), [events])
  const selectedEvent = useMemo(() => events.find(
    (event) => event.event_id === selectedEventId), [events, selectedEventId])
  const allSelected = events.length > 0 && events.every(
    (event) => checkedEventIds.has(event.event_id))

  function toggleChecked(eventIds: string[]) {
    setCheckedEventIds((current) => {
      const next = new Set(current)
      const remove = eventIds.every((id) => next.has(id))
      eventIds.forEach((id) => remove ? next.delete(id) : next.add(id))
      return next
    })
  }

  function toggleExpanded(groupId: string) {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (!next.delete(groupId)) next.add(groupId)
      return next
    })
  }

  function requestDeletion(targets: PowerQualityEvent[]) {
    if (targets.length === 0) return
    const names = targets.map((event) =>
      `${eventLabel(event.type)} (${event.affected_phases.join(', ') || 'no phase'})`)
    setDialogError('')
    setPendingDeletion({
      events: targets,
      dialog: {
        title: targets.length === 1
          ? `Delete ${eventLabel(targets[0].type)}?`
          : `Delete ${targets.length} power-quality events?`,
        description: 'The durable catalogue records and their evidence links will be removed. The shared MNCWF capture files are kept until waveform data is cleared separately.',
        confirmLabel: targets.length === 1 ? 'Delete event' : `Delete ${targets.length} events`,
        detail: names.join('\n'),
      },
    })
  }

  async function openWaveform(filename: string) {
    setLoadingWaveform(filename)
    setError('')
    try {
      const buffer = await api.waveformFile(filename)
      setViewer({ filename, waveform: parseWaveform(buffer) })
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to load event waveform')
    } finally {
      setLoadingWaveform('')
    }
  }

  async function confirmDeletion() {
    if (!pendingDeletion) return
    setDeleting(true)
    setDialogError('')
    try {
      const ids = pendingDeletion.events.map((event) => event.event_id)
      await api.deletePowerQualityEvents(ids)
      setCheckedEventIds((current) => {
        const next = new Set(current)
        ids.forEach((id) => next.delete(id))
        return next
      })
      setPendingDeletion(undefined)
      await load()
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setDialogError(reason instanceof Error ? reason.message : 'Unable to delete events')
    } finally {
      setDeleting(false)
    }
  }

  return <>
    {error && <div className="error-banner"><strong>Event evidence unavailable</strong>
      <span>{error}</span></div>}
    <section className="power-quality-events" aria-labelledby="event-catalogue-title">
      <header><div><p className="eyebrow">Power quality history</p>
        <h2 id="event-catalogue-title">Event catalogue</h2></div>
        <div className="power-quality-catalogue-tools">
          <span>{events.length} most recent events · {groups.length} incident{groups.length === 1 ? '' : 's'}</span>
          {canDelete && events.length > 0 && <>
            <label><input type="checkbox" checked={allSelected}
              onChange={() => toggleChecked(events.map((event) => event.event_id))} />Select all</label>
            <button type="button" className="power-quality-row-delete"
              disabled={checkedEventIds.size === 0}
              onClick={() => requestDeletion(events.filter(
                (event) => checkedEventIds.has(event.event_id)))}>
              Delete selected ({checkedEventIds.size})
            </button>
          </>}
        </div></header>
      <div className="power-quality-event-workspace">
        <EventTimeline groups={groups} selectedEventId={selectedEventId}
          checkedEventIds={checkedEventIds} expandedGroups={expandedGroups}
          canDelete={canDelete} onSelect={setSelectedEventId}
          onToggleExpanded={toggleExpanded} onToggleChecked={toggleChecked}
          onDelete={requestDeletion} />
        <EventDetail event={selectedEvent} waveforms={waveforms}
          canDelete={canDelete} onDelete={requestDeletion}
          onViewWaveform={(filename) => {
            if (loadingWaveform === '') void openWaveform(filename)
          }} />
      </div>
    </section>
    {loadingWaveform && <div className="power-quality-waveform-loading">
      Loading {loadingWaveform}…
    </div>}
    {viewer && <WaveformViewer key={viewer.filename}
      filename={viewer.filename} waveform={viewer.waveform}
      onClose={() => setViewer(undefined)} />}
    <ConfirmDialog state={pendingDeletion?.dialog} busy={deleting}
      error={dialogError} onCancel={() => {
        if (!deleting) setPendingDeletion(undefined)
      }} onConfirm={() => void confirmDeletion()} />
  </>
}
