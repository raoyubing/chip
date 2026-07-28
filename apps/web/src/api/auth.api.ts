import type { AuthRole, AuthStatus } from "../types";
import { request } from "./client";

export interface AuthAccountSummary {
  username: "admin" | "guest";
  role: AuthRole;
  passwordConfigured: boolean;
  passwordUpdatedAt: string | null;
}

export const authApi = {
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (username: "admin" | "guest", password: string) => request<AuthStatus>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  }),
  setupAccounts: (adminPassword: string, guestPassword: string) => request<AuthStatus>("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ adminPassword, guestPassword }),
  }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  authUsers: () => request<{ users: AuthAccountSummary[] }>("/api/auth/users"),
  updateAuthPassword: (username: "admin" | "guest", password: string) => request<{
    ok: true;
    requiresRelogin: boolean;
    users: AuthAccountSummary[];
  }>(`/api/auth/users/${username}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  }),
};
