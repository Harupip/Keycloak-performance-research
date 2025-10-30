import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Allow switching between a gentle, steady arrival rate and the original ramp test.
const loadProfile = (__ENV.LOAD_PROFILE || 'steady').toLowerCase();

const defaultTimeUnit = '1m';
const rateEnv = __ENV.REQUEST_RATE ?? __ENV.REQUESTS_PER_MINUTE;
const parsedRate = Number(rateEnv);
const requestsPerUnit = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 6;

const timeUnitRaw = (__ENV.TIME_UNIT || defaultTimeUnit).toLowerCase();

function toSeconds(value) {
  const match = /^(\d+)(s|m|h)$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `TIME_UNIT "${value}" is invalid. Use formats such as 30s, 1m, 5m, 1h.`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return amount;
  if (unit === 'm') return amount * 60;
  return amount * 3600;
}

const timeUnitSeconds = toSeconds(timeUnitRaw);
const requestsPerSecond = requestsPerUnit / timeUnitSeconds;

const testDuration = __ENV.DURATION || '5m';

const parsedPreAllocated = Number(__ENV.PREALLOCATED_VUS);
const preAllocatedVUs =
  Number.isFinite(parsedPreAllocated) && parsedPreAllocated > 0
    ? parsedPreAllocated
    : Math.max(1, Math.ceil(requestsPerSecond * 2));

const parsedMax = Number(__ENV.MAX_VUS);
const maxVUs =
  Number.isFinite(parsedMax) && parsedMax >= preAllocatedVUs
    ? parsedMax
    : Math.max(preAllocatedVUs, Math.ceil(requestsPerSecond * 4));

const scenarios =
  loadProfile === 'ramp'
    ? {
        ramping_load: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '30s', target: 10 },
            { duration: '60s', target: 30 },
            { duration: '30s', target: 0 },
          ],
          gracefulRampDown: '10s',
          tags: { test: 'keycloak-openid' },
        },
      }
    : {
        steady_rate: {
          executor: 'constant-arrival-rate',
          rate: requestsPerUnit,
          timeUnit: timeUnitRaw,
          duration: testDuration,
          preAllocatedVUs: preAllocatedVUs,
          maxVUs: maxVUs,
          tags: { test: 'keycloak-openid', profile: 'steady' },
        },
      };

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<800'],
    keycloak_upstream_hits: ['count>0'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost';
const realm = __ENV.REALM || 'master';
const targetUrl = `${baseUrl}/realms/${realm}/.well-known/openid-configuration`;
const pauseSeconds = Number(__ENV.SLEEP_SECONDS || 1);

const upstreamHits = new Counter('keycloak_upstream_hits');
const upstreamLatency = new Trend('keycloak_upstream_latency', true);

export default function () {
  const res = http.get(targetUrl, {
    redirects: 0,
    headers: { Connection: 'keep-alive' },
    tags: { endpoint: 'openid-configuration' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  const upstream = res.headers['X-Upstream-Server'] || 'unknown';
  upstreamHits.add(1, { upstream });
  upstreamLatency.add(res.timings.duration, { upstream });

  if (res.status >= 500) {
    console.warn(`Received ${res.status} from upstream ${upstream}`);
  }

  sleep(pauseSeconds);
}
