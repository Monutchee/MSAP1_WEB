import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  WaveformExportCapability, WaveformExportJob,
} from '../api'
import {
  clearWaveformExportSession, useWaveformExport, WaveformExportProvider,
} from './WaveformExportController'

const eventId = '12345678-1234-5234-9234-1234567890ab'

const capabilities: WaveformExportCapability[] = [
  {
    format: 'mncwf', label: 'MNCWF', profile: 'MNCWF v4/v5',
    extension: '.mncwf', scopes: ['capture', 'event'], asynchronous: false,
  },
  {
    format: 'comtrade', label: 'COMTRADE CFF',
    profile: 'IEC 60255-24:2013 CFF/BINARY32', extension: '.cff',
    scopes: ['capture', 'event'], asynchronous: true,
  },
  {
    format: 'comtrade-zip', label: 'Legacy COMTRADE ZIP',
    profile: 'IEC 60255-24:2013 CFG/DAT ZIP (BINARY32)', extension: '.zip',
    scopes: ['capture', 'event'], asynchronous: true,
  },
  {
    format: 'pqdif', label: 'PQDIF',
    profile: 'IEEE 1159.3-2025 PQDIF', extension: '.pqd',
    scopes: ['capture', 'event'], asynchronous: true,
  },
]

function job(state: WaveformExportJob['state'], id = 'job-1'): WaveformExportJob {
  return {
    job_id: id,
    state,
    session_id: '42',
    source_filename: 'waveform-42.mncwf',
    scope: 'capture',
    event_id: null,
    format: 'comtrade-zip',
    profile: 'IEC 60255-24:2013 CFG/DAT ZIP (BINARY32)',
    queue_position: state === 'queued' ? 2 : 0,
    processed_frames: state === 'running' ? 50 : state === 'ready' ? 100 : 0,
    total_frames: 100,
    filename: state === 'ready' ? 'waveform-42.zip' : '',
    bytes: state === 'ready' ? 4096 : 0,
    sha256: state === 'ready' ? 'a'.repeat(64) : '',
    created_at: '2099-09-04T12:00:00.000000000Z',
    started_at: state === 'queued' ? '' : '2099-09-04T12:00:01.000000000Z',
    completed_at: state === 'ready' ? '2099-09-04T12:00:02.000000000Z' : '',
    expires_at: state === 'ready' ? '2099-09-04T12:30:02.000000000Z' : '',
    // Deliberately hostile: the controller must construct a same-origin URL.
    download_url: 'https://untrusted.example/export',
    error_code: '', error_message: '', missing_fields: [],
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

function Harness({ scope = 'capture' }: { scope?: 'capture' | 'event' }) {
  const { openExport } = useWaveformExport()
  return <button type="button" onClick={() => openExport({
    sessionId: 42,
    filename: 'waveform-42.mncwf',
    scope,
    ...(scope === 'event' ? { eventId } : {}),
    capabilities,
  })}>Open export</button>
}

function renderController(scope: 'capture' | 'event' = 'capture', owner = 'admin') {
  const unauthorized = vi.fn()
  const view = render(<WaveformExportProvider owner={owner}
    onUnauthorized={unauthorized}><Harness scope={scope} /></WaveformExportProvider>)
  return { ...view, unauthorized }
}

afterEach(() => {
  clearWaveformExportSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Waveform export controller', () => {
  it('keeps MNCWF immediate and scopes an exact event download', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    renderController('event')
    fireEvent.click(screen.getByRole('button', { name: 'Open export' }))
    expect(screen.getByRole('radio', { name: /MNCWF/ })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe(
      `/api/v1/waveforms/export?session_id=42&event_id=${eventId}&format=mncwf`)
  })

  it('submits the legacy ZIP, runs in the background, and downloads once', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    let finishStatus: ((response: Response) => void) | undefined
    const status = new Promise<Response>((resolve) => { finishStatus = resolve })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/waveform-exports' && init?.method === 'POST')
        return json(job('queued'), 202)
      if (url === '/api/v1/waveform-exports?job_id=job-1') return status
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderController()
    fireEvent.click(screen.getByRole('button', { name: 'Open export' }))
    fireEvent.click(screen.getByRole('radio', { name: /Legacy COMTRADE ZIP/ }))
    expect(screen.getByText(/separate .cfg and .dat/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    expect(await screen.findAllByText(/Queued · position 2/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Run in background' }))
    finishStatus?.(json(job('ready')))

    expect(await screen.findByRole('heading', { name: 'waveform-42.zip' }))
      .toBeInTheDocument()
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe(
      '/api/v1/waveform-exports/download?job_id=job-1')
    expect(anchor.download).toBe('waveform-42.zip')
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect(click).toHaveBeenCalledOnce()

    const submit = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(submit?.[1]?.body))).toEqual({
      session_id: 42, scope: 'capture', format: 'comtrade-zip',
    })
    expect(sessionStorage.getItem('msap1.waveform-export-jobs.v1'))
      .toContain('job-1')
    expect(screen.getAllByRole('button', { name: 'Download again' }))
      .toHaveLength(2)
  })

  it('restores an active job after reload and resumes polling', async () => {
    sessionStorage.setItem('msap1.waveform-export-jobs.v1', JSON.stringify({
      owner: 'admin', jobs: [job('running')], autoDownloaded: [],
    }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => json(job('ready'))))

    renderController()
    expect(await screen.findByText('Ready · 4.0 KiB')).toBeInTheDocument()
    expect(click).toHaveBeenCalledOnce()
  })

  it('cancels a running conversion through the owner-scoped API', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/waveform-exports' && init?.method === 'POST')
        return json(job('running'))
      if (url.endsWith('job_id=job-1') && init?.method === 'DELETE')
        return json(job('cancelled'))
      if (url.endsWith('job_id=job-1')) return json(job('running'))
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderController()
    fireEvent.click(screen.getByRole('button', { name: 'Open export' }))
    fireEvent.click(screen.getByRole('radio', { name: /PQDIF/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    const heading = await screen.findByRole('heading', {
      name: 'Preparing waveform export',
    })
    const dialog = heading.closest('[role="dialog"]')
    expect(dialog).not.toBeNull()
    fireEvent.click(within(dialog as HTMLElement).getByRole('button', {
      name: 'Cancel',
    }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/waveform-exports?job_id=job-1',
      expect.objectContaining({ method: 'DELETE' }),
    ))
  })

  it('discards a ready artifact through the owner-scoped API', async () => {
    sessionStorage.setItem('msap1.waveform-export-jobs.v1', JSON.stringify({
      owner: 'admin', jobs: [job('ready')], autoDownloaded: ['job-1'],
    }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE')
      return json(job('cancelled'))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderController()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/waveform-exports?job_id=job-1',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    expect(screen.queryByLabelText('Waveform exports')).not.toBeInTheDocument()
  })

  it('does not restore an expired ready artifact', async () => {
    sessionStorage.setItem('msap1.waveform-export-jobs.v1', JSON.stringify({
      owner: 'admin', jobs: [{
        ...job('ready'), expires_at: '2000-01-01T00:00:00.000000000Z',
      }], autoDownloaded: [],
    }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    renderController()
    await waitFor(() => expect(screen.queryByLabelText('Waveform exports'))
      .not.toBeInTheDocument())
    expect(click).not.toHaveBeenCalled()
  })

  it('queues multiple completion dialogs in completion order', async () => {
    const second = {
      ...job('ready', 'job-2'), filename: 'waveform-43.pqd',
      completed_at: '2099-09-04T12:00:03.000000000Z',
    }
    sessionStorage.setItem('msap1.waveform-export-jobs.v1', JSON.stringify({
      owner: 'admin', jobs: [second, job('ready')], autoDownloaded: [],
    }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    renderController()
    expect(await screen.findByRole('heading', { name: 'waveform-42.zip' }))
      .toBeInTheDocument()
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('heading', { name: 'waveform-43.pqd' }))
      .toBeInTheDocument()
  })

  it('drops restored jobs belonging to a different user', () => {
    sessionStorage.setItem('msap1.waveform-export-jobs.v1', JSON.stringify({
      owner: 'other-user', jobs: [job('ready')], autoDownloaded: [],
    }))
    renderController('capture', 'admin')
    expect(screen.queryByLabelText('Waveform exports')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('msap1.waveform-export-jobs.v1'))
      .toContain('"owner":"admin"')
  })
})
