import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataLoggingConfigurationDocument, MeterAttributeCatalog } from '../../api'
import { DataLoggingPage } from './DataLoggingPage'

const configuration: DataLoggingConfigurationDocument = {
  settings: { channels: [], jobs: [], storage: {
    maximum_bytes: 536870912, minimum_free_bytes: 268435456,
    completed_metadata_retention_days: 30,
  } },
  materials: [], demand_window_seconds: 600,
}
const attributes: MeterAttributeCatalog = {
  usage: 'historian', periods: [{ id: 'basic', label: 'Basic 10/12-cycle',
    attributes: ['frequency'] }],
  attributes: [{ id: 'frequency', label: 'Frequency', group: 'frequency', unit: 'Hz',
    value_kind: 'linear', search_aliases: ['hertz'], calculations: ['average', 'last'],
    periods: ['basic'] }],
}
const status = {
  health: 'ready', message: 'Data Sender ready', artifact_count: 0,
  outbox_count: 0, outbox_bytes: 0,
  archive_count: 0, archive_bytes: 0, pending_delivery_count: 0,
  completed_metadata_count: 0, missing_payload_count: 0,
  blocked_delivery_count: 0, maximum_bytes: 536870912, available_bytes: 999999999,
  minimum_free_bytes: 268435456, generation_allowed: true,
  storage_blocking_reason: '', jobs: [], channels: [],
}

function json(value: unknown, statusCode = 200) {
  return new Response(JSON.stringify(value), { status: statusCode,
    headers: { 'Content-Type': 'application/json' } })
}

describe('DataLoggingPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('supports keyboard tabs and never contacts a channel while saving', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(1); return bytes
    } })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/data-logging/configuration' && init?.method === 'PUT')
        return json({ ...configuration, settings: JSON.parse(String(init.body)) })
      if (url === '/api/v1/data-logging/configuration') return json(configuration)
      if (url === '/api/v1/meter/attributes?usage=historian') return json(attributes)
      if (url === '/api/v1/data-logging/status') return json(status)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<DataLoggingPage onUnauthorized={() => undefined} />)
    const jobsTab = await screen.findByRole('tab', { name: 'Logging Jobs' })
    expect(screen.getByText(/No jobs yet/)).toBeInTheDocument()
    fireEvent.keyDown(jobsTab, { key: 'ArrowRight' })
    const channelsTab = screen.getByRole('tab', { name: 'Data Channels' })
    expect(channelsTab).toHaveAttribute('aria-selected', 'true')
    expect(channelsTab).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Add Data Channel' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Protocol' }),
      { target: { value: 'http' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Unencrypted transport')
    expect(screen.getByRole('checkbox', { name: /I understand/ })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Review, validate, and save' }))
    await screen.findByText(/Saved. New schedules take effect/)
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/channels/test'))).toBe(false)
  })

  it('hands a 401 transition back to the application shell', async () => {
    const unauthorized = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/data-logging/configuration')
        return json({ error: 'session expired' }, 401)
      if (url === '/api/v1/meter/attributes?usage=historian') return json(attributes)
      if (url === '/api/v1/data-logging/status') return json(status)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<DataLoggingPage onUnauthorized={unauthorized} />)
    await waitFor(() => expect(unauthorized).toHaveBeenCalled())
  })

  it('announces and focuses a load failure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/data-logging/configuration')
        return json({ error: 'settings service unavailable' }, 503)
      if (url === '/api/v1/meter/attributes?usage=historian') return json(attributes)
      if (url === '/api/v1/data-logging/status') return json(status)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<DataLoggingPage onUnauthorized={() => undefined} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('settings service unavailable')
    await waitFor(() => expect(alert).toHaveFocus())
  })
})
