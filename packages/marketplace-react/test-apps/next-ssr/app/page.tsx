import { ListingGrid } from "./listing-grid";
import { MoneyModal } from "./money-modal";

// The 30-line app the A1 Done-when requires: provider (in layout) + one hook
// (useListings, inside ListingGrid) + one component (ListingGrid). Server
// component shell; the grid is the only client island.
//
// The MoneyModal island additionally server-renders the actual shipped money
// surface (HireButton + an OPEN HireCheckoutModal) so check-ssr proves the
// funded checkout SSRs without throwing (finding #6).
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1>AgenC marketplace listings</h1>
      <p>Rendered by @tetsuo-ai/marketplace-react under Next.js 15 App Router.</p>
      <ListingGrid />
      <MoneyModal />
    </main>
  );
}
