/**
 * Azure Application Insights connection string for anonymous crash + usage
 * telemetry (see telemetry.ts). Client-side ingestion keys are designed to
 * ship inside client apps: this key can only WRITE telemetry to the
 * "clippyai-app" resource, never read it. The resource has a 0.5 GB/day cap.
 */
export const TELEMETRY_CONNECTION_STRING =
  'InstrumentationKey=694338e6-1472-4b64-96da-debca83a48b3;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=5724b0a7-21c4-486c-ba1e-e90f2d4bc375';
