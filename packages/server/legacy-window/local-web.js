// Opens the bar's local web on one of its tabs: /emulator/local-web.html?tab=apps. The local web keeps its current
// tab in the page's storage (the key "tabStore"); this page, at the same address, sets it there and goes on to the
// local web itself. The device window's "App settings" leads here.
const TABS = ["network", "firmware", "settings", "draw-tool", "apps"];
const tab = new URLSearchParams(location.search).get("tab");
if (TABS.includes(tab)) {
  let store = {};
  try {
    const kept = JSON.parse(localStorage.getItem("tabStore"));
    if (kept && typeof kept === "object" && !Array.isArray(kept)) store = kept;
  } catch {
    // Nothing kept, or not what the local web wrote: begun anew.
  }
  try {
    localStorage.setItem("tabStore", JSON.stringify({ showHiddenTabs: false, ...store, currentTab: tab }));
  } catch {
    // Without storage the local web opens on its first tab.
  }
}
location.replace("/");
