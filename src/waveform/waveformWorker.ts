import {
  buildWaveformPyramid,
  parseWaveformAsync,
  type ParsedWaveform,
  type WaveformPyramid,
} from './waveformFile'

interface WorkerRequest {
  buffer: ArrayBuffer
}

export interface WorkerResponse {
  waveform?: ParsedWaveform
  pyramid?: WaveformPyramid
  error?: string
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer: Transferable[]): void
}

scope.onmessage = (event) => {
  void (async () => {
    try {
      const waveform = await parseWaveformAsync(event.data.buffer)
      const pyramid = buildWaveformPyramid(waveform)
      const buffers = new Set<ArrayBuffer>()
      const include = (value: ArrayBufferLike) => {
        if (value instanceof ArrayBuffer) buffers.add(value)
      }
      include(waveform.data.buffer)
      include(pyramid.samples.buffer)
      pyramid.levels.forEach((level) => {
        include(level.minima.buffer)
        include(level.maxima.buffer)
      })
      scope.postMessage({ waveform, pyramid }, Array.from(buffers))
    } catch (reason) {
      scope.postMessage({
        error: reason instanceof Error ? reason.message : 'Unable to process waveform',
      }, [])
    }
  })()
}
