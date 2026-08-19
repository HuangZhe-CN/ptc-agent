import { parentPort, workerData } from 'node:worker_threads'
import { runBootstrap } from './bootstrap'
import type { WorkerBootData } from './protocol'

if (parentPort) {
  void runBootstrap(parentPort, workerData as WorkerBootData, { stdout: process.stdout, stderr: process.stderr })
}
