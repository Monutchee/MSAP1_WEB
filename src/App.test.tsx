import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let Dashboard: typeof import('./App')['Dashboard']

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
  ;({ Dashboard } = await import('./App'))
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

const settings = {
  settings: {
    metering: {
      nominal_frequency_hz: 60,
      measurement_topology: 'wye',
      system_nominal_voltage_v: 120,
      frequency: { enabled: true },
      demand: { method: 'sliding', window_seconds: 60 },
    },
    adc: {
      source: 'physical',
      simulator: { frequency_hz: 60, preserve_phase: true, channels: [], harmonics: [] },
    },
  },
}

function health(recordStale = false) {
  return {
    healthy: !recordStale,
    acquisition: {
      running: true, record_available: true, record_stale: recordStale,
      record_age_ms: recordStale ? 5000 : 10, configuration_generation: 7,
    },
    adc: { source: 'unknown' },
    aggregation: {},
    frequency_arithmetic_ok: true,
    backend_running: true,
    nginx_running: true,
  }
}

const readings = {
  sequence: 1, configuration_generation: 7, sample_rate_hz: 128_000,
  block_sample_count: 25_600, status: 0, capture_frames: 1,
  header_errors: 0, fifo_overflows: 0, emit_drops: 0, result_drops: 0,
  record_complete: true, channels: [], attributes: [],
  frequency: {
    enabled: true, valid: true, reference_valid: true, out_of_range: false,
    timed_out: false, arithmetic_error: false, hz: 49.998, millihz: 49_998,
  },
  timing: {
    block_sequence: 1, first_sample_index: 1, sample_count: 25_600,
    cycle_count: 12, nominal_frequency_hz: 60, cycle_locked: true,
    free_run_fallback: false, time_quality: 'synchronized',
  },
}

describe('dashboard startup readiness', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('warns during startup, suppresses live polling, resumes automatically, and clears stale values', async () => {
    vi.useFakeTimers()
    let mode: 'starting' | 'ready' | 'stale' = 'starting'
    let meterRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/health') {
        if (mode === 'starting') return json({
          error: 'Metering service is starting or recovering.',
          code: 'system_not_ready', retryable: true,
        }, 503)
        return json(health(mode === 'stale'))
      }
      if (url === '/api/v1/settings/active') return json(settings)
      if (url === '/api/v1/adc/source') return json({
        source: 'physical', configuration_generation: 7, active: true, healthy: true,
      })
      if (url === '/api/v1/adc/simulator') return json({
        active_source: 'physical', configuration_generation: 7,
        active_generation: 0, generated_frames: 0, saturation_count: 0,
        missed_sample_count: 0, healthy: true, channels: [], harmonics: [],
      })
      if (url === '/api/v1/meter/readings') {
        ++meterRequests
        return json(readings)
      }
      throw new Error(`Unexpected request ${url}`)
    }))

    render(<Dashboard session={{ username: 'admin', role: 'admin' }}
      onLogout={() => undefined} onUnauthorized={() => undefined} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('System initializing or recovering')).toBeInTheDocument()
    expect(meterRequests).toBe(0)

    mode = 'ready'
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.queryByText('System initializing or recovering')).not.toBeInTheDocument()
    expect(screen.getByText('System healthy')).toBeInTheDocument()
    expect(meterRequests).toBeGreaterThan(0)
    expect(screen.getByText('49.998')).toBeInTheDocument()

    mode = 'stale'
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText('System needs attention')).toBeInTheDocument()
    expect(screen.queryByText('49.998')).not.toBeInTheDocument()
    const stoppedAt = meterRequests
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(meterRequests).toBe(stoppedAt)
  })

  it('shows both exact documentation downloads to a Viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/health') return json(health())
      if (url === '/api/v1/settings/active') return json(settings)
      if (url === '/api/v1/adc/source') return json({
        source: 'physical', configuration_generation: 7, active: true, healthy: true,
      })
      if (url === '/api/v1/adc/simulator') return json({
        active_source: 'physical', configuration_generation: 7,
        active_generation: 0, generated_frames: 0, saturation_count: 0,
        missed_sample_count: 0, healthy: true, channels: [], harmonics: [],
      })
      if (url === '/api/v1/meter/readings') return json(readings)
      if (url === '/api/v1/about') return json({
        product: 'MSAP1', operating_system: 'MNCOS',
        yocto_system_version: 'test', build_hex: 'abc123',
        software_build_date: '2026-09-01', image_recipe: 'msap1-image',
        machine: 'msap1',
      })
      throw new Error(`Unexpected request ${url}`)
    }))

    render(<Dashboard session={{ username: 'viewer', role: 'viewer' }}
      onLogout={() => undefined} onUnauthorized={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'About' }))

    const yaml = await screen.findByRole('link', {
      name: /Download OpenAPI YAML/,
    })
    const xlsx = screen.getByRole('link', {
      name: /Download Modbus registers XLSX/,
    })
    expect(yaml).toHaveAttribute('href',
      '/api/v1/documentation/msap1_api.yaml')
    expect(yaml).toHaveAttribute('download', 'msap1_api.yaml')
    expect(xlsx).toHaveAttribute('href',
      '/api/v1/documentation/msap1_modbus_registers.xlsx')
    expect(xlsx).toHaveAttribute('download', 'msap1_modbus_registers.xlsx')
    await waitFor(() => expect(screen.getByText('abc123')).toBeInTheDocument())
  })
})
