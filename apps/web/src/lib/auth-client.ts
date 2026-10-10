import { createAuthClient } from "better-auth/react";

const authBaseURL = import.meta.env.VITE_API_BASE_URL;

export const authClient = createAuthClient(
  authBaseURL ? { baseURL: authBaseURL } : {},
);
