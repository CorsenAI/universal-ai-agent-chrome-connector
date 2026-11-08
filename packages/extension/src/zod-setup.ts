import * as z from 'zod'

/**
 * Extension pages run under a strict CSP without 'unsafe-eval': Zod must never compile schemas at
 * runtime (its JIT path). The matching dead code is also removed at build time (vite.config.ts).
 * Import this module first.
 */
z.config({ jitless: true })
