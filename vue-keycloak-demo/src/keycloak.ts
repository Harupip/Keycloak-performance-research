import Keycloak from "keycloak-js";

export const keycloak = new Keycloak({
  url: "http://localhost:8080", // URL Keycloak (không có /auth với bản mới)
  realm: "demo-realm", // tên realm bạn đã tạo
  clientId: "test-client", // Client ID
});

export async function initKeycloak(forceLogin = false) {
  const options = {
    // 'login-required' = vào app là bắt đăng nhập luôn
    // 'check-sso' = kiểm tra đăng nhập, chưa có thì vẫn cho vào (sẽ bảo vệ từng route)
    onLoad: forceLogin ? "login-required" : "check-sso",
    pkceMethod: "S256",
    checkLoginIframe: false,
  } as const;

  const authenticated = await keycloak.init(options);
  // Tự refresh token trước khi hết hạn
  keycloak.onTokenExpired = async () => {
    try {
      await keycloak.updateToken(60);
    } catch {
      await keycloak.login();
    }
  };
  return authenticated;
}
