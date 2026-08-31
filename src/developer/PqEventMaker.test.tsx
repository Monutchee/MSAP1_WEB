import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let PowerQualityPanel: typeof import('../App')['PowerQualityPanel']

beforeAll(async () => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
  ;({ PowerQualityPanel } = await import('../App'))
})

const profile = (threshold: number, hysteresis = 2) => ({
  enabled: true,
  threshold_percent: threshold,
  hysteresis_percent: hysteresis,
  phase_mask: 7,
  phase_policy: 'per_phase',
  waveform: {
    enabled: true, pretrigger_ms: 1000, posttrigger_ms: 1000, decimation: 1,
  },
})

const settings = {
  metering: {
    events: {
      reference_current_amperes: 5,
      voltage_sag: profile(90),
      voltage_swell: profile(113, 3),
      voltage_interruption: profile(10),
      rapid_voltage_change: profile(5),
      voltage_unbalance: profile(2),
      current_sag: profile(80),
      current_swell: profile(120),
      current_unbalance: profile(2),
      transient_voltage: profile(1),
    },
  },
}

const sequencer = {
  action: 'query',
  channels: 'voltage',
  scale_percent: 100,
  duration_half_cycles: 20,
  period_half_cycles: 200,
  repeat: false,
  armed: false,
  running: false,
  holding: false,
  completed: 0,
  remaining_half_cycles: 0,
  until_repeat_half_cycles: 0,
  simulator_active: true,
}

afterEach(() => vi.unstubAllGlobals())

describe('ADC simulator PQ Event maker', () => {
  it('turns a named interruption into one half-cycle-aligned simulator command', async () => {
    let command: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/adc/simulator/event') {
        if (init?.method === 'POST') command = JSON.parse(String(init.body))
        return new Response(JSON.stringify({
          ...sequencer,
          action: init?.method === 'POST' ? command?.action : 'query',
          armed: init?.method === 'POST',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.startsWith('/api/v1/meter/power-quality/events'))
        return new Response(JSON.stringify({
          limit: 5, count: 0, export_formats: ['mncwf'], events: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/v1/meter/power-quality')
        return new Response(JSON.stringify({
          running: true, records: 0, events: 0,
          has_latest: false, has_event: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/v1/settings/active')
        return new Response(JSON.stringify({ settings }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      throw new Error(`Unexpected request ${url}`)
    }))

    render(<PowerQualityPanel onUnauthorized={() => undefined} simulator={{
      frequency_hz: 60,
      preserve_phase: true,
      channels: [
        { channel: 4, rms: 120, phase_degrees: 120, dc: 0, noise_rms: 0 },
        { channel: 5, rms: 120, phase_degrees: 240, dc: 0, noise_rms: 0 },
        { channel: 6, rms: 120, phase_degrees: 0, dc: 0, noise_rms: 0 },
      ],
      harmonics: [],
      active_source: 'simulator',
      configuration_generation: 1,
      active_generation: 1,
      generated_frames: 0,
      saturation_count: 0,
      missed_sample_count: 0,
      healthy: true,
    }} />)

    const preset = await screen.findByLabelText('Disturbance preset')
    await screen.findByText('PL simulator active')
    fireEvent.change(preset, { target: { value: 'voltage_interruption' } })

    expect(screen.getByLabelText('Amplitude (% of configured RMS)')).toHaveValue(0)
    expect(screen.getByLabelText('Channels')).toHaveValue('voltage')
    expect(screen.getByText(/Va 0.000 V/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create PQ event' }))

    await waitFor(() => expect(command).toEqual({
      action: 'arm',
      channels: 'voltage',
      scale_percent: 0,
      duration_half_cycles: 20,
      period_half_cycles: 200,
      repeat: false,
    }))
    expect(await screen.findByText(/starts at the next half-cycle boundary/))
      .toBeInTheDocument()
  })
})
