import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PowerQualityConfiguration } from './PowerQualityConfiguration'

const profile = (enabled = true) => ({
  enabled,
  threshold_percent: 90,
  hysteresis_percent: 2,
  phase_mask: 7,
  phase_policy: 'per_phase',
  waveform: { enabled: true, pretrigger_ms: 3000, posttrigger_ms: 3000, decimation: 8 },
})

const product = {
  schema_version: 8,
  metering: {
    sample_rate_hz: 128_000,
    unrelated_meter_setting: 'preserve-me',
    events: {
      reference_current_amperes: 5,
      voltage_sag: profile(),
      voltage_swell: profile(),
      voltage_interruption: profile(),
      rapid_voltage_change: profile(),
      voltage_unbalance: profile(false),
      current_sag: profile(false),
      current_swell: profile(false),
      current_unbalance: profile(false),
      transient_voltage: profile(false),
    },
    flicker: {
      enabled: true, phase_mask: 7, lamp_voltage: 120,
      live_cadence_ms: 1000, pst_interval_seconds: 600, plt_pst_count: 12,
    },
    mains_signalling: {
      enabled: false, carrier_frequency_hz: 1000, bandwidth_hz: 20,
      observation_ms: 200, phase_mask: 7, threshold_percent: 2,
    },
  },
  waveform: {
    default_pretrigger_ms: 1000, default_posttrigger_ms: 2000, default_decimation: 2,
    archive_limit_gib: 8,
    station_id: '', station_name: '', site_id: '', site_name: '',
    circuit_id: '', circuit_name: '', device_serial: '', calibration_id: '',
    calibration_status: 'unknown',
  },
  database: { sentinel: 'keep-database-settings' },
  modbus: { sentinel: 'keep-modbus-settings' },
  mqtt: { sentinel: 'keep-mqtt-settings' },
  adc: { sentinel: 'keep-adc-settings' },
}

afterEach(() => vi.unstubAllGlobals())

describe('Power-quality configuration', () => {
  it('saves typed M18 policy without overwriting unrelated active settings', async () => {
    let saved: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        saved = JSON.parse(String(init.body)) as Record<string, unknown>
        return new Response(JSON.stringify({
          content_hash: 'saved', recovery_mode: false, recovery_reason: '', settings: saved,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        content_hash: 'active', recovery_mode: false, recovery_reason: '',
        settings: structuredClone(product),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PowerQualityConfiguration onUnauthorized={() => undefined} />)

    const flickerTab = await screen.findByRole('tab', { name: /Flicker/ })
    expect(flickerTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByLabelText('Carrier frequency (Hz)')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Mains signal/ }))
    const carrier = await screen.findByLabelText('Carrier frequency (Hz)')
    fireEvent.change(carrier, { target: { value: '1175.5' } })
    fireEvent.click(screen.getByRole('tab', { name: /PQ Event profiles/ }))
    expect(await screen.findByText('Voltage sag')).toBeInTheDocument()
    expect(screen.getAllByLabelText(/Decimation/)[0]).toHaveValue('8')
    expect(screen.getAllByRole('option', { name: '÷ 8 — 16,000 samples/s' })).toHaveLength(9)
    fireEvent.change(screen.getByLabelText('Station ID'), { target: { value: 'STN-04' } })
    fireEvent.change(screen.getByLabelText(/Waveform archive limit \(GiB\)/), {
      target: { value: '12' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply and save' }))

    expect(await screen.findByText(/updated profile generation/)).toBeInTheDocument()
    await waitFor(() => expect(saved).toBeDefined())
    const body = saved as typeof product
    expect(body.metering.mains_signalling.carrier_frequency_hz).toBe(1175.5)
    expect(body.waveform.station_id).toBe('STN-04')
    expect(body.waveform.default_decimation).toBe(2)
    expect(body.waveform.archive_limit_gib).toBe(12)
    expect(body.database.sentinel).toBe('keep-database-settings')
    expect(body.metering.unrelated_meter_setting).toBe('preserve-me')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
