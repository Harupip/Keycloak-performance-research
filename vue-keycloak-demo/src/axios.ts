import axios from "axios";
import { keycloak } from "./keycloak";

export const api = axios.create({
  baseURL: "http://localhost:8080/api", // đổi theo backend của bạn
});

api.interceptors.request.use((config) => {
  if (keycloak.token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${keycloak.token}`;
  }
  return config;
});
