import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AuthStatus, AuthUser } from "./types.js";
import {
  createAuthSession,
  deleteAuthSession,
  getAuthSession,
  getAuthUser,
  listAuthUsers,
  setAuthUserPasswordHash,
} from "./db.js";

export const authCookieName = "xiaosongshu_session";
export const authSessionDays = 15;
export const authSessionMaxAgeSeconds = authSessionDays * 24 * 60 * 60;

const builtInUsernames = ["admin", "guest"] as const;
type BuiltInUsername = typeof builtInUsernames[number];

export interface AuthSessionContext {
  user: AuthUser;
  tokenHash: string;
  expiresAt: string;
}

export function isAuthSetupRequired() {
  const users = listAuthUsers();
  return builtInUsernames.some((username) => !users.find((user) => user.username === username)?.passwordHash);
}

export function getPublicAuthStatus(context: AuthSessionContext | null): AuthStatus {
  return {
    authenticated: Boolean(context),
    needsSetup: isAuthSetupRequired(),
    user: context?.user || null,
    expiresAt: context?.expiresAt || null,
  };
}

export function getBuiltInAccountSummaries() {
  return listAuthUsers().map((user) => ({
    username: user.username,
    role: user.role,
    passwordConfigured: Boolean(user.passwordHash),
    passwordUpdatedAt: user.passwordUpdatedAt || null,
  }));
}

export function initializeAuthFromEnvironment() {
  if (!isAuthSetupRequired()) return false;
  const adminPassword = process.env.AUTH_ADMIN_PASSWORD || "";
  const guestPassword = process.env.AUTH_GUEST_PASSWORD || "";
  if (!adminPassword || !guestPassword) return false;
  validatePassword(adminPassword);
  validatePassword(guestPassword);
  setAuthUserPasswordHash("admin", hashPassword(adminPassword));
  setAuthUserPasswordHash("guest", hashPassword(guestPassword));
  return true;
}

export function setupBuiltInAccounts(adminPassword: string, guestPassword: string) {
  if (!isAuthSetupRequired()) throw new Error("账号已经初始化，请使用管理员账号登录后修改密码。");
  validatePassword(adminPassword);
  validatePassword(guestPassword);
  setAuthUserPasswordHash("admin", hashPassword(adminPassword));
  setAuthUserPasswordHash("guest", hashPassword(guestPassword));
}

export function authenticateCredentials(username: string, password: string): AuthUser | null {
  if (!isBuiltInUsername(username)) return null;
  const user = getAuthUser(username);
  if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) return null;
  return { username: user.username, role: user.role };
}

export function createSessionForUser(user: AuthUser) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + authSessionMaxAgeSeconds * 1000).toISOString();
  createAuthSession({
    tokenHash,
    username: user.username,
    expiresAt,
    createdAt: now.toISOString(),
  });
  return { token, expiresAt };
}

export function authenticateSessionToken(token: string | null): AuthSessionContext | null {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = getAuthSession(tokenHash);
  if (!session) return null;
  const user = getAuthUser(session.username);
  if (!user?.passwordHash) {
    deleteAuthSession(tokenHash);
    return null;
  }
  return {
    user: { username: user.username, role: user.role },
    tokenHash,
    expiresAt: session.expiresAt,
  };
}

export function revokeSession(tokenHash: string | null) {
  if (tokenHash) deleteAuthSession(tokenHash);
}

export function resetBuiltInPassword(username: string, password: string) {
  if (!isBuiltInUsername(username)) throw new Error("只支持管理内置账号 admin 和 guest。");
  validatePassword(password);
  setAuthUserPasswordHash(username, hashPassword(password));
}

export function parseCookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null;
  const target = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return target ? decodeURIComponent(target.slice(name.length + 1)) : null;
}

export function buildSessionCookie(token: string, secure: boolean) {
  const attributes = [
    `${authCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${authSessionMaxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function buildExpiredSessionCookie(secure: boolean) {
  const attributes = [
    `${authCookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function validatePassword(password: string) {
  if (password.length < 8) throw new Error("密码至少需要8位。");
  if (password.length > 128) throw new Error("密码不能超过128位。");
}

function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

function verifyPassword(password: string, stored: string) {
  const [algorithm, saltValue, hashValue] = stored.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isBuiltInUsername(username: string): username is BuiltInUsername {
  return builtInUsernames.includes(username as BuiltInUsername);
}
