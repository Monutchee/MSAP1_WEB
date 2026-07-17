export interface Session {
  username: string
  role: string
}
export interface AcquisitionHealth {
  running: boolean
  frames: number
  bytes: number
  dma_blocks: number
  read_errors: number
}

export interface AdcHealth {
  healthy: boolean
  spi_responsive: boolean
  initialized: boolean
  init_complete: boolean
  configuration_match: boolean
  capture_active: boolean
  fifo_ok: boolean
  headers_valid: boolean
  sample_rate_hz: number
  capture_flags: number
  frames: number
  packets: number
  fifo_overflows: number
  header_errors: number
  alerts: number
  spi_error: number
}

export interface SystemHealth {
  healthy: boolean
  acquisition: AcquisitionHealth
  adc: AdcHealth
  web: { backend_running: boolean; nginx_running: boolean }
}

export interface ChannelMetadata {
  index: number
  name: string
  unit: string
}

export interface AdcMetadata {
  sample_rate_hz: number
  channel_count: number
  frame_size_bytes: number
  ring_capacity_frames: number
  published_sequence: number
  capture_flags: number
  channels: ChannelMetadata[]
}

export interface SampleFrame {
  sequence: number
  values: number[]
}

export interface SamplesResponse {
  capture_rate_hz: number
  display_rate_hz: number
  next_sequence: number
  dropped_frames: number
  frames: SampleFrame[]
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`)
  }
  return payload as T
}

export const api = {
  login: (username: string, password: string) =>
    request<{ status: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ status: string }>('/api/logout', { method: 'POST' }),
  session: () => request<Session>('/api/v1/session'),
  health: () => request<SystemHealth>('/api/v1/health'),
  metadata: () => request<AdcMetadata>('/api/v1/adc/metadata'),
  samples: (after?: number) => {
    const query = new URLSearchParams({ rate_hz: '20', limit: '20' })
    if (after !== undefined) query.set('after', String(after))
    return request<SamplesResponse>(`/api/v1/adc/samples?${query}`)
  },
}
