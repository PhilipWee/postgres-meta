import * as Sentry from '@sentry/node'

const sentryEnvironment = process.env.ENVIRONMENT ?? 'local'
const dsn = process.env.SENTRY_DSN ?? ''

const captureOptions: Sentry.NodeOptions =
  sentryEnvironment === 'prod'
    ? {
        tracesSampleRate: 0.00001,
      }
    : {
        tracesSampleRate: 0.01,
      }

const sensitiveKeys = ['pg', 'x-connection-encrypted']

function redactSensitiveData(data: any) {
  if (data && typeof data === 'object') {
    for (const key of sensitiveKeys) {
      if (key in data) {
        data[key] = '[REDACTED]'
      }
    }
  }
}

export default Sentry.init({
  enabled: Boolean(dsn),
  dsn: dsn,
  environment: sentryEnvironment,
  integrations: [],
  beforeSendTransaction(transaction) {
    if (transaction.contexts?.trace?.data) {
      redactSensitiveData(transaction.contexts.trace.data)
    }
    return transaction
  },
  beforeSendSpan(span) {
    if (span.data) {
      redactSensitiveData(span.data)
    }
    return span
  },
  ...captureOptions,
})
