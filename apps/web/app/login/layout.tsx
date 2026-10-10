import { registrationEnabled } from "@/lib/flags";
import { pageTitle } from "@/lib/i18n/metadata";

// Without sign-up the page is only a sign-in form, and its tab says so.
export const generateMetadata = pageTitle(registrationEnabled ? "login.metaTitle" : "login.metaTitleSignIn");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
