import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedWaveform, WaveformPyramid } from './waveformFile'
import type { WorkerResponse } from './waveformWorker'
import { processWaveform } from './waveformWorkerClient'

const waveform: ParsedWaveform = {
  version: 5,
  sessionId: 0n,
  firstSequence: 1n,
  lastSequence: 1n,
  triggerSequence: 1n,
  triggerTaiNanoseconds: 0n,
  triggerRealtimeNanoseconds: 0n,
  sampleRateHz: 128_000,
  decimation: 1,
  effectiveSampleRateHz: 128_000,
  frameCount: 1,
  frameBytes: 4,
  frameDataOffset: 0,
  channels: [],
  events: [],
  timebaseSegments: [],
  data: new DataView(new ArrayBuffer(4)),
}

const pyramid: WaveformPyramid = {
  samples: new Int32Array([7]),
  levels: [{
    granularity: 32,
    minima: new Int32Array([7]),
    maxima: new Int32Array([7]),
    entryCount: 1,
  }],
}

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted?: { message: { buffer: ArrayBuffer }; transfer: Transferable[] }
  terminated = false

  constructor(readonly url: URL, readonly options: WorkerOptions) {
    FakeWorker.instances.push(this)
  }

  postMessage(message: { buffer: ArrayBuffer }, transfer: Transferable[]) {
    this.posted = { message, transfer }
    queueMicrotask(() => this.onmessage?.({
      data: { waveform, pyramid },
    } as MessageEvent<WorkerResponse>))
  }

  terminate() {
    this.terminated = true
  }
}

afterEach(() => {
  FakeWorker.instances = []
  vi.unstubAllGlobals()
})

describe('waveform worker client', () => {
  it('transfers parsing and pyramid construction to a module worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    // Deliberately not a valid MNCWF buffer: parsing this on the caller would fail.
    const input = new ArrayBuffer(3)

    await expect(processWaveform(input)).resolves.toEqual({ waveform, pyramid })

    const worker = FakeWorker.instances[0]
    expect(worker.options).toMatchObject({
      type: 'module',
      name: 'msap1-waveform-processor',
    })
    expect(worker.posted?.message.buffer).toBe(input)
    expect(worker.posted?.transfer).toEqual([input])
    expect(worker.terminated).toBe(true)
  })
})
