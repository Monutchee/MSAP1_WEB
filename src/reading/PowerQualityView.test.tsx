import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PowerQualityView } from './PowerQualityView'

const flickerPhase = (phase: string, value: number) => ({
  phase, valid: true, pinst: value, pst: value + .1, plt: value + .2,
  valid_internal_samples: 320,
})

function response(input: RequestInfo | URL) {
  const url = input.toString()
  if (url === '/api/v1/meter/flicker') {
    const record = (kind: 'live' | 'pst' | 'plt') => ({
      kind, sequence: 1, configuration_generation: 2, profile_generation: 3,
      sample_rate_hz: 128_000, first_sample: 1, last_sample: 320,
      sample_count: 320, interval_seconds: kind === 'live' ? 1 : 600,
      lamp_voltage: 120, nominal_frequency_hz: 60, status: 0, source_status: 0,
      phases: [flickerPhase('A', .421), flickerPhase('B', .422), flickerPhase('C', .423)],
    })
    return { running: true, records: 12, sequence_gaps: 0,
      live: record('live'), pst: record('pst'), plt: record('plt') }
  }
  if (url === '/api/v1/meter/mains-signalling') return {
    running: true, records: 7, sequence_gaps: 0, available: true,
    sequence: 2, configuration_generation: 2, profile_generation: 3,
    sample_rate_hz: 128_000, first_sample: 1, last_sample: 6400, sample_count: 6400,
    configured_hz: 1000, measured_hz: 999.875, bandwidth_hz: 20,
    observation_ms: 200, threshold_percent: 2.5, reference_volts: 120,
    status: 0, source_status: 0,
    phases: ['A', 'B', 'C'].map((phase, index) => ({
      phase, valid: true, detected: index === 0,
      magnitude_volts: .12 + index * .01, background_volts: .02,
    })),
  }
  if (url === '/api/v1/meter/power-quality') {
    const record = {
      kind: 'periodic', event_type: 'none', affected_phases: [], sequence: 4,
      event_sequence: 0, first_sample: 1, last_sample: 1067, sample_count: 1067,
      half_cycle_updates: 1, duration_samples: 0, duration_ms: 0, armed: true,
      cycle_locked: true, synthetic_half_cycle: false, reference_volts: 120,
      sag_percent: 90, swell_percent: 110, interruption_percent: 10,
      hysteresis_percent: 2,
      phases: ['A', 'B', 'C'].map((phase, index) => ({
        phase, urms_half: 120 + index, urms_half_minimum: 119 + index,
        urms_half_maximum: 121 + index, irms_half: 5 + index, quality: 1,
      })),
    }
    return { running: true, records: 44, events: 2, has_latest: true,
      has_event: false, latest: record, event: record }
  }
  throw new Error(`Unexpected request: ${url}`)
}

afterEach(() => vi.unstubAllGlobals())

describe('Power-quality reading workspace', () => {
  it('separates flicker, mains signal, and live PQ Event products into tabs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(response(input)), { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(<PowerQualityView onUnauthorized={() => undefined} />)

    expect(await screen.findByText('0.421')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Flicker/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText('999.875 Hz')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Mains signal/ }))
    expect(await screen.findByText('999.875 Hz')).toBeInTheDocument()
    expect(screen.queryByText('0.421')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /PQ Event/ }))
    expect((await screen.findAllByText('120 V')).length).toBeGreaterThan(0)
    expect(screen.getByText('44')).toBeInTheDocument()
    expect(screen.getByText(/History → PQ Event catalogue/)).toBeInTheDocument()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(fetchMock.mock.calls.every(([input]) => input.toString().startsWith('/api/v1/'))).toBe(true)
  })
})
