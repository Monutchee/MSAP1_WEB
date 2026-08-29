import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PowerQualityEvent } from '../api'
import { overlappingEventCount, PowerQualityView } from './PowerQualityView'

const firstEventId = '12345678-1234-5234-9234-1234567890ab'
const secondEventId = 'abcdefab-cdef-5def-8def-abcdefabcdef'
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
    sample_rate_hz: 32_000,
    first_sample,
    last_sample,
    trigger_sample: first_sample,
    duration_samples: last_sample - first_sample + 1,
    duration_ms: ((last_sample - first_sample + 1) / 32_000) * 1000,
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
    start_utc_nanoseconds: 1_787_933_000_000_000_000,
    last_utc_nanoseconds: 1_787_933_001_000_000_000,
    utc_uncertainty_nanoseconds: 250_000,
    settings_digest: '1234567890abcdef1234567890abcdef',
    waveform: { enabled: true, pretrigger_ms: 3000, posttrigger_ms: 3000, decimation: 1 },
    waveform_capture_uuids: event_id === firstEventId
      ? [masterCapture, continuationCapture] : [],
  }
}

const events = [event(firstEventId, 100, 220), event(secondEventId, 180, 300)]

const phase = (name: string, values: { pinst: number; pst: number; plt: number }) => ({
  phase: name, valid: true, ...values, valid_internal_samples: 320,
})

function response(input: RequestInfo | URL) {
  const url = input.toString()
  if (url.startsWith('/api/v1/meter/power-quality/events')) {
    return { limit: 100, count: events.length, export_formats: ['mncwf'], events }
  }
  if (url === '/api/v1/meter/flicker') {
    const record = (kind: 'live' | 'pst' | 'plt') => ({
      kind, sequence: 1, configuration_generation: 2, profile_generation: 3,
      sample_rate_hz: 32_000, first_sample: 1, last_sample: 320,
      sample_count: 320, interval_seconds: kind === 'live' ? 1 : 600,
      lamp_voltage: 120, nominal_frequency_hz: 60, status: 0, source_status: 0,
      phases: [phase('A', { pinst: .421, pst: .812, plt: .734 }),
        phase('B', { pinst: .422, pst: .813, plt: .735 }),
        phase('C', { pinst: .423, pst: .814, plt: .736 })],
    })
    return { running: true, records: 12, sequence_gaps: 0,
      live: record('live'), pst: record('pst'), plt: record('plt') }
  }
  if (url === '/api/v1/meter/mains-signalling') {
    return {
      running: true, records: 7, sequence_gaps: 0, available: true,
      sequence: 2, configuration_generation: 2, profile_generation: 3,
      sample_rate_hz: 32_000, first_sample: 1, last_sample: 6400, sample_count: 6400,
      configured_hz: 1000, measured_hz: 999.875, bandwidth_hz: 20,
      observation_ms: 200, threshold_percent: 2.5, reference_volts: 120,
      status: 0, source_status: 0,
      phases: ['A', 'B', 'C'].map((name, index) => ({
        phase: name, valid: true, detected: index === 0,
        magnitude_volts: .12 + index * .01, background_volts: .02,
      })),
    }
  }
  if (url === '/api/v1/waveforms') {
    const base = {
      state: 'complete' as const, trigger_sequence: 150, first_sequence: 1,
      last_sequence: 300, trigger_tai_nanoseconds: 0,
      trigger_realtime_nanoseconds: 1_787_933_000_000_000_000,
      sample_rate_hz: 32_000, event_count: 1, decimation: 1,
    }
    return {
      running: true, active_session: false, sample_rate_hz: 32_000,
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
  throw new Error(`Unexpected request: ${url}`)
}

afterEach(() => vi.unstubAllGlobals())

describe('Power-quality reading workspace', () => {
  it('marks overlapping events and links master/continuation MNCWF evidence', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(response(input)), { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(<PowerQualityView onUnauthorized={() => undefined} />)

    expect(await screen.findByText('0.421')).toBeInTheDocument()
    expect(screen.getByText('999.875 Hz')).toBeInTheDocument()
    expect(screen.getAllByText('Overlaps 1 event')).toHaveLength(2)
    expect(await screen.findByText(firstEventId)).toBeInTheDocument()
    expect(screen.getByText('Master segment')).toBeInTheDocument()
    expect(screen.getByText('After session 7')).toBeInTheDocument()
    const downloads = screen.getAllByRole('link', { name: 'Download event MNCWF' })
    expect(downloads).toHaveLength(2)
    expect(downloads[0]).toHaveAttribute('href',
      `/api/v1/waveforms/export?session_id=7&event_id=${firstEventId}&format=mncwf`)

    fireEvent.click(screen.getByRole('button', { name: /Current Swell/ }))
    expect(screen.getByText(secondEventId)).toBeInTheDocument()
    expect(screen.getByText('MSAP1 product alarm')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(fetchMock.mock.calls.every(([input]) => input.toString().startsWith('/api/v1/'))).toBe(true)
  })

  it('uses inclusive sample windows for overlap markers', () => {
    const touching = event(secondEventId, 220, 230)
    expect(overlappingEventCount(events[0], [events[0], touching])).toBe(1)
    const separate = event(secondEventId, 221, 230)
    expect(overlappingEventCount(events[0], [events[0], separate])).toBe(0)
  })
})
