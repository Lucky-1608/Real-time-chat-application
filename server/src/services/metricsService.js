import client from 'prom-client';

export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'pulsechat_' });

export const activeSocketsGauge = new client.Gauge({
  name: 'chat_active_sockets',
  help: 'Number of currently connected Socket.io clients',
  registers: [register],
});

export const socketEventsCounter = new client.Counter({
  name: 'chat_socket_events_total',
  help: 'Total Socket.io events received by event name',
  labelNames: ['event'],
  registers: [register],
});

export const messageSendHistogram = new client.Histogram({
  name: 'chat_message_send_duration_seconds',
  help: 'Latency of message:send persistence and broadcast',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const authFailuresCounter = new client.Counter({
  name: 'chat_auth_failures_total',
  help: 'Total failed authentication attempts',
  labelNames: ['reason'],
  registers: [register],
});

export const rateLimitHitsCounter = new client.Counter({
  name: 'chat_rate_limit_hits_total',
  help: 'Total HTTP/Socket rate limit rejections',
  labelNames: ['scope'],
  registers: [register],
});

export const refreshReuseCounter = new client.Counter({
  name: 'chat_refresh_reuse_total',
  help: 'Total detected refresh token reuse incidents',
  registers: [register],
});

export const scanResultsCounter = new client.Counter({
  name: 'chat_scan_results_total',
  help: 'Upload malware scan outcomes',
  labelNames: ['status'],
  registers: [register],
});

export const schedulerLagGauge = new client.Gauge({
  name: 'chat_scheduler_lag_seconds',
  help: 'Lag in seconds between scheduled sendAt and actual execution',
  registers: [register],
});

export const httpDurationHistogram = new client.Histogram({
  name: 'chat_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});
