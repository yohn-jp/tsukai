export interface RuntimeLimits {
  maxRuns: number;
  maxMetadataEntries: number;
  maxMetadataValueBytes: number;
  maxRecordBytes: number;
  maxQueuedInputBytes: number;
  maxHistoryPerRun: number;
  maxSubscriberQueue: number;
  maxSubscribersPerRun: number;
  maxPageSize: number;
}

export const DEFAULT_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  maxRuns: 1000,
  maxMetadataEntries: 16,
  maxMetadataValueBytes: 256,
  maxRecordBytes: 64 * 1024,
  maxQueuedInputBytes: 256 * 1024,
  maxHistoryPerRun: 2000,
  maxSubscriberQueue: 128,
  maxSubscribersPerRun: 32,
  maxPageSize: 100,
});
