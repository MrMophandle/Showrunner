import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "./console.css";

/** The client's entry point. A browser router rather than a hash one, because the server already
 *  answers any path that is not a file with the client's index (`server/main.ts`), so one show's
 *  run has a url an operator can bookmark and send — `/shows/<key>/episodes/<id>/runs/<runId>`,
 *  which names the show as well as the run because one console holds every show on the machine.
 *
 *  No `StrictMode`: it double-invokes effects in development, which here means two fetches of
 *  every route and an SSE channel opened and closed on every mount — a development behaviour that
 *  differs from production in exactly the part of this client that is hardest to reason about. */
const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}
