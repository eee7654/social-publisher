export const JOB_STATUS = {
  PENDING: 'pending', // Initial insert state
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  RETRY_WAIT: 'retry_wait',
  FAILED: 'failed',
  AUTH_REQUIRED: 'auth_required',
  RECONCILE_REQUIRED: 'reconcile_required',
};

export const ATTEMPT_STATUS = {
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

export const ERROR_CATEGORY = {
  TRANSIENT_NETWORK: 'TRANSIENT_NETWORK',
  PLATFORM_5XX: 'PLATFORM_5XX',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  VALIDATION: 'VALIDATION',
  PERMANENT: 'PERMANENT',
  AMBIGUOUS_EXTERNAL_STATE: 'AMBIGUOUS_EXTERNAL_STATE',
  TARGET_NOT_READY: 'TARGET_NOT_READY',
};

export const OUTBOX_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  DISPATCHED: 'dispatched',
  FAILED: 'failed',
};
