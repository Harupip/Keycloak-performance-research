import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const defaultTimeUnit = "1s";
const timeUnitRaw = (__ENV.TIME_UNIT || defaultTimeUnit).toLowerCase();

function toSeconds(value) {
  const match = /^(\d+)(s|m|h)$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use formats such as 30s, 1m, 5m, 1h.`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  return amount * 3600;
}

function parseRampStages(value) {
  if (!value) {
    return null;
  }

  const stages = value.split(",").map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }

    const match = /^(\d+)(s|m|h)\s*:\s*(\d+)$/i.exec(trimmed);
    if (!match) {
      throw new Error(
        `RAMP_STAGES entry "${trimmed}" is invalid. Expected "<duration><s|m|h>:<target>", e.g. "1m:20".`,
      );
    }

    return {
      duration: `${match[1]}${match[2].toLowerCase()}`,
      target: Number(match[3]),
    };
  });

  if (stages.some((stage) => !stage)) {
    throw new Error("RAMP_STAGES contains an empty entry. Remove consecutive commas.");
  }

  return stages;
}

const rampStages = parseRampStages(__ENV.RAMP_STAGES) || [
  { duration: "30s", target: 300 },
  // { duration: "1m", target: 500 },
  // { duration: "1m", target: 1000 },
  { duration: "30s", target: 1500 },
  { duration: "3m", target: 1500 },
  // { duration: "10s", target: 5000 },
  // { duration: "1m", target: 5000 },
  // { duration: "1m", target: 3000 },
  { duration: "1m", target: 300 },
];

if (rampStages.length === 0) {
  throw new Error("No ramp stages defined. Provide RAMP_STAGES or keep the defaults.");
}

const timeUnitSeconds = toSeconds(timeUnitRaw);
const peakRampRate = rampStages.reduce((max, stage) => Math.max(max, stage.target), 0);

const parsedPreAllocated = Number(__ENV.PREALLOCATED_VUS);
const parsedMax = Number(__ENV.MAX_VUS);

function computeVuConfig(ratePerUnit) {
  const perUnit = Number.isFinite(ratePerUnit) && ratePerUnit > 0 ? ratePerUnit : peakRampRate;
  const ratePerSecond = perUnit / timeUnitSeconds;

  const preAllocated =
    Number.isFinite(parsedPreAllocated) && parsedPreAllocated > 0
      ? parsedPreAllocated
      : Math.max(1, Math.ceil(ratePerSecond * 2));

  const max =
    Number.isFinite(parsedMax) && parsedMax >= preAllocated
      ? parsedMax
      : Math.max(preAllocated, Math.ceil(ratePerSecond * 4));

  return { preAllocatedVUs: preAllocated, maxVUs: max };
}

const rampConfig = computeVuConfig(peakRampRate);

const startRateEnv = Number(__ENV.RAMP_START_RATE);
const defaultStartRate = 200;
const startRate = Number.isFinite(startRateEnv) && startRateEnv >= 0 ? startRateEnv : defaultStartRate;

export const options = {
  scenarios: {
    ramping_openid: {
      executor: "ramping-arrival-rate",
      timeUnit: "1s" || timeUnitRaw,
      startRate,
      stages: rampStages,
      preAllocatedVUs: 2000 || rampConfig.preAllocatedVUs,
      maxVUs: 20000 || rampConfig.maxVUs,
      gracefulStop: __ENV.RAMP_GRACEFUL_STOP || "30s",
      tags: { test: "keycloak-openid", profile: "ramp-only" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<8000"],
    keycloak_upstream_hits: ["count>0"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost";
const realm = __ENV.REALM || "master";
const targetUrl = `${baseUrl}/realms/${realm}/.well-known/openid-configuration`;
const pauseSeconds = Number(__ENV.SLEEP_SECONDS || 0);

const upstreamHits = new Counter("keycloak_upstream_hits");
const upstreamLatency = new Trend("keycloak_upstream_latency", true);

export default function () {
  const res = http.get(targetUrl, {
    redirects: 0,
    headers: { Connection: "keep-alive" },
    tags: { endpoint: "openid-configuration" },
  });

  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  const upstream = res.headers["X-Upstream-Server"] || "unknown";
  upstreamHits.add(1, { upstream });
  upstreamLatency.add(res.timings.duration, { upstream });

  if (res.status >= 500) {
    console.warn(`Received ${res.status} from upstream ${upstream}`);
  }

  if (pauseSeconds > 0) {
    sleep(pauseSeconds);
  }
}

// console.log(
//   JSON.stringify(
//     {
//       timeUnitRaw,
//       startRate,
//       rampStages,
//       preAllocatedVUs: rampConfig?.preAllocatedVUs,
//       maxVUs: rampConfig?.maxVUs,
//     },
//     null,
//     2
//   )




// );