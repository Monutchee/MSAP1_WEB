import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PowerQualityEvent, WaveformSessionLookup } from '../api'
import {
  groupOverlappingEvents, overlappingEventCount, PowerQualityEventCatalogue,
} from './PowerQualityEventCatalogue'

const firstEventId = '12345678-1234-5234-9234-1234567890ab'
const secondEventId = 'abcdefab-cdef-5def-8def-abcdefabcdef'
const thirdEventId = '99999999-9999-4999-8999-999999999999'
const masterCapture = '11111111-1111-4111-8111-111111111111'
const continuationCapture = '22222222-2222-4222-8222-222222222222'
const pendingCapture = '33333333-3333-4333-8333-333333333333'
const locatingCapture = '44444444-4444-4444-8444-444444444444'
const unavailableCapture = '55555555-5555-4555-8555-555555555555'

function event(event_id: string, first_sample: number, last_sample: number): PowerQualityEvent {
  return {
    event_id,
    source_session: 4,
    source_counter: 9,
    lifecycle: 'end',
    type: event_id === firstEventId ? 'voltage_sag' : 'current_swell',
    taxonomy: event_id === firstEventId ? 'iec_61000_4_30' : 'msap1_product_alarm',
    affected_phases: ['A', 'B'],
    trigger_source: 1,
    sequence: 17,
    configuration_generation: 2,
    profile_generation: 3,
    sample_rate_hz: 128_000,
    first_sample,
    last_sample,
    trigger_sample: first_sample,
    duration_samples: last_sample - first_sample + 1,
    duration_ms: ((last_sample - first_sample + 1) / 128_000) * 1000,
    threshold_e4: 9000,
    hysteresis_e4: 200,
    reference_micro_units: 120_000_000,
    minimum_micro_units: [80_000_000, 81_000_000, 120_000_000],
    maximum_micro_units: [120_000_000, 121_000_000, 120_000_000],
    current_micro_units: [110_000_000, 111_000_000, 120_000_000],
    per_phase: true,
    status: 0,
    valid_mask: 7,
    discontinuities: 0,
    update_count: 2,
    time_quality: 'synchronized',
    start_utc_nanoseconds: 1_787_933_000_000_000_000 + first_sample,
    last_utc_nanoseconds: 1_787_933_000_000_000_000 + last_sample,
    utc_uncertainty_nanoseconds: 250_000,
    settings_digest: '1234567890abcdef1234567890abcdef',
    waveform: { enabled: true, pretrigger_ms: 3000, posttrigger_ms: 3000, decimation: 8 },
    waveform_capture_count: event_id === firstEventId ? 2 : 0,
    waveform_capture_uuids: event_id === firstEventId
      ? [masterCapture, continuationCapture] : [],
  }
}

const events = [event(firstEventId, 100, 220), event(secondEventId, 180, 300)]

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

function eventResponse(url: string, source: PowerQualityEvent[]) {
  const request = new URL(url, 'http://msap1.test')
  const eventId = request.searchParams.get('event_id')
  const selected = eventId
    ? source.filter((candidate) => candidate.event_id === eventId)
    : source.map((candidate) => ({
      ...candidate,
      waveform_capture_uuids: [],
    }))
  return json({
    limit: eventId ? 1 : 100,
    count: selected.length,
    export_formats: ['mncwf'],
    events: selected,
  })
}

