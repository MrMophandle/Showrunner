import { createRoot } from "react-dom/client";

// A placeholder client until Task 6 writes the real one: it proves the Vite build and the React
// plugin are wired, and nothing else.
const root = document.getElementById("root");
if (root) createRoot(root).render(<main>console</main>);
