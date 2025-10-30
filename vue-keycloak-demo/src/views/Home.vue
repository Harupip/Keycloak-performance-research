<script setup lang="ts">
import { keycloak } from '../keycloak';

function login() {
  keycloak.login();
}

function logout() {
  keycloak.logout({ redirectUri: window.location.origin });
}

const isAuth = () => !!keycloak.authenticated;
const username = () => keycloak?.tokenParsed?.preferred_username;
</script>

<template>
  <div>
    <h1>Home</h1>
    <p v-if="isAuth()">Xin chào, {{ username() }}</p>
    <button v-if="!isAuth()" @click="login">Login</button>
    <button v-else @click="logout">Logout</button>
  </div>
</template>
