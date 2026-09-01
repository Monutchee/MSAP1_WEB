import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MeterFrequency10sResult } from '../api'
import { Frequency10sPanel } from './Frequency10sPanel'

function result(overrides: Partial<MeterFrequency10sResult> = {}): MeterFrequency10sResult {
  return {
    available: true,
    sequence: 77,
    configuration_generation: 12,
    valid: true,
    quality: 'valid',
    frequency_hz: 50.001,
    frequency_millihz: 50_001,
    time_quality: 'synchronized',
    age_ms: 125,
    first_sample_index: '9007199254740000',
    interval_end_sample_index: '9007199256020000',
    sample_count: 1_280_000,
    sample_rate_hz: 128_000,
    measured_sample_rate_millihz: 128_000_125,
    cycle_count: 500,
    utc_start_nanoseconds: '1788000200000000000',
    utc_end_nanoseconds: '1788000210000000000',
    utc_uncertainty_nanoseconds: '250',
    source_sequence: 77,
    boundary_generation: 9,
    source_status: 0x61f,
    source_status_flags: [
      'boundary_valid', 'time_synchronized', 'sample_rate_valid',
      'filter_ready', 'reference_valid', 'calibration_valid', 'profile_supported',
    ],
    status: 0x60fe,
    status_flags: [
      'result_valid', 'time_aligned', 'profile_supported', 'time_synchronized',
      'filter_ready', 'reference_valid', 'calibration_valid', 'sample_rate_valid',
    ],
    reasons: 0,
    rejection_reasons: [],
    observer_drop_count: 0,
    guard_flags: 0x0c,
    guard_flag_names: ['exact_start', 'exact_end'],
    observed_crossings: 501,
    included_crossings: 501,
    rejected_cycles: 0,
    duration_q16_samples: '83886080000',
    first_crossing_q16_samples: '590295760316989440000',
    last_crossing_q16_samples: '590295844203069440000',
    nominal_frequency_hz: 50,
    reference_channel: 6,
    filter_profile: 1,
    calibration_profile: 1,
    ...overrides,
  }
}

describe('IEC ten-second frequency presentation', () => {
  it('shows a valid value with exact audit anchors beyond Number precision', () => {
    const current = result()
    render(<Frequency10sPanel frequency={current} history={[current]} />)

    expect(screen.getByText('Latest completed interval').parentElement)
      .toHaveTextContent('50.001 Hz')
    expect(screen.getByText('Valid result')).toBeInTheDocument()
    expect(screen.getByText('9,007,199,254,740,000')).toBeInTheDocument()
    expect(screen.getByText('to 9,007,199,256,020,000')).toBeInTheDocument()
    expect(screen.getAllByText(/\.000000000Z$/)).toHaveLength(2)
    expect(screen.getByText('uncertainty 250 ns')).toBeInTheDocument()
  })

  it('never displays a zero measurement for an invalid completed interval', () => {
    const invalid = result({
      valid: false,
      quality: 'out_of_range',
      frequency_hz: undefined,
      frequency_millihz: undefined,
      reasons: 1 << 12,
      rejection_reasons: ['out_of_range'],
      status_flags: ['time_aligned', 'out_of_range'],
    })
    render(<Frequency10sPanel frequency={invalid} />)

    expect(screen.getByText('Rejected interval')).toBeInTheDocument()
    expect(screen.getByText('Outside the accepted frequency range')).toBeInTheDocument()
    const rejection = screen.getByText('No numeric frequency published').parentElement
    expect(rejection).toHaveTextContent(
      'Result quality: Outside the accepted frequency range')
    const latest = screen.getByText('Latest completed interval').parentElement
    expect(latest).toHaveTextContent('— Hz')
    expect(latest).not.toHaveTextContent('0.000 Hz')
  })

  it('treats an unavailable snapshot as normal interval startup', () => {
    render(<Frequency10sPanel frequency={{ available: false }} />)

    expect(screen.getByText('Waiting for interval')).toBeInTheDocument()
    expect(screen.getByText(/first result appears after a complete/i)).toBeInTheDocument()
    expect(screen.queryByText('No numeric frequency published')).not.toBeInTheDocument()
  })
})
