import { pageTitle } from "@/lib/i18n/metadata";

// The (overview) route group only exists so /dashboard can have this server layout for its title;
// the URL is unchanged.
export const generateMetadata = pageTitle("nav.overview");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
