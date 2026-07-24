// Optional OpenTelemetry bootstrap. When OTEL_EXPORTER_OTLP_ENDPOINT is unset,
// this is a no-op so unit tests stay hermetic.

/**
 * Start OTLP tracing when configured. Failures are logged to stderr and do not
 * crash the process — telemetry must never block serving traffic.
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || endpoint.length === 0) return;

  void (async () => {
    try {
      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { getNodeAutoInstrumentations } = await import(
        '@opentelemetry/auto-instrumentations-node'
      );
      const { OTLPTraceExporter } = await import(
        '@opentelemetry/exporter-trace-otlp-http'
      );

      const sdk = new NodeSDK({
        traceExporter: new OTLPTraceExporter({
          url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
        }),
        instrumentations: [getNodeAutoInstrumentations()],
      });
      await sdk.start();

      const shutdown = async () => {
        try {
          await sdk.shutdown();
        } catch {
          // ignore
        }
      };
      process.once('SIGTERM', () => {
        void shutdown();
      });
      process.once('SIGINT', () => {
        void shutdown();
      });
    } catch (err) {
      console.error('[telemetry] failed to start OpenTelemetry SDK', err);
    }
  })();
}
