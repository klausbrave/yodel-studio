import { initChimera } from "../src/wasm/chimera";
import "./analytics";
try {
  await initChimera();
  await import("./studio");
} catch (error) {
  const msg = document.querySelector<HTMLElement>("#error")!;
  msg.hidden = false;
  msg.textContent = "The voice could not load. Reload the page to try again. " + String(error);
  document.querySelector("#play span")!.textContent = "Voice unavailable";
}
