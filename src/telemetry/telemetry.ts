import { DefaultAzureCredential } from "@azure/identity";
import {
  shutdownAzureMonitor,
  useAzureMonitor,
} from "@azure/monitor-opentelemetry";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export function startTelemetry(serviceName: string): TelemetryHandle {
  const applicationInsightsConnectionString =
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (applicationInsightsConnectionString) {
    useAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString: applicationInsightsConnectionString,
        credential: new DefaultAzureCredential(),
      },
      enableLiveMetrics: true,
    });
    return { shutdown: shutdownAzureMonitor };
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS ??= "true";
  }
  const traceExporter = endpoint
    ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })
    : new ConsoleSpanExporter();
  const metricReader = endpoint
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
        }),
        exportIntervalMillis: 5_000,
      })
    : undefined;

  const sdk = new NodeSDK({
    serviceName,
    traceExporter,
    ...(metricReader === undefined ? {} : { metricReader }),
  });
  sdk.start();
  return sdk;
}