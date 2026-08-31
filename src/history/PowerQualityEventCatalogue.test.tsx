import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PowerQualityEvent } from '../api'
import {
  groupOverlappingEvents, overlappingEventCount, PowerQualityEventCatalogue,
} from './PowerQualityEventCatalogue'

const firstEventId = '12345678-1234-5234-9234-1234567890ab'
const secondEventId = 'abcdefab-cdef-5def-8def-abcdefabcdef'
const thirdEventId = '99999999-9999-4999-8999-999999999999'
const masterCapture = '11111111-1111-4111-8111-111111111111'
const continuationCapture = '22222222-2222-4222-8222-222222222222'

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
    waveform_capture_uuids: event_id === firstEventId
      ? [masterCapture, continuationCapture] : [],
  }
}

const events = [event(firstEventId, 100, 220), event(secondEventId, 180, 300)]

function waveformResponse() {
  const base = {
    state: 'complete' as const, trigger_sequence: 150, first_sequence: 1,
    last_sequence: 300, trigger_tai_nanoseconds: 0,
    trigger_realtime_nanoseconds: 1_787_933_000_000_000_000,
    sample_rate_hz: 128_000, event_count: 1, origin: 'power_quality' as const,
    decimation: 8,
  }
  return {
    running: true, active_session: false, sample_rate_hz: 128_000,
    transport_ring_blocks: 32, blocks: 1, frames: 320, bytes: 10240,
    invalid_blocks: 0, sequence_gaps: 0, transport_overrun_blocks: 0,
    materialization_failures: 0, pl_dropped_frames: 0, max_capture_frames: 1_000_000,
    history_oldest_sequence: 1, history_latest_sequence: 320,
    history_capacity_frames: 1_000_000, completed_sessions: 2,
    incomplete_sessions: 0, export_formats: ['mncwf'],
    sessions: [
      { ...base, id: 7, filename: 'master.mncwf', continuation_of_session_id: 0,
        master_session_id: 7, capture_uuid: masterCapture },
      { ...base, id: 8, filename: 'continuation.mncwf', continuation_of_session_id: 7,
        master_session_id: 7, capture_uuid: continuationCapture },
    ],
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Power-quality event catalogue', () => {
  it('groups one overlap incident and keeps event evidence in the shared viewer', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.startsWith('/api/v1/meter/power-quality/events'))
        return new Response(JSON.stringify({
          limit: 100, count: events.length, export_formats: ['mncwf'], events,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/v1/waveforms')
        return new Response(JSON.stringify(waveformResponse()), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
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
    const views = screen.getAllByRole('button', { name: 'View waveform' })
    expect(views).toHaveLength(2)
    fireEvent.click(views[0])
    expect(await screen.findByText(/Invalid header range in waveform file/))
      .toBeInTheDocument()

    const downloads = screen.getAllByRole('link', { name: 'Download event MNCWF' })
    expect(downloads[0]).toHaveAttribute('href',
      `/api/v1/waveforms/export?session_id=7&event_id=${firstEventId}&format=mncwf`)
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
        return new Response(JSON.stringify({ limit: 100, count: currentEvents.length,
          export_formats: ['mncwf'], events: currentEvents }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      if (url === '/api/v1/waveforms')
        return new Response(JSON.stringify(waveformResponse()), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
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
