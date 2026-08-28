import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MeterReadingAttribute, MeterReadings } from '../api'
import { ReadingPage } from './ReadingPage'

function reading(key: string, sequence: number): MeterReadingAttribute {
  const units: Record<string, string> = {
    'power.active.total': 'W',
    'power.reactive.total': 'var',
    'power.apparent.total': 'VA',
    'power.factor.total': 'PF',
  }
  const values: Record<string, number> = {
    'sequence.voltage.positive.rms': 119.842,
    'sequence.voltage.negative.rms': 0.431,
    'sequence.voltage.zero.rms': 0.208,
    'sequence.current.positive.rms': 8.612,
    'sequence.current.negative.rms': 0.126,
    'sequence.current.zero.rms': 0.074,
    'unbalance.voltage': 0.36,
    'unbalance.current': 1.463,
    'unbalance.voltage.zero': 0.174,
    'unbalance.current.zero': 0.859,
  }
  const unit = units[key] ?? (key.startsWith('unbalance.') ? '%'
    : key.startsWith('sequence.current.') ? 'A' : 'V')
  return {
    key, unit,
    valid: true, value: values[key] ?? (key === 'power.reactive.total' ? -5 : 120),
    quality: 'valid', source_sequence: sequence,
  }
}

function record(sequence: number, generation: number, complete: boolean): MeterReadings {
  const attributes = [
    'voltage.ll.ab.rms', 'voltage.ll.bc.rms', 'voltage.ll.ca.rms',
    'power.active.total', 'power.reactive.total', 'power.apparent.total',
    'power.factor.total', 'unbalance.voltage', 'unbalance.current',
    'unbalance.voltage.zero', 'unbalance.current.zero',
    'sequence.voltage.positive.rms', 'sequence.voltage.negative.rms',
    'sequence.voltage.zero.rms', 'sequence.current.positive.rms',
    'sequence.current.negative.rms', 'sequence.current.zero.rms',
  ].map((key) => reading(key, sequence))
  return {
    sequence,
    configuration_generation: generation,
    sample_rate_hz: 32_000,
    block_sample_count: 3_200,
    status: 0,
    capture_frames: 1,
    header_errors: 0,
    fifo_overflows: 0,
    emit_drops: 0,
    result_drops: 0,
    frequency: {
      enabled: true, valid: true, reference_valid: true, out_of_range: false,
      timed_out: false, arithmetic_error: false, hz: 50, millihz: 50_000,
      period_q16_samples: 0, measurement_sequence: sequence, mode: 0,
      reference_channel: 0, cycles_used: 10,
    },
    channels: [], attributes, record_complete: complete,
    timing: {
      block_sequence: sequence, first_sample_index: 0, sample_count: 3_200,
      cycle_count: 10, nominal_frequency_hz: 50, cycle_locked: true,
      free_run_fallback: false, time_quality: 'synchronized',
      utc_start_nanoseconds: Date.UTC(2026, 7, 28, 12, 3, 20, 200) * 1_000_000,
      utc_uncertainty_nanoseconds: 250_000,
    },
  }
}

function displayedSequence() {
  return screen.getByText('Record sequence').closest('div')?.querySelector('dd')
}

describe('Reading page coherent record behavior', () => {
  it('retains an incomplete same-generation update and clears it on generation change', () => {
    const { rerender } = render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(displayedSequence()).toHaveTextContent('41')
    expect(screen.getByText('Finalized')).toBeInTheDocument()
    expect(screen.getByText('2026-08-28 12:03:20.200 UTC')).toBeInTheDocument()

    rerender(<ReadingPage readings={record(42, 7, false)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(displayedSequence()).toHaveTextContent('41')

    rerender(<ReadingPage readings={record(1, 8, false)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(displayedSequence()).toHaveTextContent('—')
    expect(screen.getByText(/Waiting for 10\/12-cycle finalized data/)).toBeInTheDocument()
  })

  it('exposes the reamped navigation and a keyboard-operable interval control', () => {
    render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(screen.getByRole('button', { name: 'Power' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Phasor & Unbalance' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sequence' })).toBeInTheDocument()
    const interval = screen.getByRole('combobox', { name: 'Measurement interval' })
    interval.focus()
    expect(interval).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Phasor Angle' })).not.toBeInTheDocument()
  })

  it('shows an operator sequence view without inventing unpublished angles', () => {
    const { rerender } = render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sequence' }))

    expect(screen.getByRole('heading', { name: 'Sequence balance' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Star (wye)' })).toBeInTheDocument()
    expect(screen.getByText('Nominal reference: line-to-neutral (L-N)')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Voltage sequence magnitudes' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Current sequence magnitudes' })).toBeInTheDocument()
    expect(screen.getByRole('meter', {
      name: 'V₂ / V₁ negative-sequence ratio',
    })).toHaveAttribute('aria-valuenow', '0.36')
    expect(screen.getByText('Why there is no polar sequence plot')).toBeInTheDocument()
    expect(screen.getByText(/does not reconstruct or invent sequence angles/)).toBeInTheDocument()
    expect(screen.getByText(/Advanced sequence details/).closest('details')).not.toHaveAttribute('open')

    rerender(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="delta" />)
    expect(screen.getByRole('heading', { name: 'Delta' })).toBeInTheDocument()
    expect(screen.getByText('Nominal reference: line-to-line (L-L)')).toBeInTheDocument()
    expect(screen.getByText(/measured line-side residuals/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Phasor & Unbalance' }))
    expect(screen.getByText('Vab')).toBeInTheDocument()
    expect(screen.getByText('Line voltage AB')).toBeInTheDocument()
    expect(screen.getByText('120 V L-L nominal')).toBeInTheDocument()
  })

  it('distinguishes invalid sequence values from unavailable fields', () => {
    const degraded = record(41, 7, true)
    degraded.attributes = degraded.attributes?.flatMap((candidate) => {
      if (candidate.key === 'sequence.current.zero.rms') return []
      if (candidate.key === 'sequence.voltage.negative.rms') return [{
        ...candidate, valid: false, value: Number.NaN, quality: 'invalid' as const,
      }]
      return [candidate]
    })
    render(<ReadingPage readings={degraded} onUnauthorized={() => undefined}
      systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sequence' }))

    expect(screen.getByRole('img', {
      name: 'Negative sequence V₂ invalid',
    })).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Zero sequence I₀ unavailable',
    })).toBeInTheDocument()
    expect(screen.getByText('Invalid values present')).toBeInTheDocument()
  })
})
