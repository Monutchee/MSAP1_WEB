import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneratedFiles } from './GeneratedFiles'

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200,
    headers: { 'Content-Type': 'application/json' } })
}

describe('GeneratedFiles', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps viewer access viewer-only and exposes delivery detail safely', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/v1/data-logging/artifacts?'))
        return json({ offset: 0, returned: 1, artifacts: [{
          id: 'artifact-1', job_id: 'job-1', job_revision: 4,
          filename: 'artifact-1.json', mime_type: 'application/json',
          sha256: 'a'.repeat(64), size_bytes: 123,
          source_start_nanoseconds: 1_700_000_000_000_000_000,
          source_end_nanoseconds: 1_700_000_300_000_000_000,
          generated_at_nanoseconds: 1_700_000_330_000_000_000,
          created_at_nanoseconds: 1_700_000_330_000_000_000,
          state: 'blocked', local_only: false, payload_present: true,
          delivery_count: 1, succeeded_count: 0, blocked_count: 1,
          recovery_error: '',
        }] })
      if (url === '/api/v1/data-logging/artifacts/preview?id=artifact-1&limit=16384')
        return new Response('{"schema":"mnc.meter.datalog.v1"}\n', { status: 200,
          headers: { 'Content-Type': 'text/plain' } })
      if (url === '/api/v1/data-logging/artifact?id=artifact-1')
        return json({ artifact: {}, deliveries: [{ channel_id: 'office-sftp',
          state: 'blocked', attempt_count: 2, next_attempt_nanoseconds: 0,
          last_attempt_nanoseconds: 100, remote_result: '',
          last_error: 'host key verification failed' }] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<GeneratedFiles onUnauthorized={() => undefined} canDelete={false} />)
    expect(await screen.findByText('artifact-1.json')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url) === '/api/v1/data-logging/configuration')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('host key verification failed')).toBeInTheDocument()
    expect(screen.getByText('blocked · 2 attempts')).toBeInTheDocument()
  })
})
