import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.BASE_URL || "http://127.0.0.1:8791";
const targetMint = __ENV.TARGET_MINT || "3H87g2Zd3T4TNfpnxHqN6e83xp8Avip1tx8Xv3j1pump";
const jsonHeaders = { "Content-Type": "application/json" };

export const options = {
  scenarios: {
    state_smoke: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "15s",
      preAllocatedVUs: 5
    },
    scan_stress: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "15s", target: 6 },
        { duration: "5s", target: 0 }
      ],
      gracefulRampDown: "2s",
      exec: "scanFlow"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<3000"]
  }
};

export default function stateFlow() {
  const response = http.get(`${baseUrl}/api/state`);
  check(response, {
    "state status 200": (r) => r.status === 200,
    "state json ok": (r) => r.json("ok") === true
  });
  sleep(0.2);
}

export function scanFlow() {
  const response = http.post(
    `${baseUrl}/api/scan`,
    JSON.stringify({ mint: targetMint }),
    { headers: jsonHeaders }
  );

  check(response, {
    "scan status 200 or 409": (r) => r.status === 200 || r.status === 409,
    "scan response parseable": (r) => {
      try {
        return typeof r.json("ok") === "boolean";
      } catch {
        return false;
      }
    }
  });
  sleep(0.5);
}
