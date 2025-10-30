import { createRouter, createWebHistory } from "vue-router";
import Home from "../views/Home.vue";
import Profile from "../views/Profile.vue";
import { keycloak } from "../keycloak";

const routes = [
  { path: "/", name: "home", component: Home },
  // Route cần đăng nhập
  {
    path: "/profile",
    name: "profile",
    component: Profile,
    meta: { requiresAuth: true },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Guard: nếu route cần auth mà chưa đăng nhập thì chuyển qua Keycloak
router.beforeEach(async (to, _from, next) => {
  if (to.meta.requiresAuth && !keycloak.authenticated) {
    await keycloak.login({ redirectUri: window.location.origin + to.fullPath });
    return; // login sẽ redirect, không gọi next()
  }
  next();
});

export default router;
