import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const loadProfile = (__ENV.LOAD_PROFILE || 'steady').toLowerCase();

const defaultTimeUnit = '1m';
const rateEnv = __ENV.REQUEST_RATE ?? __ENV.REQUESTS_PER_MINUTE;
const parsedRate = Number(rateEnv);
const requestsPerUnit = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 10;

const timeUnitRaw = (__ENV.TIME_UNIT || defaultTimeUnit).toLowerCase();

function toSeconds(value) {
  const match = /^(\d+)(s|m|h)$/i.exec(value.trim());
  if (!match) {
    throw new Error(`TIME_UNIT "${value}" is invalid. Use formats such as 30s, 1m, 5m, 1h.`);
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
          tags: { test: 'keycloak-login-refresh' },
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
          tags: { test: 'keycloak-login-refresh', profile: 'steady' },
        },
      };

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    keycloak_refresh_failed: ['rate<0.05'],
    keycloak_refresh_duration: ['p(95)<1000'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost';
const realm = __ENV.REALM || 'master';
const directNodeUrl = __ENV.DIRECT_NODE_URL || __ENV.DIRECT_NODE_BASE_URL || '';

const clientId = __ENV.CLIENT_ID || 'admin-cli';
const clientSecret = __ENV.CLIENT_SECRET || '';
const username = __ENV.USERNAME || 'admin';
const password = __ENV.PASSWORD || 'admin';

const loginSleepSeconds = Number(__ENV.LOGIN_SLEEP_SECONDS || 5);
const refreshSleepSeconds = Number(__ENV.REFRESH_SLEEP_SECONDS || 2);

const refreshDuration = new Trend('keycloak_refresh_duration', true);
const refreshFailed = new Rate('keycloak_refresh_failed');

const formHeaders = {
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
};

function encodeForm(data) {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

function loginAgainst(url) {
  const payload = {
    grant_type: 'password',
    client_id: clientId,
    username,
    password,
  };
  if (clientSecret) {
    payload.client_secret = clientSecret;
  }

  const response = http.post(`${url}/realms/${realm}/protocol/openid-connect/token`, encodeForm(payload), formHeaders);

  check(response, {
    'login status is 200': (res) => res.status === 200,
    'login issued refresh token': (res) => !!res.json('refresh_token'),
  });

  if (response.status !== 200) {
    throw new Error(`Login failed with status ${response.status}`);
  }

  return {
    accessToken: response.json('access_token'),
    refreshToken: response.json('refresh_token'),
  };
}

function refreshToken(refreshTokenValue) {
  const payload = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshTokenValue,
  };
  if (clientSecret) {
    payload.client_secret = clientSecret;
  }

  return http.post(
    `${baseUrl}/realms/${realm}/protocol/openid-connect/token`,
    encodeForm(payload),
    formHeaders,
  );
}

const vuState = {};

export function setup() {
  // Optional warm-up login before test starts.
  if (directNodeUrl) {
    loginAgainst(directNodeUrl);
    sleep(loginSleepSeconds);
  }
}

export default function () {
  if (!vuState[__VU]) {
    const loginTarget = directNodeUrl || baseUrl;
    vuState[__VU] = loginAgainst(loginTarget);
    sleep(loginSleepSeconds);
  }

  const state = vuState[__VU];
  const start = Date.now();
  const response = refreshToken(state.refreshToken);
  const duration = Date.now() - start;

  const success = check(response, {
    'refresh status is 200': (res) => res.status === 200,
    'refresh returned access token': (res) => !!res.json('access_token'),
  });

  refreshDuration.add(duration);
  refreshFailed.add(success ? 0 : 1);

  if (success) {
    state.accessToken = response.json('access_token');
    const newRefresh = response.json('refresh_token');
    if (newRefresh) {
      state.refreshToken = newRefresh;
    }

    const userinfo = http.get(
      `${baseUrl}/realms/${realm}/protocol/openid-connect/userinfo`,
      {
        headers: { Authorization: `Bearer ${state.accessToken}` },
        tags: { endpoint: 'userinfo' },
      },
    );

    check(userinfo, {
      'userinfo is 200': (res) => res.status === 200,
    });
  } else {
    console.warn(`Refresh failed with status ${response.status} (VU ${__VU})`);
    vuState[__VU] = loginAgainst(directNodeUrl || baseUrl);
  }

  sleep(refreshSleepSeconds);
}