function waveformLookup(capture_uuid: string, id: number,
  state: 'capturing' | 'complete' | 'incomplete' = 'complete',
  filename = `${id}.mncwf`): WaveformSessionLookup {
  return {
    capture_uuid,
    archive_discovery: {
      state: 'complete', scanned_files: 20, total_files: 20, rejected_files: 0,
    },
    session: {
      state, trigger_sequence: 150, first_sequence: 1,
      last_sequence: 300, trigger_tai_nanoseconds: 0,
      trigger_realtime_nanoseconds: 1_787_933_000_000_000_000,
      sample_rate_hz: 128_000, event_count: 1, origin: 'power_quality' as const,
      decimation: 8,
      id, filename, continuation_of_session_id: id === 8 ? 7 : 0,
      master_session_id: id === 8 ? 7 : id, capture_uuid,
      format_version: 5, compression: 'zstd_chunks', stored_bytes: 1024,
      logical_sample_bytes: 2048,
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Power-quality event catalogue', () => {
  it('groups one overlap incident and keeps event evidence in the shared viewer', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.startsWith('/api/v1/meter/power-quality/events'))
        return eventResponse(url, events)
      if (url === '/api/v1/waveforms/sessions/lookup' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { capture_uuids: string[] }
        return json({
          archive_discovery: {
            state: 'complete', scanned_files: 20, total_files: 20, rejected_files: 0,
          },
          sessions: request.capture_uuids.map((uuid) => uuid === masterCapture
            ? waveformLookup(uuid, 7, 'complete', 'master.mncwf').session
            : waveformLookup(uuid, 8, 'complete', 'continuation.mncwf').session),
        })
      }
      if (url === '/protected/waveforms/view/master.mncwf')
        return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PowerQualityEventCatalogue onUnauthorized={() => undefined} />)

    expect(await screen.findByText(firstEventId)).toBeInTheDocument()
    expect(screen.getByText(/2 most recent events · 1 incident/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand Overlapping PQ incident' }))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Overlapping PQ incident' }))
    fireEvent.click(screen.getByRole('button', { name: /Current Swell/ }))
    expect(screen.getByText(secondEventId)).toBeInTheDocument()
    expect(screen.getByText('MSAP1 product alarm')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Voltage Sag/ }))
    const views = await screen.findAllByRole('button', { name: 'View waveform' })
    expect(views).toHaveLength(2)
    fireEvent.click(views[0])
    expect(await screen.findByText(/Invalid header range in waveform file/))
      .toBeInTheDocument()

    const downloads = screen.getAllByRole('link', { name: 'Download event MNCWF' })
    expect(downloads[0]).toHaveAttribute('href',
      `/api/v1/waveforms/export?session_id=7&event_id=${firstEventId}&format=mncwf`)
    const batchCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input) === '/api/v1/waveforms/sessions/lookup')
    expect(batchCalls.length).toBeGreaterThan(0)
    expect(batchCalls.length).toBeLessThanOrEqual(2)
    batchCalls.forEach((call) => expect(
      JSON.parse(String(call[1]?.body)).capture_uuids,
    ).toEqual([masterCapture, continuationCapture]))
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).startsWith('/api/v1/waveforms/session?'))).toBe(false)
  })

  it('bounds a 1,316-link event to one detail and on-demand batches', async () => {
    const captureUuids = Array.from({ length: 1316 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
    const linkedEvent = {
      ...event(firstEventId, 100, 220),
      waveform_capture_count: captureUuids.length,
      waveform_capture_uuids: captureUuids,
    }
    const batches: string[][] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL,
      init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/v1/meter/power-quality/events'))
        return eventResponse(url, [linkedEvent])
      if (url === '/api/v1/waveforms/sessions/lookup' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { capture_uuids: string[] }
        batches.push(body.capture_uuids)
        return json({
          archive_discovery: {
            state: 'complete', scanned_files: 1316, total_files: 1316,
            rejected_files: 0,
          },
          sessions: body.capture_uuids.map(() => null),
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PowerQualityEventCatalogue onUnauthorized={() => undefined} />)
    const more = await screen.findByRole('button', {
      name: 'Load 25 more (1291 remaining)',
    })
    await waitFor(() => expect(batches).toHaveLength(1))
    expect(batches[0]).toHaveLength(25)
    expect(await screen.findAllByText('Waveform expired from archive'))
      .toHaveLength(25)
    const eventCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/v1/meter/power-quality/events'))
    expect(eventCalls.filter(([input]) => {
      const query = new URL(String(input), 'http://msap1.test').searchParams
      return !query.has('event_id') && query.get('include_waveform_links') === 'false'
    })).toHaveLength(1)
    expect(eventCalls.filter(([input]) => {
      const query = new URL(String(input), 'http://msap1.test').searchParams
      return query.get('event_id') === firstEventId &&
        query.get('include_waveform_links') === 'true'
    })).toHaveLength(1)
    fireEvent.click(more)
    await waitFor(() => expect(batches).toHaveLength(2))
    expect(batches[1]).toEqual(captureUuids.slice(25, 50))
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(32)
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).startsWith('/api/v1/waveforms/session?'))).toBe(false)
  })

  it('distinguishes materializing, locating, and unavailable linked captures', async () => {
    const linkedEvent = {
      ...event(firstEventId, 100, 220),
      waveform_capture_uuids: [
        masterCapture, pendingCapture, locatingCapture, unavailableCapture,
      ],
      waveform_capture_count: 4,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.startsWith('/api/v1/meter/power-quality/events'))
        return eventResponse(url, [linkedEvent])
      if (url === '/api/v1/waveforms/sessions/lookup' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { capture_uuids: string[] }
        return json({
          archive_discovery: {
            state: 'scanning', scanned_files: 4, total_files: 20, rejected_files: 0,
          },
          sessions: request.capture_uuids.map((uuid) => {
            if (uuid === masterCapture)
              return waveformLookup(uuid, 7, 'complete', 'master.mncwf').session
            if (uuid === pendingCapture)
              return waveformLookup(uuid, 9, 'capturing', '').session
            if (uuid === unavailableCapture)
              return waveformLookup(uuid, 10, 'incomplete', '').session
            return null
          }),
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))

    render(<PowerQualityEventCatalogue onUnauthorized={() => undefined} />)

    expect(await screen.findByRole('button', { name: 'View waveform' }))
      .toBeInTheDocument()
    expect(screen.getByText('Materialization pending')).toBeInTheDocument()
    expect(screen.getByText('Locating capture')).toBeInTheDocument()
    expect(screen.getByText('Linked waveform unavailable')).toBeInTheDocument()
  })

  it('uses transitive inclusive windows for incident grouping', () => {
    const touching = event(secondEventId, 220, 230)
    expect(overlappingEventCount(events[0], [events[0], touching])).toBe(1)
    const separate = event(secondEventId, 221, 230)
    expect(overlappingEventCount(events[0], [events[0], separate])).toBe(0)
    const bridge = event(secondEventId, 200, 250)
    const tail = event(thirdEventId, 240, 320)
    expect(groupOverlappingEvents([events[0], bridge, tail])).toHaveLength(1)
  })

  it('confirms an individual deletion before calling the admin API', async () => {
    let currentEvents = [...events]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.startsWith('/api/v1/meter/power-quality/events') &&
          init?.method === 'DELETE') {
        const body = JSON.parse(String(init.body)) as { event_ids: string[] }
        currentEvents = currentEvents.filter((candidate) =>
          !body.event_ids.includes(candidate.event_id))
        return new Response(JSON.stringify({ deleted: body.event_ids.length }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.startsWith('/api/v1/meter/power-quality/events'))
        return eventResponse(url, currentEvents)
      if (url === '/api/v1/waveforms/sessions/lookup' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { capture_uuids: string[] }
        return json({
          archive_discovery: {
            state: 'complete', scanned_files: 20, total_files: 20, rejected_files: 0,
          },
          sessions: request.capture_uuids.map((uuid, index) =>
            waveformLookup(uuid, 7 + index, 'complete',
              index === 0 ? 'master.mncwf' : 'continuation.mncwf').session),
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PowerQualityEventCatalogue canDelete onUnauthorized={() => undefined} />)

    expect(await screen.findByText(firstEventId)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Delete Voltage Sag?' }))
      .toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete event' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(
      ([, init]) => init?.method === 'DELETE')).toBe(true))
  })
})
