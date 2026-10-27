/**
 * Host half of the biomimetic memory bundle.
 *
 * Responsibilities:
 *  - open the single-file memory store and keep it warm;
 *  - register the model-facing tools (`memory_ingest`, `memory_recall`,
 *    `memory_consolidate`, `memory_profile`, `memory_notes`);
 *  - inject the Tier-0 core memories as prompt context;
 *  - serve the Web panel's JSON route;
 *  - run the background batch-consolidation / daily-maintenance sweep.
 */

import { createEngine } from './lib/engine.js'
import { FETCH_PATH, ROUTE_PATH, createMemoryFetch, createMemoryRoute } from './lib/http.js'
import { registerTools } from './lib/tools.js'

export const name = '@local/dsh-biomimetic-memory'

// The tools registry is required; every other service is optional so the
// bundle also loads in headless compositions.
export const inject = ['tools']

const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export function apply(ctx, config = {}) {
  const engine = createEngine(config || {})

  ctx.effect(() => () => {
    void engine.close().catch(() => {})
  })

  const disposeTools = registerTools(ctx, engine, config || {})
  ctx.effect(() => disposeTools)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() =>
      systemPrompt.context({
        // After the Harness' own runtime contexts (100-210): stable text, late
        // in the prompt, so the long prefix above it stays cache-friendly.
        name: 'biomimetic-memory',
        order: 300,
        text: () => engine.promptContextSync(),
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    const handler = createMemoryRoute(engine)
    ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }))
  }

  const connection = ctx.get('connection')
  if (connection?.fetch?.register) {
    try {
      const fetchHandler = createMemoryFetch(engine)
      ctx.effect(() =>
        connection.fetch.register({
          path: FETCH_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: fetchHandler,
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.('biomimetic-memory: authenticated API route unavailable', error)
    }
  }

  const timer = ctx.get('timer')
  if (timer) {
    ctx.effect(() =>
      timer.interval(() => {
        void engine
          .backgroundSweep()
          .then((result) => {
            if (result?.consolidated?.length || result?.maintenance) {
              ctx.logger?.debug?.('biomimetic-memory sweep', result)
            }
          })
          .catch((error) => {
            ctx.logger?.warn?.('biomimetic-memory sweep failed', error)
          })
      }, SWEEP_INTERVAL_MS),
    )
  }

  // Open the store eagerly so the first prompt and the panel are populated.
  void engine.ensureReady().catch((error) => {
    ctx.logger?.warn?.('biomimetic-memory store failed to open', error)
  })
}
