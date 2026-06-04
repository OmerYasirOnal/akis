import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // CAP the worker pool: the integration tests spawn real servers/child processes, and a
    // worker that still holds an open handle lingers after the run — uncapped (one fork per
    // core) that leaked ~20 zombie workers at 1.7-4.4GB each across repeated full-suite runs
    // (observed live: 36GB swap, machine choking). 4 forks bound both a run's peak memory
    // and the blast radius of any leak; suite wall-time impact is small.
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 4 } }, // min too — the default min (cores) conflicts with the cap
  },
})
