import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import { initKeycloak } from "./keycloak";

(async () => {
  // false = không ép login ngay; true = vào app là login luôn
  await initKeycloak(true);
  createApp(App).use(router).mount("#app");
})();
