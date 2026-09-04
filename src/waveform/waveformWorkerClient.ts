import {
  buildWaveformPyramid,
  parseWaveformAsync,
  type ParsedWaveform,
  type WaveformPyramid,
} from './waveformFile'
import type { WorkerResponse } from './waveformWorker'

export interface ProcessedWaveform {
  waveform: ParsedWaveform
  pyramid: WaveformPyramid
}

/** Transfer parsing, decompression, CRC checks, and pyramid construction off React. */
export async function processWaveform(buffer: ArrayBuffer): Promise<ProcessedWaveform> {
  /* Vitest/jsdom and very old browsers have no Worker implementation. The
   * production Vite bundle always takes the module-worker branch. */
  if (typeof Worker === 'undefined') {
    const waveform = await parseWaveformAsync(buffer)
    return { waveform, pyramid: buildWaveformPyramid(waveform) }
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./waveformWorker.ts', import.meta.url), {
      type: 'module',
      name: 'msap1-waveform-processor',
    })
    const finish = () => worker.terminate()
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      finish()
      const { waveform, pyramid, error } = event.data
      if (error || !waveform || !pyramid) {
        reject(new Error(error || 'Waveform worker returned an incomplete result'))
        return
      }
      resolve({ waveform, pyramid })
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || 'Waveform worker failed'))
    }
    worker.postMessage({ buffer }, [buffer])
  })
}
