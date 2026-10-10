import { pageTitle } from "@/lib/i18n/metadata";

export const generateMetadata = pageTitle("nav.documents");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
