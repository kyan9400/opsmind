import { PREVIEW } from "./preview";

// Inlined at build time. It mirrors the API's ALLOW_REGISTRATION (on unless "false"), the way NEXT_PUBLIC_SANDBOX
// mirrors ALLOW_SANDBOX, so a deployment with sign-up closed offers no form that can only fail. The static
// preview has no server to sign up on.
const registration = process.env.NEXT_PUBLIC_REGISTRATION?.trim().toLowerCase();
export const registrationEnabled = !PREVIEW && registration !== "false" && registration !== "0";
